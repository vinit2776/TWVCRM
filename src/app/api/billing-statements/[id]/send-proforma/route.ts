import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { resend, EMAIL_FROM, EMAIL_REPLY_TO } from "@/lib/mailer";
import { generateGstInvoicePDF, type GstInvoiceData } from "@/lib/gst-invoice-generator";
import { COMPANY_BANK_DETAILS } from "@/lib/constants";
import { logAudit } from "@/lib/audit";
import QRCode from "qrcode";

export const maxDuration = 30;

/**
 * POST /api/billing-statements/[id]/send-proforma
 *
 * Sends a proforma invoice + Razorpay payment link to the customer.
 * Called on finalized statements BEFORE payment is received.
 * The GST invoice is only generated after payment — see generate-gst-invoice route.
 *
 * Steps:
 *  1. Build proforma PDF (isProforma=true, no GST invoice number)
 *  2. Create Razorpay payment link
 *  3. Email proforma + payment link to customer
 *  4. Mark proforma_sent_at, store Razorpay link on statement
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  const adminSupabase = await createAdminClient();

  // Internal cron calls use x-internal-secret + skipAuth flag — no session needed
  const isInternalCall = body.skipAuth === true && request.headers.get("x-internal-secret") === process.env.CRON_SECRET;
  let dbUserId: string | null = null;

  if (!isInternalCall) {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { data: dbUser } = await supabase
      .from("users").select("id, role").eq("auth_id", user.id).single();
    if (!dbUser || !["admin", "manager", "accounts"].includes(dbUser.role)) {
      return NextResponse.json({ error: "Only admin, manager, or accounts can send proforma invoices" }, { status: 403 });
    }
    dbUserId = dbUser.id;
  }

  const { data: statement, error: fetchErr } = await adminSupabase
    .from("billing_statements")
    .select(`
      *,
      contract:contracts!billing_statements_contract_id_fkey(
        id, contract_number, title, total_amount, subtotal, tax_percentage,
        start_date, end_date, next_billing_date, billing_cycle, location_id, items,
        lead:leads!contracts_lead_id_fkey(id, first_name, last_name, company, email, phone, state, gst_number, mobile)
      ),
      usage_charges:usage_charges(id, description, quantity, unit_price, total)
    `)
    .eq("id", id)
    .single();

  if (fetchErr || !statement) {
    return NextResponse.json({ error: "Statement not found" }, { status: 404 });
  }

  if (statement.status === "draft") {
    return NextResponse.json({ error: "Finalize the statement before sending a proforma" }, { status: 400 });
  }
  if (statement.status === "voided") {
    return NextResponse.json({ error: "Statement is voided" }, { status: 400 });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const contract = statement.contract as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const lead = contract?.lead as any;

  if (!contract) {
    return NextResponse.json({ error: "No contract linked to this statement" }, { status: 400 });
  }

  // Recalculate totals (same as confirm route)
  const usageCharges = (statement.usage_charges || []) as { description: string; quantity: number; unit_price: number; total: number }[];
  const usageAmount = usageCharges.reduce((s, c) => s + Number(c.total || 0), 0);
  const fixedAmount = Number(statement.fixed_amount || 0);
  const serviceUsageAmount = Number(statement.service_usage_amount || 0);
  const bookingUsageAmount = Number(statement.booking_usage_amount || 0);
  const subtotal = fixedAmount + usageAmount + serviceUsageAmount + bookingUsageAmount;
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

  // Fetch UPI ID (text only — no QR)
  let upiId: string | undefined;
  try {
    const { data: settings } = await adminSupabase.from("app_settings").select("key, value").eq("key", "upi_id");
    const settingsMap: Record<string, string> = {};
    (settings || []).forEach((s) => { settingsMap[s.key] = s.value; });
    upiId = settingsMap.upi_id;
  } catch { /* continue */ }

  // Create or reuse Razorpay payment link
  // On resend, keep the existing link rather than creating a duplicate
  let razorpayLinkId: string | null = (statement.razorpay_payment_link_id as string | null) || null;
  let razorpayLinkUrl: string | null = (statement.razorpay_payment_link_url as string | null) || null;

  if (!razorpayLinkId) {
    try {
      const { data: rzpSettings } = await adminSupabase
        .from("app_settings").select("key, value").in("key", ["razorpay_enabled", "razorpay_key_id", "razorpay_key_secret"]);
      const rzpMap: Record<string, string> = {};
      (rzpSettings || []).forEach((s) => { rzpMap[s.key] = s.value; });

      if (rzpMap.razorpay_enabled === "true" && rzpMap.razorpay_key_id && rzpMap.razorpay_key_secret) {
        const auth = Buffer.from(`${rzpMap.razorpay_key_id}:${rzpMap.razorpay_key_secret}`).toString("base64");
        const appUrl = (process.env.NEXT_PUBLIC_APP_URL || "https://twv-crm.vercel.app").trim();
        const customerName = lead ? `${lead.first_name || ""} ${lead.last_name || ""}`.trim() : "Customer";
        const customerEmail = lead?.email;
        const customerPhone = lead?.phone || lead?.mobile;

        // Unique per-statement reference (no timestamp — Razorpay deduplicates on reference_id)
        const refId = `${statement.statement_number}-proforma`.replace(/[^a-zA-Z0-9_-]/g, "-");

        const payload: Record<string, unknown> = {
          amount: Math.round(totalAmount * 100),
          currency: "INR",
          description: `Proforma ${statement.statement_number} — ${contract.contract_number} — The WorkVilla`,
          reference_id: refId,
          expire_by: Math.floor(Date.now() / 1000) + 15 * 24 * 60 * 60,
          notify: { sms: !!customerPhone, email: !!customerEmail },
          reminder_enable: true,
          notes: { statement_id: id, contract_number: contract.contract_number, proforma: "true" },
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
        } else {
          // If duplicate reference_id, fetch the existing link from Razorpay
          const errBody = await rzpRes.json().catch(() => ({})) as { error?: { description?: string } };
          if (errBody?.error?.description?.includes("already exists")) {
            const fetchRes = await fetch(`https://api.razorpay.com/v1/payment_links?reference_id=${refId}`, {
              headers: { Authorization: `Basic ${auth}` },
            });
            if (fetchRes.ok) {
              const fetchData = await fetchRes.json() as { items?: Array<{ id: string; short_url: string }> };
              const existing = fetchData?.items?.[0];
              if (existing) { razorpayLinkId = existing.id; razorpayLinkUrl = existing.short_url; }
            }
          } else {
            console.error("[send-proforma] Razorpay link failed:", JSON.stringify(errBody));
          }
        }
      }
    } catch (err) {
      console.error("[send-proforma] Razorpay error:", err);
    }
  }

  // Build line items for PDF
  const lineItems: GstInvoiceData["lineItems"] = [];
  const structuredSections = (statement.line_items || []) as Array<{ type: string; label: string; items: Record<string, unknown>[]; subtotal: number }>;

  if (structuredSections.length > 0) {
    for (const section of structuredSections) {
      for (const item of section.items) {
        const desc = item.description || item.booking_number || section.label;
        let label = String(desc);
        if (section.type === "booking_usage" && item.date) {
          label = [String(item.date), item.space ? String(item.space) : "", item.time ? String(item.time) : "", item.duration ? String(item.duration) : ""].filter(Boolean).join(" · ");
        }
        lineItems.push({
          description: label || section.label,
          hsnSac: "997212",
          qty: Number(item.quantity || item.billable || 1),
          rate: Number(item.unit_price || item.rate || item.amount || 0),
          amount: Number(item.amount || 0),
        });
      }
    }
  } else {
    if (fixedAmount > 0) {
      lineItems.push({ description: contract.title || `Workspace — ${contract.contract_number}`, hsnSac: "997212", qty: 1, rate: fixedAmount, amount: fixedAmount });
    }
    for (const charge of usageCharges) {
      lineItems.push({ description: charge.description, hsnSac: "997212", qty: Number(charge.quantity || 1), rate: Number(charge.unit_price), amount: Number(charge.total) });
    }
  }

  // Generate proforma PDF (isProforma = true — no GST invoice number, labeled "PROFORMA INVOICE")
  const proformaRef = statement.statement_number; // use statement number as proforma reference

  // Generate QR code for payment link
  let razorpayQrBase64: string | undefined;
  const linkExpiry = new Date(Date.now() + 15 * 24 * 60 * 60 * 1000);
  const razorpayExpiry = linkExpiry.toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric" });
  if (razorpayLinkUrl) {
    try {
      razorpayQrBase64 = await QRCode.toDataURL(razorpayLinkUrl, { width: 200, margin: 1, errorCorrectionLevel: "M" });
    } catch { /* skip QR if generation fails */ }
  }

  const invoiceData: GstInvoiceData = {
    invoiceNumber: proformaRef,
    invoiceDate: new Date().toISOString().slice(0, 10),
    isProforma: true,
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
    razorpayUrl: razorpayLinkUrl ?? undefined,
    razorpayQrBase64,
    razorpayExpiry: razorpayLinkUrl ? razorpayExpiry : undefined,
  };

  const doc = generateGstInvoicePDF(invoiceData);
  const pdfBuffer = Buffer.from(doc.output("arraybuffer"));

  // Upload proforma PDF to storage
  const storagePath = `proforma/${proformaRef.replace(/\//g, "-")}.pdf`;
  await adminSupabase.storage.from("crm-documents").upload(storagePath, pdfBuffer, { contentType: "application/pdf", upsert: true });

  // Email to customer
  const customerEmail = lead?.email;
  const customerName = lead ? `${lead.first_name || ""} ${lead.last_name || ""}`.trim() : "Customer";
  const periodLabel = new Date(statement.period_start + "T00:00:00").toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", month: "short", year: "numeric" });

  const { data: ccUsers } = await adminSupabase.from("users").select("email").in("role", ["admin", "accounts"]).eq("is_active", true);
  const ccEmails = (ccUsers || []).map((u) => u.email).filter(Boolean);
  const additionalCc: string[] = Array.isArray(body.cc) ? (body.cc as string[]).filter(Boolean) : [];

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
        <p style="color:#00AE6C;margin:4px 0 0;font-size:12px;">Proforma Invoice</p>
      </div>
      <div style="padding:32px;">
        <p style="color:#333;font-size:14px;">Dear ${customerName},</p>
        <p style="color:#333;font-size:14px;">Please find attached your proforma invoice for <strong>${periodLabel}</strong>. Kindly make the payment at your earliest convenience.</p>
        <div style="background:#fff8e1;border:1px solid #ffe082;border-radius:6px;padding:10px 16px;margin:16px 0;font-size:12px;color:#5d4037;">
          ⚠️ This is a proforma invoice for payment purposes only. A formal GST tax invoice will be issued once payment is confirmed.
        </div>
        <table style="width:100%;border-collapse:collapse;margin:16px 0;font-size:13px;">
          <tr><td style="padding:6px 0;color:#666;">Proforma Ref</td><td style="padding:6px 0;font-weight:600;">${proformaRef}</td></tr>
          <tr><td style="padding:6px 0;color:#666;">Contract</td><td style="padding:6px 0;">${contract.contract_number}</td></tr>
          <tr><td style="padding:6px 0;color:#666;">Period</td><td style="padding:6px 0;">${periodLabel}</td></tr>
          <tr><td style="padding:6px 0;color:#666;">Amount Due</td><td style="padding:6px 0;font-weight:600;color:#015E65;font-size:16px;">Rs. ${totalAmount.toLocaleString("en-IN", { minimumFractionDigits: 2 })}</td></tr>
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

  const now = new Date().toISOString();

  let emailedSuccessfully = false;
  if (customerEmail) {
    try {
      const allTo = [customerEmail];
      const allCc = [...ccEmails, ...additionalCc].filter(Boolean);
      await resend.emails.send({
        from: EMAIL_FROM,
        replyTo: EMAIL_REPLY_TO,
        to: allTo,
        cc: allCc.length > 0 ? allCc : undefined,
        subject: `Proforma Invoice ${proformaRef} — ${contract.contract_number} — The WorkVilla`,
        html: emailHtml,
        attachments: [{ filename: `Proforma-${proformaRef.replace(/\//g, "-")}.pdf`, content: pdfBuffer, contentType: "application/pdf" }],
      });
      emailedSuccessfully = true;
    } catch (err) {
      console.error("[send-proforma] Email failed:", err);
    }
  }

  // Update statement — only write Razorpay link columns if we actually have values
  const updatePayload: Record<string, unknown> = {
    proforma_sent_at: now,
    subtotal,
    usage_amount: usageAmount,
    tax_amount: taxAmount,
    total_amount: totalAmount,
    cgst_amount: cgst,
    sgst_amount: sgst,
    igst_amount: igst,
    is_interstate: isInterstate,
    buyer_gstin: lead?.gst_number || null,
  };
  if (dbUserId) updatePayload.proforma_sent_by = dbUserId;
  if (razorpayLinkId) updatePayload.razorpay_payment_link_id = razorpayLinkId;
  if (razorpayLinkUrl) updatePayload.razorpay_payment_link_url = razorpayLinkUrl;

  await adminSupabase.from("billing_statements").update(updatePayload).eq("id", id);

  if (dbUserId) {
    logAudit(adminSupabase, {
      entityType: "billing_statement",
      entityId: id,
      action: "update",
      performedBy: dbUserId,
      changes: {
        proforma_sent_at: { old: null, new: now },
        razorpay_payment_link_url: { old: null, new: razorpayLinkUrl || null },
        emailed_to: { old: null, new: customerEmail || null },
      },
    });
  }

  return NextResponse.json({
    success: true,
    proformaRef,
    totalAmount,
    razorpayLinkUrl: razorpayLinkUrl || null,
    emailedTo: emailedSuccessfully ? customerEmail : null,
    emailSkipped: !customerEmail,
  });
}
