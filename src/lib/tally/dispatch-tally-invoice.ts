/**
 * src/lib/tally/dispatch-tally-invoice.ts
 *
 * Delivers a GST invoice that TALLY issued (number minted in Tally, mirrored
 * back via /api/tally/ack). This is the Tally-era counterpart to
 * dispatchGstDirect — it builds the PDF with Tally's invoice number, sends it
 * to the customer, and (for unpaid invoices) creates the Razorpay link so the
 * existing dunning ladder takes over.
 *
 * Paid-vs-unpaid (the one behavioural fork):
 *   • proforma_first, PI already paid  → payment_status = 'paid' → send the tax
 *     invoice as a RECEIPT. No Razorpay link, no due date, no dunning.
 *   • gst_direct, unpaid               → create a Razorpay link + due date so
 *     payment-reminder enrols it. The invoice doubles as the payment request.
 *
 * Delivered-once gate (D3): keyed on billing_statements.tally_delivered_at. If
 * it is already set, this is a no-op — a duplicate ack (e.g. the B2B IRN re-ack)
 * never double-sends.
 *
 * total_amount mirror (OV3): Tally's authoritative total is written to the
 * statement and used for the Razorpay link + PDF display.
 *
 * Never throws — called fire-and-forget from the ack route. Failures are logged
 * and surfaced via tally_last_error for the reconciliation sweep to retry.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveHsnCode } from "@/lib/e-invoice/sac-codes";
import { resend, EMAIL_FROM, EMAIL_REPLY_TO } from "@/lib/mailer";
import { generateGstInvoicePDF, type GstInvoiceData } from "@/lib/gst-invoice-generator";
import { COMPANY_BANK_DETAILS } from "@/lib/constants";
import { messaging } from "@/lib/whatsapp";
import { logAudit } from "@/lib/audit";
import { enqueueReceiptsForPaidStatement } from "@/lib/tally/enqueue";
import QRCode from "qrcode";

export interface TallyInvoiceAck {
  invoiceNumber: string;
  totalAmount:   number;        // Tally's authoritative total (paise-free rupees)
  signedQrCode?: string | null; // IRP signed QR (B2B) — rendered later (D4)
  irn?:          string | null;
}

export interface DispatchTallyResult {
  ok: boolean;
  alreadyDelivered?: boolean;
  emailedTo?: string | null;
  razorpayLinkUrl?: string | null;
  error?: string;
}

export async function dispatchTallyInvoice(
  supabase: SupabaseClient,
  billingStatementId: string,
  ack: TallyInvoiceAck,
): Promise<DispatchTallyResult> {
  try {
    // ── Fetch statement + contract + lead + usage ─────────────────────────────
    const { data: statement, error: fetchErr } = await supabase
      .from("billing_statements")
      .select(`
        *,
        contract:contracts!billing_statements_contract_id_fkey(
          id, contract_number, title, tax_percentage, location_id,
          lead:leads!contracts_lead_id_fkey(id, first_name, last_name, company, email, phone, state, gst_number, mobile)
        ),
        usage_charges:usage_charges(id, description, quantity, unit_price, total)
      `)
      .eq("id", billingStatementId)
      .single();

    if (fetchErr || !statement) {
      return { ok: false, error: "Statement not found" };
    }

    // ── Delivered-once gate (D3) ─────────────────────────────────────────────
    if (statement.tally_delivered_at) {
      return { ok: true, alreadyDelivered: true };
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const contract = statement.contract as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const lead = contract?.lead as any;
    if (!contract) {
      return { ok: false, error: "No contract linked" };
    }

    const customerEmail = (lead?.email as string | undefined) || undefined;
    const customerPhone = ((lead?.mobile || lead?.phone) as string | undefined) || undefined;
    const customerName  = lead?.company
      || `${lead?.first_name || ""} ${lead?.last_name || ""}`.trim()
      || "Customer";

    // ── Totals (taxable from the statement; total mirrored from Tally) ────────
    const usageCharges = (statement.usage_charges || []) as { description: string; quantity: number; unit_price: number; total: number }[];
    const usageAmount = usageCharges.reduce((s, c) => s + Number(c.total || 0), 0);
    const fixedAmount = Number(statement.fixed_amount || 0);
    const serviceUsageAmount = Number(statement.service_usage_amount || 0);
    const bookingUsageAmount = Number(statement.booking_usage_amount || 0);
    const subtotal = fixedAmount + usageAmount + serviceUsageAmount + bookingUsageAmount;
    const taxPercentage = Number(statement.tax_percentage || 18);
    const isInterstate = false; // coworking: always Tamil Nadu → CGST+SGST
    const igst = 0;
    const cgst = Math.round(subtotal * (taxPercentage / 200) * 100) / 100;
    const sgst = Math.round(subtotal * (taxPercentage / 200) * 100) / 100;
    const computedTotal = subtotal + cgst + sgst;
    // OV3: trust Tally's total when it is sane; fall back to computed.
    const totalAmount = ack.totalAmount > 0 ? ack.totalAmount : computedTotal;

    // ── Paid vs unpaid fork ──────────────────────────────────────────────────
    const isPaid = statement.payment_status === "paid";

    // Due date for the dunning ladder (unpaid only). Rent = period_start+7, else today+7.
    const isRent = (statement.statement_type as string) === "rent";
    const issueDateYmd = isRent && statement.period_start
      ? (statement.period_start as string)
      : new Date().toISOString().slice(0, 10);
    const existingDue = statement.due_date as string | null;
    const [iy, im, idd] = issueDateYmd.split("-").map(Number);
    const dueDate = existingDue || new Date(Date.UTC(iy, im - 1, idd + 7)).toISOString().slice(0, 10);

    // ── Razorpay link (unpaid only) ──────────────────────────────────────────
    let razorpayLinkId: string | null = null;
    let razorpayLinkUrl: string | null = null;
    if (!isPaid) {
      const link = await createRazorpayLink(supabase, {
        amount: totalAmount,
        invoiceNumber: ack.invoiceNumber,
        statementId: billingStatementId,
        contractNumber: contract.contract_number,
        customerName,
        customerEmail,
        customerPhone,
      });
      if (link.ok) {
        razorpayLinkId = link.linkId;
        razorpayLinkUrl = link.linkUrl;
      } else {
        console.error(`[dispatch-tally] Razorpay link failed for ${billingStatementId}: ${link.error}`);
      }
    }

    // ── UPI for the PDF ──────────────────────────────────────────────────────
    let upiId: string | undefined;
    try {
      const { data: s } = await supabase.from("app_settings").select("value").eq("key", "upi_id").single();
      upiId = (s as { value?: string } | null)?.value || undefined;
    } catch { /* non-blocking */ }

    // ── IRP QR code (e-invoice — mandatory on B2B tax invoices) ─────────────
    let irnQrBase64: string | undefined;
    if (ack.signedQrCode) {
      try {
        irnQrBase64 = await QRCode.toDataURL(ack.signedQrCode, { width: 200, margin: 1, errorCorrectionLevel: "M" });
      } catch { /* skip — QR is non-blocking */ }
    }

    // ── Line items ───────────────────────────────────────────────────────────
    const lineItems = buildLineItems(statement, contract, usageCharges, fixedAmount);

    // ── Build PDF (Tally's invoice number) ───────────────────────────────────
    let razorpayQrBase64: string | undefined;
    if (razorpayLinkUrl) {
      try { razorpayQrBase64 = await QRCode.toDataURL(razorpayLinkUrl, { width: 200, margin: 1, errorCorrectionLevel: "M" }); } catch { /* skip */ }
    }
    const invoiceData: GstInvoiceData = {
      invoiceNumber: ack.invoiceNumber,
      invoiceDate: issueDateYmd,
      isProforma: false,
      buyerName: customerName,
      buyerGstin: lead?.gst_number || undefined,
      buyerState: lead?.state || undefined,
      periodStart: statement.period_start as string,
      periodEnd: statement.period_end as string,
      dueDate: isPaid ? undefined : dueDate,
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
      upiId,
      irn:         ack.irn ?? undefined,
      irnQrBase64: irnQrBase64 ?? undefined,
    };
    const doc = generateGstInvoicePDF(invoiceData);
    const pdfBuffer = Buffer.from(doc.output("arraybuffer"));

    const storagePath = `gst-invoices/${ack.invoiceNumber.replace(/\//g, "-")}.pdf`;
    await supabase.storage.from("crm-documents").upload(storagePath, pdfBuffer, { contentType: "application/pdf", upsert: true });
    const { data: publicUrlData } = supabase.storage.from("crm-documents").getPublicUrl(storagePath);
    const pdfPublicUrl = publicUrlData?.publicUrl || null;

    // ── Email ────────────────────────────────────────────────────────────────
    const periodLabel = new Date((statement.period_start as string) + "T00:00:00").toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", month: "short", year: "numeric" });
    const { data: ccUsers } = await supabase.from("users").select("email").in("role", ["admin", "accounts"]).eq("is_active", true);
    const ccEmails = (ccUsers || []).map((u: { email: string }) => u.email).filter(Boolean);

    const emailHtml = buildEmailHtml({
      customerName, periodLabel, invoiceNumber: ack.invoiceNumber,
      contractNumber: contract.contract_number, totalAmount, isPaid,
      razorpayLinkUrl, upiId, dueDate,
    });

    const now = new Date().toISOString();
    let emailedSuccessfully = false;
    if (customerEmail) {
      try {
        await resend.emails.send({
          from: EMAIL_FROM,
          replyTo: EMAIL_REPLY_TO,
          to: [customerEmail],
          cc: ccEmails.length > 0 ? ccEmails : undefined,
          subject: `Tax Invoice ${ack.invoiceNumber} — ${contract.contract_number} — The WorkVilla`,
          html: emailHtml,
          attachments: [{ filename: `Invoice-${ack.invoiceNumber.replace(/\//g, "-")}.pdf`, content: pdfBuffer, contentType: "application/pdf" }],
        });
        emailedSuccessfully = true;
      } catch (err) {
        console.error("[dispatch-tally] Email failed:", err);
      }
    }

    // ── WhatsApp (fire-and-forget) ───────────────────────────────────────────
    if (customerPhone && pdfPublicUrl) {
      void messaging.invoiceDocument(
        customerPhone,
        customerName,
        ack.invoiceNumber,
        `Rs. ${Math.round(totalAmount).toLocaleString("en-IN")}`,
        razorpayLinkUrl || "",
        pdfPublicUrl,
        billingStatementId,
      ).catch((err: unknown) => console.error("[dispatch-tally] WhatsApp failed:", err));
    }

    // ── Persist: mirror Tally number + total, mark delivered (D3 gate) ────────
    const updatePayload: Record<string, unknown> = {
      gst_invoice_number: ack.invoiceNumber,   // mirror Tally's number into the CRM field
      gst_invoice_date: issueDateYmd,
      gst_invoice_path: storagePath,
      subtotal,
      tax_amount: cgst + sgst + igst,
      total_amount: totalAmount,
      cgst_amount: cgst,
      sgst_amount: sgst,
      igst_amount: igst,
      is_interstate: isInterstate,
      buyer_gstin: lead?.gst_number || null,
      status: "exported",
      exported_at: now,
      tally_delivered_at: now,
      lifecycle_stage: "sent",
      tally_last_error: null,
    };
    if (emailedSuccessfully) { updatePayload.emailed_at = now; updatePayload.emailed_to = customerEmail; }
    if (!isPaid) {
      updatePayload.due_date = dueDate;
      if (razorpayLinkId) updatePayload.razorpay_payment_link_id = razorpayLinkId;
      if (razorpayLinkUrl) updatePayload.razorpay_payment_link_url = razorpayLinkUrl;
    }

    await supabase.from("billing_statements").update(updatePayload).eq("id", billingStatementId);

    void logAudit(supabase, {
      entityType: "billing_statement",
      entityId: billingStatementId,
      action: "update",
      performedBy: "tally-bridge",
      changes: {
        gst_invoice_number: { old: null, new: ack.invoiceNumber },
        total_amount: { old: null, new: totalAmount },
        tally_delivered_at: { old: null, new: now },
      },
    });

    // proforma_first back-fill (#1): the PI was paid BEFORE this invoice existed,
    // so the payment's receipt never enqueued. Now that the invoice is issued in
    // Tally, post the receipt(s) for the money already received. Idempotent.
    if (isPaid) {
      void enqueueReceiptsForPaidStatement(billingStatementId);
    }

    return { ok: true, emailedTo: emailedSuccessfully ? (customerEmail ?? null) : null, razorpayLinkUrl };
  } catch (err) {
    console.error(`[dispatch-tally] unexpected error for ${billingStatementId}:`, err);
    // Surface for the reconciliation sweep — do NOT mark delivered.
    try {
      await supabase.from("billing_statements")
        .update({ tally_last_error: `dispatch: ${String(err)}` })
        .eq("id", billingStatementId);
    } catch { /* ignore */ }
    return { ok: false, error: String(err) };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function buildLineItems(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  statement: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  contract: any,
  usageCharges: { description: string; quantity: number; unit_price: number; total: number; hsn_sac_code?: string | null }[],
  fixedAmount: number,
): GstInvoiceData["lineItems"] {
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
          hsnSac: resolveHsnCode(section.type, String(item.hsn_sac_code || ""), section.label),
          qty: Number(item.quantity || item.billable || 1),
          rate: Number(item.unit_price || item.rate || item.amount || 0),
          amount: Number(item.amount || 0),
        });
      }
    }
  } else {
    if (fixedAmount > 0) lineItems.push({ description: contract.title || `Workspace — ${contract.contract_number}`, hsnSac: resolveHsnCode("rent"), qty: 1, rate: fixedAmount, amount: fixedAmount });
    for (const charge of usageCharges) lineItems.push({ description: charge.description, hsnSac: resolveHsnCode("ad_hoc_charges", charge.hsn_sac_code), qty: Number(charge.quantity || 1), rate: Number(charge.unit_price), amount: Number(charge.total) });
  }
  return lineItems;
}

