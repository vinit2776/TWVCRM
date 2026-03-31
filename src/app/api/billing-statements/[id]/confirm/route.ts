import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { resend, EMAIL_FROM, EMAIL_REPLY_TO } from "@/lib/mailer";
import { generateGstInvoicePDF, type GstInvoiceData } from "@/lib/gst-invoice-generator";
import { COMPANY_BANK_DETAILS } from "@/lib/constants";
import { logAudit } from "@/lib/audit";
import { messaging, dltSms } from "@/lib/whatsapp";

/**
 * POST /api/billing-statements/[id]/confirm
 * Finalizes a draft billing statement:
 *  1. Generate GST invoice number
 *  2. Generate GST invoice PDF
 *  3. Upload PDF to Supabase storage
 *  4. Create Razorpay payment link
 *  5. Email invoice to customer + CC accounts/managers
 *  6. SMS/WhatsApp notification
 *  7. Update contract.next_billing_date
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser || !["admin", "manager", "accounts"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Only admin, manager, or accounts can confirm invoices" }, { status: 403 });
  }

  const adminSupabase = await createAdminClient();

  // Fetch the statement with related data
  const { data: statement, error: fetchErr } = await adminSupabase
    .from("billing_statements")
    .select(`
      *,
      contract:contracts!billing_statements_contract_id_fkey(
        id, contract_number, title, total_amount, subtotal, tax_percentage,
        start_date, end_date, next_billing_date, billing_cycle, location_id,
        items,
        lead:leads!contracts_lead_id_fkey(id, first_name, last_name, company, email, phone, state, gst_number, mobile)
      ),
      usage_charges:usage_charges(id, description, quantity, unit_price, total)
    `)
    .eq("id", id)
    .single();

  if (fetchErr || !statement) {
    return NextResponse.json({ error: "Statement not found" }, { status: 404 });
  }

  if (statement.status !== "draft") {
    return NextResponse.json({ error: `Statement is already ${statement.status}` }, { status: 400 });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const contract = statement.contract as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const lead = contract?.lead as any;

  if (!contract) {
    return NextResponse.json({ error: "No contract linked to this statement" }, { status: 400 });
  }

  // 1. Generate GST invoice number (based on count of existing invoices this FY)
  const fyStart = new Date().getMonth() >= 3 ? new Date().getFullYear() : new Date().getFullYear() - 1;
  const fyEnd = fyStart + 1;
  const fyPrefix = `TWV/INV/${String(fyStart).slice(-2)}-${String(fyEnd).slice(-2)}/`;

  const { count: existingCount } = await adminSupabase
    .from("billing_statements")
    .select("id", { count: "exact", head: true })
    .like("gst_invoice_number", `${fyPrefix}%`);

  const seqNum = (existingCount || 0) + 1;
  const invoiceNumber = `${fyPrefix}${String(seqNum).padStart(4, "0")}`;

  // 2. Recalculate totals from linked charges
  const usageCharges = (statement.usage_charges || []) as { description: string; quantity: number; unit_price: number; total: number }[];
  const usageAmount = usageCharges.reduce((s, c) => s + Number(c.total || 0), 0);
  const fixedAmount = Number(statement.fixed_amount || 0);
  const subtotal = fixedAmount + usageAmount;
  const taxPercentage = Number(statement.tax_percentage || 18);

  const buyerState = (lead?.state || "").toLowerCase().trim();
  const isInterstate = buyerState !== "" && buyerState !== "tamil nadu" && buyerState !== "tn";

  let cgst = 0, sgst = 0, igst = 0;
  if (isInterstate) {
    igst = Math.round(subtotal * (taxPercentage / 100) * 100) / 100;
  } else {
    cgst = Math.round(subtotal * (taxPercentage / 200) * 100) / 100;
    sgst = Math.round(subtotal * (taxPercentage / 200) * 100) / 100;
  }
  const taxAmount = cgst + sgst + igst;
  const totalAmount = subtotal + taxAmount;

  // 3. Fetch UPI QR code base64 for PDF
  let qrCodeBase64: string | undefined;
  let upiId: string | undefined;
  try {
    const { data: settings } = await adminSupabase
      .from("app_settings")
      .select("key, value")
      .in("key", ["upi_id", "upi_qr_code_path"]);

    const settingsMap: Record<string, string> = {};
    (settings || []).forEach((s) => { settingsMap[s.key] = s.value; });
    upiId = settingsMap.upi_id;

    if (settingsMap.upi_qr_code_path) {
      const { data: fileData } = await adminSupabase.storage
        .from("crm-documents")
        .download(settingsMap.upi_qr_code_path);
      if (fileData) {
        const ab = await fileData.arrayBuffer();
        const base64 = Buffer.from(ab).toString("base64");
        const mime = settingsMap.upi_qr_code_path.endsWith(".png") ? "image/png" : "image/jpeg";
        qrCodeBase64 = `data:${mime};base64,${base64}`;
      }
    }
  } catch { /* continue without QR */ }

  // 4. Create Razorpay payment link (if enabled)
  let razorpayLinkId: string | undefined;
  let razorpayLinkUrl: string | undefined;
  try {
    const { data: rzpSettings } = await adminSupabase
      .from("app_settings")
      .select("key, value")
      .in("key", ["razorpay_enabled", "razorpay_key_id", "razorpay_key_secret"]);

    const rzpMap: Record<string, string> = {};
    (rzpSettings || []).forEach((s) => { rzpMap[s.key] = s.value; });

    if (rzpMap.razorpay_enabled === "true" && rzpMap.razorpay_key_id && rzpMap.razorpay_key_secret) {
      const auth = Buffer.from(`${rzpMap.razorpay_key_id}:${rzpMap.razorpay_key_secret}`).toString("base64");
      const appUrl = (process.env.NEXT_PUBLIC_APP_URL || "https://twv-crm.vercel.app").trim();
      const customerName = lead ? `${lead.first_name || ""} ${lead.last_name || ""}`.trim() : "Customer";
      const customerEmail = lead?.email;
      const customerPhone = lead?.phone || lead?.mobile;

      const payload: Record<string, unknown> = {
        amount: Math.round(totalAmount * 100), // paise
        currency: "INR",
        description: `Invoice ${invoiceNumber} — ${contract.contract_number} — The WorkVilla`,
        reference_id: invoiceNumber.replace(/\//g, "-"),
        expire_by: Math.floor(Date.now() / 1000) + 15 * 24 * 60 * 60, // 15 days
        notify: { sms: !!customerPhone, email: !!customerEmail },
        reminder_enable: true,
        notes: { statement_id: id, contract_number: contract.contract_number, invoice_number: invoiceNumber },
        callback_url: `${appUrl}/billing`,
        callback_method: "get",
      };

      if (customerName || customerEmail || customerPhone) {
        payload.customer = {};
        if (customerName) (payload.customer as Record<string, string>).name = customerName;
        if (customerEmail) (payload.customer as Record<string, string>).email = customerEmail;
        if (customerPhone) (payload.customer as Record<string, string>).contact = customerPhone.replace(/\s/g, "");
      }

      const rzpRes = await fetch("https://api.razorpay.com/v1/payment_links", {
        method: "POST",
        headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (rzpRes.ok) {
        const linkData = await rzpRes.json();
        razorpayLinkId = linkData.id;
        razorpayLinkUrl = linkData.short_url;
      }
    }
  } catch (err) {
    console.error("[billing confirm] Razorpay link creation failed:", err);
  }

  // 5. Build line items for PDF
  const lineItems: GstInvoiceData["lineItems"] = [];

  // Fixed amount (workspace fee)
  if (fixedAmount > 0) {
    lineItems.push({
      description: contract.title || `Workspace — ${contract.contract_number}`,
      hsnSac: "997212",
      qty: 1,
      rate: fixedAmount,
      amount: fixedAmount,
    });
  }

  // Usage charges
  for (const charge of usageCharges) {
    lineItems.push({
      description: charge.description,
      hsnSac: "997212",
      qty: Number(charge.quantity || 1),
      rate: Number(charge.unit_price),
      amount: Number(charge.total),
    });
  }

  // 6. Generate GST invoice PDF
  const invoiceData: GstInvoiceData = {
    invoiceNumber,
    invoiceDate: new Date().toISOString().slice(0, 10),
    buyerName: lead?.company || `${lead?.first_name || ""} ${lead?.last_name || ""}`.trim() || "Customer",
    buyerGstin: lead?.gst_number || undefined,
    buyerState: lead?.state || undefined,
    periodStart: statement.period_start,
    periodEnd: statement.period_end,
    contractNumber: contract.contract_number,
    lineItems,
    subtotal,
    cgst,
    sgst,
    igst,
    totalAmount,
    isInterstate,
    taxPercentage,
    razorpayUrl: razorpayLinkUrl,
    qrCodeBase64,
    upiId,
  };

  const doc = generateGstInvoicePDF(invoiceData);
  const pdfBuffer = Buffer.from(doc.output("arraybuffer"));

  // 7. Upload PDF to Supabase storage
  const storagePath = `invoices/${invoiceNumber.replace(/\//g, "-")}.pdf`;
  const { error: uploadErr } = await adminSupabase.storage
    .from("crm-documents")
    .upload(storagePath, pdfBuffer, { contentType: "application/pdf", upsert: true });

  if (uploadErr) {
    console.error("[billing confirm] PDF upload failed:", uploadErr);
  }

  // 8. Update billing statement
  const now = new Date().toISOString();
  await adminSupabase
    .from("billing_statements")
    .update({
      status: "finalized",
      finalized_at: now,
      gst_invoice_number: invoiceNumber,
      gst_invoice_path: uploadErr ? null : storagePath,
      subtotal,
      usage_amount: usageAmount,
      tax_amount: taxAmount,
      total_amount: totalAmount,
      cgst_amount: cgst,
      sgst_amount: sgst,
      igst_amount: igst,
      is_interstate: isInterstate,
      buyer_gstin: lead?.gst_number || null,
      razorpay_payment_link_id: razorpayLinkId || null,
      razorpay_payment_link_url: razorpayLinkUrl || null,
    })
    .eq("id", id);

  // 9. Email to customer + CC accounts/managers
  const customerEmail = lead?.email;
  const customerName = lead ? `${lead.first_name || ""} ${lead.last_name || ""}`.trim() : "Customer";
  const periodLabel = `${new Date(statement.period_start + "T00:00:00").toLocaleDateString("en-IN", { month: "short", year: "numeric" })}`;

  // Get CC recipients
  const { data: ccUsers } = await adminSupabase
    .from("users")
    .select("email")
    .in("role", ["admin", "manager", "accounts"])
    .eq("is_active", true);
  const ccEmails = (ccUsers || []).map((u) => u.email).filter(Boolean);

  const emailRecipients = customerEmail ? [customerEmail] : [];

  if (emailRecipients.length > 0 || ccEmails.length > 0) {
    const paymentOptionsHtml = `
      <h3 style="color:#015E65;font-size:14px;margin:20px 0 10px;">Payment Options</h3>
      <table style="width:100%;border-collapse:collapse;font-size:13px;">
        <tr><td style="padding:4px 0;color:#666;">Bank Transfer</td><td style="padding:4px 0;">${COMPANY_BANK_DETAILS.accountName}<br/>${COMPANY_BANK_DETAILS.bank}, ${COMPANY_BANK_DETAILS.branch}<br/>A/C: ${COMPANY_BANK_DETAILS.accountNumber} | IFSC: ${COMPANY_BANK_DETAILS.ifscCode}</td></tr>
        ${upiId ? `<tr><td style="padding:4px 0;color:#666;">UPI</td><td style="padding:4px 0;">${upiId}</td></tr>` : ""}
        ${razorpayLinkUrl ? `<tr><td style="padding:4px 0;color:#666;">Pay Online</td><td style="padding:4px 0;"><a href="${razorpayLinkUrl}" style="color:#015E65;font-weight:bold;">${razorpayLinkUrl}</a></td></tr>` : ""}
      </table>
    `;

    const emailHtml = `
      <div style="font-family:sans-serif;max-width:640px;margin:0 auto;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
        <div style="background:#015E65;padding:24px 32px;">
          <h1 style="color:white;margin:0;font-size:20px;">The WorkVilla</h1>
          <p style="color:#00AE6C;margin:4px 0 0;font-size:12px;">Tax Invoice</p>
        </div>
        <div style="padding:32px;">
          <p style="color:#333;font-size:14px;">Dear ${customerName},</p>
          <p style="color:#333;font-size:14px;">Please find attached your tax invoice for <strong>${periodLabel}</strong>.</p>
          <table style="width:100%;border-collapse:collapse;margin:16px 0;font-size:13px;">
            <tr><td style="padding:6px 0;color:#666;">Invoice No.</td><td style="padding:6px 0;font-weight:600;">${invoiceNumber}</td></tr>
            <tr><td style="padding:6px 0;color:#666;">Contract</td><td style="padding:6px 0;">${contract.contract_number}</td></tr>
            <tr><td style="padding:6px 0;color:#666;">Amount</td><td style="padding:6px 0;font-weight:600;color:#015E65;font-size:16px;">Rs. ${totalAmount.toLocaleString("en-IN", { minimumFractionDigits: 2 })}</td></tr>
          </table>
          ${paymentOptionsHtml}
          ${razorpayLinkUrl ? `
          <div style="text-align:center;margin:24px 0;">
            <a href="${razorpayLinkUrl}" style="background:#015E65;color:white;padding:12px 32px;text-decoration:none;border-radius:8px;font-weight:bold;display:inline-block;font-size:14px;">Pay Now</a>
          </div>` : ""}
          <p style="color:#333;font-size:14px;margin-top:24px;">Warm regards,<br/><strong>The WorkVilla</strong></p>
        </div>
        <div style="background:#015E65;padding:12px 32px;text-align:center;">
          <p style="color:#fff;margin:0;font-size:10px;">SREE DESIGN INFRASTRUCTURE PVT LTD</p>
          <p style="color:rgba(255,255,255,0.6);margin:4px 0 0;font-size:9px;">Prakash Presidium, 110, MG Road, Nungambakkam, Chennai - 600034 | GSTIN: 33AAACU4245J1ZF</p>
        </div>
      </div>
    `;

    const attachments = storagePath && !uploadErr
      ? [{ filename: `${invoiceNumber.replace(/\//g, "-")}.pdf`, content: pdfBuffer, contentType: "application/pdf" as const }]
      : undefined;

    // Send to customer
    if (emailRecipients.length > 0) {
      try {
        // Send to customer + CC accounts/managers (combined in to: array)
        const allRecipients = [...emailRecipients, ...ccEmails].filter(Boolean);
        await resend.emails.send({
          from: EMAIL_FROM,
          replyTo: EMAIL_REPLY_TO,
          to: allRecipients,
          subject: `Invoice ${invoiceNumber} — ${contract.contract_number} — The WorkVilla`,
          html: emailHtml,
          attachments,
        });

        await adminSupabase
          .from("billing_statements")
          .update({ emailed_at: now, emailed_to: [...emailRecipients, ...ccEmails].join(", ") })
          .eq("id", id);
      } catch (err) {
        console.error("[billing confirm] Email failed:", err);
      }
    }
  }

  // 10. SMS/WhatsApp notification
  const customerPhone = lead?.phone || lead?.mobile;
  if (customerPhone) {
    const amountStr = String(Math.round(totalAmount));
    messaging.billingStatementReady(
      customerPhone,
      customerName,
      invoiceNumber,
      amountStr,
      id
    ).catch(console.error);

    dltSms.paymentReminder(
      customerPhone,
      customerName,
      amountStr,
      id
    ).catch(console.error);
  }

  // 11. Update contract.next_billing_date
  if (contract.next_billing_date) {
    const nextDate = new Date(contract.next_billing_date + "T00:00:00Z");
    nextDate.setMonth(nextDate.getMonth() + 1);
    await adminSupabase
      .from("contracts")
      .update({ next_billing_date: nextDate.toISOString().slice(0, 10) })
      .eq("id", contract.id);
  }

  // 12. Audit log
  logAudit(adminSupabase, {
    entityType: "billing_statement",
    entityId: id,
    action: "update",
    performedBy: dbUser.id,
    changes: {
      status: { old: "draft", new: "finalized" },
      gst_invoice_number: { old: null, new: invoiceNumber },
      total_amount: { old: statement.total_amount, new: totalAmount },
    },
  });

  return NextResponse.json({
    success: true,
    invoiceNumber,
    totalAmount,
    razorpayLinkUrl: razorpayLinkUrl || null,
    emailedTo: customerEmail || null,
  });
}

export const maxDuration = 30;
