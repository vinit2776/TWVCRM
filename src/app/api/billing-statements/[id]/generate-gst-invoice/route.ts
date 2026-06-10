import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { resend, EMAIL_FROM, EMAIL_REPLY_TO } from "@/lib/mailer";
import { generateGstInvoicePDF, type GstInvoiceData } from "@/lib/gst-invoice-generator";
import { COMPANY_BANK_DETAILS } from "@/lib/constants";
import { logAudit } from "@/lib/audit";
import { routeGstGenerationToTally, isCrmGstEnabled } from "@/lib/tally/enqueue";
import { resolveHsnCode } from "@/lib/e-invoice/sac-codes";

export const maxDuration = 30;

/**
 * POST /api/billing-statements/[id]/generate-gst-invoice
 *
 * Generates and sends the official GST tax invoice after payment is confirmed.
 * Called:
 *  - Automatically by the Razorpay webhook after online payment (no auth needed — called server-to-server)
 *  - Manually by accounts/admin after recording an offline payment
 *
 * If called with { skipAuth: true } in the body it bypasses session auth (webhook use).
 * If called from the browser, normal session auth + role check applies.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  const adminSupabase = await createAdminClient();

  // Auth: skip for internal webhook calls (skipAuth + secret header), else require session
  const isInternalCall = body.skipAuth === true && request.headers.get("x-internal-secret") === process.env.CRON_SECRET;
  let dbUserId: string | null = null;

  if (!isInternalCall) {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
    if (!dbUser || !["admin", "manager", "accounts"].includes(dbUser.role)) {
      return NextResponse.json({ error: "Only admin, manager, or accounts can generate GST invoices" }, { status: 403 });
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
        lead:leads!contracts_lead_id_fkey(id, first_name, last_name, company, email, phone, state, gst_number, mobile, street, city, zip_code)
      ),
      usage_charges:usage_charges(id, description, quantity, unit_price, total)
    `)
    .eq("id", id)
    .single();

  if (fetchErr || !statement) {
    return NextResponse.json({ error: "Statement not found" }, { status: 404 });
  }

  if (statement.gst_invoice_number) {
    return NextResponse.json({ error: "GST invoice already generated", invoiceNumber: statement.gst_invoice_number }, { status: 409 });
  }
  if (statement.status === "draft") {
    return NextResponse.json({ error: "Statement must be finalized first" }, { status: 400 });
  }
  if (statement.status === "voided") {
    return NextResponse.json({ error: "Statement is voided" }, { status: 400 });
  }
  // Payment must be fully received before a tax invoice can be issued.
  // (The Razorpay webhook always sets payment_status = "paid" before calling
  //  this endpoint, so the webhook path is unaffected by this check.)
  if (statement.payment_status !== "paid") {
    return NextResponse.json(
      { error: "GST invoice can only be generated after full payment is received. Record the payment first." },
      { status: 400 }
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const contract = statement.contract as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const lead = contract?.lead as any;

  if (!contract) {
    return NextResponse.json({ error: "No contract linked to this statement" }, { status: 400 });
  }

  // ── Tally routing gate (surgical swap point #2: PI → GST after payment) ────
  // When Tally GST issuance is active, hand the invoice to Tally instead of
  // minting a CRM number + emailing here. The bridge mints the number and
  // dispatchTallyInvoice (ack path) sends the PDF. Returning here means the
  // webhook / manual trigger does NOT double-issue.
  if (await routeGstGenerationToTally(id)) {
    return NextResponse.json({
      success: true,
      routedToTally: true,
      invoiceNumber: null,   // assigned by Tally, mirrored back on ack
      totalAmount: 0,
      emailedTo: null,
      emailSkipped: true,    // delivery deferred to dispatchTallyInvoice
    });
  }

  // ── Standby gate: CRM GST off → payment recorded, invoice deferred ─────────
  if (!(await isCrmGstEnabled(adminSupabase))) {
    return NextResponse.json({
      success: true,
      standby: true,
      invoiceNumber: null,
      message: "GST invoice generation is on standby. Activate CRM GST or Tally Sync from Admin → Tally Sync.",
    });
  }

  // Generate sequential GST invoice number
  const fyStart = new Date().getMonth() >= 3 ? new Date().getFullYear() : new Date().getFullYear() - 1;
  const fyEnd = fyStart + 1;
  const fyPrefix = `TWV/INV/${String(fyStart).slice(-2)}-${String(fyEnd).slice(-2)}/`;

  const { count: existingCount } = await adminSupabase
    .from("billing_statements")
    .select("id", { count: "exact", head: true })
    .like("gst_invoice_number", `${fyPrefix}%`);

  const seqNum = (existingCount || 0) + 1;
  const invoiceNumber = `${fyPrefix}${String(seqNum).padStart(4, "0")}`;

  // Recalculate totals
  const usageCharges = (statement.usage_charges || []) as { description: string; quantity: number; unit_price: number; total: number }[];
  const usageAmount = usageCharges.reduce((s, c) => s + Number(c.total || 0), 0);
  const fixedAmount = Number(statement.fixed_amount || 0);
  const serviceUsageAmount = Number(statement.service_usage_amount || 0);
  const bookingUsageAmount = Number(statement.booking_usage_amount || 0);
  const subtotal = fixedAmount + usageAmount + serviceUsageAmount + bookingUsageAmount;
  const taxPercentage = Number(statement.tax_percentage || 18);

  // Place of supply is always Tamil Nadu — service rendered at TWV premises (always CGST+SGST)
  const isInterstate = false;
  const igst = 0;
  const cgst = Math.round(subtotal * (taxPercentage / 200) * 100) / 100;
  const sgst = Math.round(subtotal * (taxPercentage / 200) * 100) / 100;
  const taxAmount = cgst + sgst + igst;
  const totalAmount = subtotal + taxAmount;

  // Fetch UPI ID for PDF
  let upiId: string | undefined;
  try {
    const { data: settings } = await adminSupabase.from("app_settings").select("key, value").eq("key", "upi_id");
    const settingsMap: Record<string, string> = {};
    (settings || []).forEach((s) => { settingsMap[s.key] = s.value; });
    upiId = settingsMap.upi_id;
  } catch { /* continue */ }

  // Build line items
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
        lineItems.push({ description: label || section.label, hsnSac: resolveHsnCode(section.type, String(item.hsn_sac_code || ""), section.label), qty: Number(item.quantity || item.billable || 1), rate: Number(item.unit_price || item.rate || item.amount || 0), amount: Number(item.amount || 0) });
      }
    }
  } else {
    if (fixedAmount > 0) lineItems.push({ description: contract.title || `Workspace — ${contract.contract_number}`, hsnSac: resolveHsnCode("rent"), qty: 1, rate: fixedAmount, amount: fixedAmount });
    for (const charge of usageCharges) lineItems.push({ description: charge.description, hsnSac: resolveHsnCode("ad_hoc_charges", (charge as { hsn_sac_code?: string | null }).hsn_sac_code), qty: Number(charge.quantity || 1), rate: Number(charge.unit_price), amount: Number(charge.total) });
  }

  // Generate GST invoice PDF
  const invoiceData: GstInvoiceData = {
    invoiceNumber,
    invoiceDate: new Date().toISOString().slice(0, 10),
    isProforma: false,
    buyerName: lead?.company || `${lead?.first_name || ""} ${lead?.last_name || ""}`.trim() || "Customer",
    buyerAddress: [lead?.street, lead?.city, lead?.state, lead?.zip_code].filter(Boolean).join(", ") || undefined,
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
    upiId,
  };

  const doc = generateGstInvoicePDF(invoiceData);
  const pdfBuffer = Buffer.from(doc.output("arraybuffer"));

  const storagePath = `invoices/${invoiceNumber.replace(/\//g, "-")}.pdf`;
  const { error: uploadErr } = await adminSupabase.storage
    .from("crm-documents")
    .upload(storagePath, pdfBuffer, { contentType: "application/pdf", upsert: true });

  if (uploadErr) console.error("[generate-gst-invoice] PDF upload failed:", uploadErr);

  // Email to customer
  const customerEmail = lead?.email;
  const customerName = lead ? `${lead.first_name || ""} ${lead.last_name || ""}`.trim() : "Customer";
  const periodLabel = new Date(statement.period_start + "T00:00:00").toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", month: "short", year: "numeric" });

  const { data: ccUsers } = await adminSupabase.from("users").select("email").in("role", ["admin", "accounts"]).eq("is_active", true);
  const ccEmails = (ccUsers || []).map((u) => u.email).filter(Boolean);

  const emailHtml = `
    <div style="font-family:sans-serif;max-width:640px;margin:0 auto;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
      <div style="background:#015E65;padding:24px 32px;">
        <h1 style="color:white;margin:0;font-size:20px;">The WorkVilla</h1>
        <p style="color:#00AE6C;margin:4px 0 0;font-size:12px;">Tax Invoice</p>
      </div>
      <div style="padding:32px;">
        <p style="color:#333;font-size:14px;">Dear ${customerName},</p>
        <p style="color:#333;font-size:14px;">Thank you for your payment. Please find your GST tax invoice for <strong>${periodLabel}</strong> attached.</p>
        <table style="width:100%;border-collapse:collapse;margin:16px 0;font-size:13px;">
          <tr><td style="padding:6px 0;color:#666;">Invoice No.</td><td style="padding:6px 0;font-weight:600;">${invoiceNumber}</td></tr>
          <tr><td style="padding:6px 0;color:#666;">Contract</td><td style="padding:6px 0;">${contract.contract_number}</td></tr>
          <tr><td style="padding:6px 0;color:#666;">Amount</td><td style="padding:6px 0;font-weight:600;color:#015E65;font-size:16px;">Rs. ${totalAmount.toLocaleString("en-IN", { minimumFractionDigits: 2 })}</td></tr>
        </table>
        <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:6px;padding:10px 16px;margin:16px 0;font-size:13px;color:#166534;">
          ✓ Payment received. This is your official tax invoice for records and ITC claim purposes.
        </div>
        <p style="color:#666;font-size:13px;margin-top:16px;">Bank details for reference:<br/>${COMPANY_BANK_DETAILS.accountName} · ${COMPANY_BANK_DETAILS.bank} · A/C: ${COMPANY_BANK_DETAILS.accountNumber} · IFSC: ${COMPANY_BANK_DETAILS.ifscCode}</p>
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
      await resend.emails.send({
        from: EMAIL_FROM,
        replyTo: EMAIL_REPLY_TO,
        to: [customerEmail],
        cc: ccEmails.length > 0 ? ccEmails : undefined,
        subject: `Tax Invoice ${invoiceNumber} — ${contract.contract_number} — The WorkVilla`,
        html: emailHtml,
        attachments: !uploadErr ? [{ filename: `${invoiceNumber.replace(/\//g, "-")}.pdf`, content: pdfBuffer, contentType: "application/pdf" }] : undefined,
      });
      emailedSuccessfully = true;
    } catch (err) {
      console.error("[generate-gst-invoice] Email failed:", err);
    }
  }

  // Update statement — mark GST invoice generated + exported
  await adminSupabase
    .from("billing_statements")
    .update({
      gst_invoice_number: invoiceNumber,
      gst_invoice_path: uploadErr ? null : storagePath,
      emailed_at: emailedSuccessfully ? now : null,
      emailed_to: emailedSuccessfully ? customerEmail : null,
      status: "exported",
      exported_at: now,
      subtotal,
      tax_amount: taxAmount,
      total_amount: totalAmount,
      cgst_amount: cgst,
      sgst_amount: sgst,
      igst_amount: igst,
      is_interstate: isInterstate,
      buyer_gstin: lead?.gst_number || null,
      ...(dbUserId ? { gst_generated_by: dbUserId } : {}),
    })
    .eq("id", id);

  // Update contract.next_billing_date if not already updated
  if (contract.next_billing_date) {
    const nextDate = new Date(contract.next_billing_date + "T00:00:00Z");
    nextDate.setMonth(nextDate.getMonth() + 1);
    await adminSupabase
      .from("contracts")
      .update({ next_billing_date: nextDate.toISOString().slice(0, 10) })
      .eq("id", contract.id);
  }

  if (dbUserId) {
    logAudit(adminSupabase, {
      entityType: "billing_statement",
      entityId: id,
      action: "update",
      performedBy: dbUserId,
      changes: {
        gst_invoice_number: { old: null, new: invoiceNumber },
        status: { old: statement.status, new: "exported" },
        emailed_to: { old: null, new: customerEmail || null },
      },
    });
  }

  return NextResponse.json({
    success: true,
    invoiceNumber,
    totalAmount,
    emailedTo: emailedSuccessfully ? customerEmail : null,
    emailSkipped: !customerEmail,
  });
}