function buildEmailHtml(p: {
  customerName: string; periodLabel: string; invoiceNumber: string;
  contractNumber: string; totalAmount: number; isPaid: boolean;
  razorpayLinkUrl: string | null; upiId?: string; dueDate: string;
}): string {
  const amountStr = `Rs. ${Math.round(p.totalAmount).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
  const dueDateStr = new Date(p.dueDate + "T00:00:00").toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric" });

  const paidBanner = p.isPaid
    ? `<div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:6px;padding:10px 16px;margin:16px 0;font-size:13px;color:#166534;">✓ Payment received. This is your official tax invoice for records and ITC claim purposes.</div>`
    : "";

  const paymentOptions = p.isPaid ? "" : `
    <h3 style="color:#015E65;font-size:14px;margin:20px 0 10px;">Payment Options</h3>
    <table style="width:100%;border-collapse:collapse;font-size:13px;">
      <tr><td style="padding:4px 0;color:#666;">Bank Transfer</td><td style="padding:4px 0;">${COMPANY_BANK_DETAILS.accountName}<br/>${COMPANY_BANK_DETAILS.bank}, ${COMPANY_BANK_DETAILS.branch}<br/>A/C: ${COMPANY_BANK_DETAILS.accountNumber} | IFSC: ${COMPANY_BANK_DETAILS.ifscCode}</td></tr>
      ${p.upiId ? `<tr><td style="padding:4px 0;color:#666;">UPI</td><td style="padding:4px 0;">${p.upiId}</td></tr>` : ""}
      ${p.razorpayLinkUrl ? `<tr><td style="padding:4px 0;color:#666;">Pay Online</td><td style="padding:4px 0;"><a href="${p.razorpayLinkUrl}" style="color:#015E65;font-weight:bold;">${p.razorpayLinkUrl}</a></td></tr>` : ""}
    </table>
    ${p.razorpayLinkUrl ? `<div style="text-align:center;margin:24px 0;"><a href="${p.razorpayLinkUrl}" style="background:#015E65;color:white;padding:12px 32px;text-decoration:none;border-radius:8px;font-weight:bold;display:inline-block;font-size:14px;">Pay Now</a></div>` : ""}
  `;

  const intro = p.isPaid
    ? `Thank you for your payment. Please find your GST tax invoice for <strong>${p.periodLabel}</strong> attached.`
    : `Please find attached your tax invoice for <strong>${p.periodLabel}</strong>. Kindly make the payment by the due date.`;

  const dueRow = p.isPaid ? "" : `<tr><td style="padding:6px 0;color:#666;">Due By</td><td style="padding:6px 0;font-weight:600;color:#b45309;">${dueDateStr}</td></tr>`;

  return `
    <div style="font-family:sans-serif;max-width:640px;margin:0 auto;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
      <div style="background:#015E65;padding:24px 32px;">
        <h1 style="color:white;margin:0;font-size:20px;">The WorkVilla</h1>
        <p style="color:#00AE6C;margin:4px 0 0;font-size:12px;">Tax Invoice</p>
      </div>
      <div style="padding:32px;">
        <p style="color:#333;font-size:14px;">Dear ${p.customerName},</p>
        <p style="color:#333;font-size:14px;">${intro}</p>
        <table style="width:100%;border-collapse:collapse;margin:16px 0;font-size:13px;">
          <tr><td style="padding:6px 0;color:#666;">Invoice No.</td><td style="padding:6px 0;font-weight:600;">${p.invoiceNumber}</td></tr>
          <tr><td style="padding:6px 0;color:#666;">Contract</td><td style="padding:6px 0;">${p.contractNumber}</td></tr>
          <tr><td style="padding:6px 0;color:#666;">Period</td><td style="padding:6px 0;">${p.periodLabel}</td></tr>
          ${dueRow}
          <tr><td style="padding:6px 0;color:#666;">Amount</td><td style="padding:6px 0;font-weight:600;color:#015E65;font-size:16px;">${amountStr}</td></tr>
        </table>
        ${paidBanner}
        ${paymentOptions}
        <p style="color:#333;font-size:14px;margin-top:24px;">Warm regards,<br/><strong>The WorkVilla</strong></p>
      </div>
      <div style="background:#015E65;padding:12px 32px;text-align:center;">
        <p style="color:#fff;margin:0;font-size:10px;">SREE DESIGN INFRASTRUCTURE PVT LTD</p>
        <p style="color:rgba(255,255,255,0.6);margin:4px 0 0;font-size:9px;">Prakash Presidium, 110, MG Road, Nungambakkam, Chennai - 600034 | GSTIN: 33AAACU4245J1ZF</p>
      </div>
    </div>
  `;
}

type RzpLink = { ok: true; linkId: string; linkUrl: string } | { ok: false; error: string };

async function createRazorpayLink(
  supabase: SupabaseClient,
  p: {
    amount: number; invoiceNumber: string; statementId: string; contractNumber: string;
    customerName: string; customerEmail?: string; customerPhone?: string;
  },
): Promise<RzpLink> {
  const { data: rows } = await supabase
    .from("app_settings").select("key, value")
    .in("key", ["razorpay_enabled", "razorpay_key_id", "razorpay_key_secret"]);
  const rzp = (rows || []).reduce((m: Record<string, string>, r: { key: string; value: string }) => { m[r.key] = r.value; return m; }, {});
  if (rzp.razorpay_enabled !== "true" || !rzp.razorpay_key_id || !rzp.razorpay_key_secret) {
    return { ok: false, error: "Razorpay not enabled" };
  }

  const auth = Buffer.from(`${rzp.razorpay_key_id}:${rzp.razorpay_key_secret}`).toString("base64");
  const appUrl = (process.env.NEXT_PUBLIC_APP_URL || process.env.APP_URL || "https://twv-crm.vercel.app").trim();
  const phone = normalizePhone(p.customerPhone);
  const payload: Record<string, unknown> = {
    amount: Math.round(p.amount * 100),
    currency: "INR",
    accept_partial: false,
    description: `Tax Invoice ${p.invoiceNumber} — ${p.contractNumber} — The WorkVilla`,
    reference_id: `${p.invoiceNumber.replace(/[^a-zA-Z0-9_-]/g, "-")}-tally`,
    expire_by: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
    reminder_enable: true,
    notify: { sms: !!phone, email: !!p.customerEmail },
    notes: { billing_statement_id: p.statementId, invoice_number: p.invoiceNumber, source: "tally" },
    callback_url: `${appUrl}/billing`,
    callback_method: "get",
  };
  if (p.customerName || p.customerEmail || phone) {
    payload.customer = {
      ...(p.customerName ? { name: p.customerName } : {}),
      ...(p.customerEmail ? { email: p.customerEmail } : {}),
      ...(phone ? { contact: phone } : {}),
    };
  }

  try {
    const res = await fetch("https://api.razorpay.com/v1/payment_links", {
      method: "POST",
      headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => null) as { error?: { description?: string } } | null;
      return { ok: false, error: err?.error?.description ?? `HTTP ${res.status}` };
    }
    const data = await res.json() as { id: string; short_url: string };
    return { ok: true, linkId: data.id, linkUrl: data.short_url };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

function normalizePhone(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  let phone = String(raw).replace(/[\s-]/g, "");
  if (phone.startsWith("+")) phone = phone.substring(1);
  if (!phone.startsWith("91") && phone.length === 10) phone = "91" + phone;
  return "+" + phone;
}
