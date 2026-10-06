/**
 * dispatchProforma — shared proforma dispatch logic.
 *
 * Called by:
 *   • POST /api/billing-statements/[id]/send-proforma  (manual admin trigger / resend)
 *   • generateRentProformas() in billing.ts             (auto-dispatch on last day of month)
 *
 * Centralising here means both paths share the same Razorpay link creation,
 * PDF generation, email/WhatsApp dispatch, and statement update logic.
 * No HTTP self-calls needed from the generator.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { resend, EMAIL_FROM, EMAIL_REPLY_TO } from "@/lib/mailer";
import { generateGstInvoicePDF, type GstInvoiceData } from "@/lib/gst-invoice-generator";
import { COMPANY_BANK_DETAILS, RAZORPAY_MAX_LINK_VALIDITY_SECONDS } from "@/lib/constants";
import { logAudit } from "@/lib/audit";
import { logCommunication } from "@/lib/communications-log";
import type { CommunicationLogEntry } from "@/types";
import { getCachedSettings } from "@/lib/app-settings-cache";
import { routeGstGenerationToTally, isCrmGstEnabled } from "@/lib/tally/enqueue";
import QRCode from "qrcode";
import { resolveHsnCode } from "@/lib/e-invoice/sac-codes";
import { resolveLineItemQty, resolveLineItemRate, withProrationBreakdown } from "@/lib/billing-pdf-utils";
import { computeGstAndRounding } from "@/lib/gst-math";
import { fetchSupportingDocuments, mergeSupportingDocuments } from "@/lib/reimbursement-supporting-docs";

/** Per-call timeout (ms) for outbound HTTP and the Resend SDK send. A single
 *  slow/hung Razorpay or email call must not stall the whole batch loop. */
const RAZORPAY_TIMEOUT_MS = 10_000;
const EMAIL_TIMEOUT_MS    = 15_000;

/** Reject the given promise after `ms` milliseconds with a clear error. */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

export interface DispatchResult {
  success: boolean;
  proformaRef: string;
  totalAmount: number;
  razorpayLinkUrl: string | null;
  emailedTo: string | null;
  emailSkipped: boolean;
  /** True when both email AND phone/mobile are missing — proforma could not be sent */
  noContact: boolean;
  /** True when GST issuance was handed to Tally — CRM generated/sent nothing here. */
  routedToTally?: boolean;
  /** True when both GST modes are off — invoice deferred until a mode is activated. */
  standby?: boolean;
  /** Storage path of the generated PDF in the crm-documents bucket, e.g. for callers
   *  that need a signed URL to attach the PDF to a WhatsApp message. */
  pdfStoragePath?: string | null;
  /** communications_log row for the email send, if one was attempted — lets the
   *  caller show a post-send confirmation with the exact content that was sent. */
  commLogEntry?: CommunicationLogEntry | null;
  error?: string;
}

/**
 * Dispatch a proforma for an already-finalized billing statement.
 *
 * @param adminSupabase  Admin Supabase client (bypasses RLS)
 * @param statementId    ID of the finalized billing_statements row
 * @param dispatchedBy   User ID to record in audit log (null for cron-triggered sends)
 * @param additionalCc   Extra CC emails (e.g. from request body when triggered manually)
 * @param toOverride     Explicit recipient list (e.g. from the resend dialog's
 *                       checkbox picker). When non-empty, replaces the default
 *                       customerEmail + lead.billing_emails auto-merge — lets a
 *                       user deliberately exclude an address for one send.
 */
export async function dispatchProforma(
  adminSupabase: SupabaseClient,
  statementId: string,
  dispatchedBy: string | null = null,
  additionalCc: string[] = [],
  toOverride: string[] = [],
): Promise<DispatchResult> {
  // ── Fetch statement with contract + lead (or proposal + lead, for a PI that ──
  // hasn't converted into a contract yet) ─────────────────────────────────────
  const { data: statement, error: fetchErr } = await adminSupabase
    .from("billing_statements")
    .select(`
      *,
      contract:contracts!billing_statements_contract_id_fkey(
        id, contract_number, title, total_amount, subtotal, tax_percentage,
        start_date, end_date, next_billing_date, billing_cycle, location_id, items,
        lead:leads!contracts_lead_id_fkey(id, first_name, last_name, company, email, phone, state, gst_number, mobile, billing_emails)
      ),
      proposal:proposals!billing_statements_proposal_id_fkey(
        id, proposal_number,
        lead:leads!proposals_lead_id_fkey(id, first_name, last_name, company, email, phone, state, gst_number, mobile, billing_emails)
      ),
      case:cases!billing_statements_case_id_fkey(
        id, case_number, bill_to, client_name, client_company_name, client_email, client_phone, client_gst_number, tenure_months,
        aggregator:aggregators!cases_aggregator_id_fkey(id, name, primary_email, primary_phone, gst_number)
      ),
      aggregator:aggregators!billing_statements_aggregator_id_fkey(id, name, primary_email, primary_phone, gst_number),
      usage_charges:usage_charges(id, description, quantity, unit_price, total, is_waived, hsn_sac_code)
    `)
    .eq("id", statementId)
    .single();

  if (fetchErr || !statement) {
    return { success: false, proformaRef: "", totalAmount: 0, razorpayLinkUrl: null, emailedTo: null, emailSkipped: true, noContact: false, error: "Statement not found" };
  }

  // On hold — something on this statement is being clarified/corrected.
  // Blocks send only; the draft itself stays editable elsewhere.
  if (statement.held_at) {
    return { success: false, proformaRef: "", totalAmount: 0, razorpayLinkUrl: null, emailedTo: null, emailSkipped: true, noContact: false, error: `Statement is on hold: ${statement.hold_reason}` };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const contract = statement.contract as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const proposal = statement.proposal as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const voCase = statement.case as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const voAggregator = statement.aggregator as any;

  if (!contract && !proposal && !voCase && !voAggregator) {
    return { success: false, proformaRef: "", totalAmount: 0, razorpayLinkUrl: null, emailedTo: null, emailSkipped: true, noContact: false, error: "No contract, proposal, case, or aggregator linked to this statement" };
  }

  /** Synthesizes the same lead shape (id/company/email/phone/mobile/gst_number)
   *  used elsewhere in this function from a Virtual Office case or aggregator —
   *  mirrors leadFromVoSource in upload-gst-invoice/route.ts. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function leadFromVoSource(): any {
    if (voCase) {
      const billToAggregator = voCase.bill_to === "aggregator" ? voCase.aggregator : null;
      if (billToAggregator) {
        return {
          id: billToAggregator.id, first_name: null, last_name: null, company: billToAggregator.name,
          email: billToAggregator.primary_email, phone: null, mobile: billToAggregator.primary_phone,
          state: null, gst_number: billToAggregator.gst_number, billing_emails: null,
        };
      }
      return {
        id: voCase.id, first_name: null, last_name: null, company: voCase.client_company_name || voCase.client_name,
        email: voCase.client_email, phone: null, mobile: voCase.client_phone,
        state: null, gst_number: voCase.client_gst_number, billing_emails: null,
      };
    }
    if (voAggregator) {
      return {
        id: voAggregator.id, first_name: null, last_name: null, company: voAggregator.name,
        email: voAggregator.primary_email, phone: null, mobile: voAggregator.primary_phone,
        state: null, gst_number: voAggregator.gst_number, billing_emails: null,
      };
    }
    return null;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const lead = (contract?.lead ?? proposal?.lead ?? leadFromVoSource()) as any;
  // Reference label printed on the PDF / in emails wherever a contract number
  // would normally go — falls back to the proposal number for a PI that hasn't
  // converted into a contract yet, or the case/aggregator identifier for
  // Virtual Office statements.
  const partyRef: string = contract?.contract_number ?? proposal?.proposal_number ?? voCase?.case_number ?? voAggregator?.name ?? "";

  // ── Check for contact info ───────────────────────────────────────────────
  const customerEmail = lead?.email as string | undefined;
  const customerPhone = (lead?.phone || lead?.mobile) as string | undefined;
  const noContact = !customerEmail && !customerPhone;
  const billingEmails = (lead?.billing_emails as string[] | null) ?? [];
  const toList = toOverride.length > 0
    ? Array.from(new Set(toOverride.filter(Boolean)))
    : Array.from(new Set([customerEmail, ...billingEmails].filter((e): e is string => Boolean(e))));

  // ── Calculate GST totals — derive from the structured line_items sections
  // (the same data the table below is built from) so the totals box can
  // never drift from what's printed. Falls back to the legacy per-field sum
  // only for statements predating the structured line_items JSONB.
  //
  // Ad-hoc charges are the one exception: add-charge/waive-charge
  // (POST .../add-charge, .../waive-charge) update usage_charges and the
  // statement's flat total_amount atomically, but never touch this frozen
  // line_items snapshot — so a charge added (or waived) after generation
  // would otherwise silently vanish from (or wrongly stay on) what actually
  // gets billed and printed. The live usage_charges table, filtered to
  // non-waived, is the source of truth for that section; every other
  // section type (facility/service/booking usage) has no post-generation
  // edit path, so the frozen snapshot is safe to trust as-is.
  const usageCharges = ((statement.usage_charges || []) as { description: string; quantity: number; unit_price: number; total: number; is_waived: boolean }[])
    .filter((c) => !c.is_waived);
  const usageAmount = usageCharges.reduce((s: number, c: { total: number }) => s + Number(c.total || 0), 0);
  const fixedAmount = Number(statement.fixed_amount || 0);
  const serviceUsageAmount = Number(statement.service_usage_amount || 0);
  const bookingUsageAmount = Number(statement.booking_usage_amount || 0);
  const structuredSections = (statement.line_items || []) as Array<{
    type: string; label: string; items: Record<string, unknown>[]; subtotal: number
  }>;
  const nonAdHocSections = structuredSections.filter((sec) => sec.type !== "ad_hoc_charges");
  const subtotal = structuredSections.length > 0
    ? nonAdHocSections.reduce((s, sec) => s + Number(sec.subtotal || 0), 0) + usageAmount
    : fixedAmount + usageAmount + serviceUsageAmount + bookingUsageAmount;
  const taxPercentage = Number(statement.tax_percentage || 18);

  const buyerState = (lead?.state || "").toLowerCase().trim();
  // Place of supply is always Tamil Nadu — service rendered at TWV premises (always CGST+SGST)
      const isInterstate = false;

  const { cgst, sgst, igst, taxAmount, totalAmount } = computeGstAndRounding(subtotal, taxPercentage);
  const proformaRef = statement.statement_number as string;

  // ── Fetch UPI ID and Razorpay keys from app_settings (single cached call) ─
  const appSettings = await getCachedSettings(adminSupabase, [
    "upi_id",
    "razorpay_key_id",
    "razorpay_key_secret",
    "razorpay_enabled",
  ]);
  const upiId = appSettings["upi_id"] ?? undefined;
  const rzpKeyId = appSettings["razorpay_key_id"];
  const rzpKeySecret = appSettings["razorpay_key_secret"];
  const rzpEnabled = appSettings["razorpay_enabled"] === "true";

  // ── Create or reuse Razorpay payment link ───────────────────────────────
  let razorpayLinkId: string | null = (statement.razorpay_payment_link_id as string | null) || null;
  let razorpayLinkUrl: string | null = (statement.razorpay_payment_link_url as string | null) || null;

  if (!razorpayLinkId) {
    try {
      if (rzpEnabled && rzpKeyId && rzpKeySecret) {
        const auth = Buffer.from(`${rzpKeyId}:${rzpKeySecret}`).toString("base64");
        const appUrl = (process.env.NEXT_PUBLIC_APP_URL || "https://twv-crm.vercel.app").trim();
        const customerName = lead ? `${lead.first_name || ""} ${lead.last_name || ""}`.trim() : "Customer";

        // Unique per-statement reference — Razorpay deduplicates on reference_id
        const refId = `${proformaRef}-proforma`.replace(/[^a-zA-Z0-9_-]/g, "-");

        const payload: Record<string, unknown> = {
          amount: Math.round(totalAmount * 100),
          currency: "INR",
          description: `Proforma ${proformaRef} — ${partyRef} — The WorkVilla`,
          reference_id: refId,
          expire_by: Math.floor(Date.now() / 1000) + RAZORPAY_MAX_LINK_VALIDITY_SECONDS,
          notify: { sms: !!customerPhone, email: !!customerEmail },
          reminder_enable: true,
          notes: { statement_id: statementId, contract_number: partyRef, proforma: "true" },
          callback_url: `${appUrl}/billing`,
          callback_method: "get",
        };

        if (customerName || customerEmail || customerPhone) {
          payload.customer = {} as Record<string, string>;
          if (customerName) (payload.customer as Record<string, string>).name = customerName;
          if (customerEmail) (payload.customer as Record<string, string>).email = customerEmail;
          if (customerPhone) (payload.customer as Record<string, string>).contact = customerPhone.replace(/\s/g, "");
        }

        const rzpRes = await withTimeout(
          fetch("https://api.razorpay.com/v1/payment_links", {
            method: "POST",
            headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          }),
          RAZORPAY_TIMEOUT_MS,
          "Razorpay create link",
        );

        if (rzpRes.ok) {
          const linkData = await rzpRes.json();
          razorpayLinkId = linkData.id;
          razorpayLinkUrl = linkData.short_url;
        } else {
          const errBody = await rzpRes.json().catch(() => ({})) as { error?: { description?: string } };
          if (errBody?.error?.description?.includes("already exists")) {
            const fetchRes = await withTimeout(
              fetch(`https://api.razorpay.com/v1/payment_links?reference_id=${refId}`, {
                headers: { Authorization: `Basic ${auth}` },
              }),
              RAZORPAY_TIMEOUT_MS,
              "Razorpay dedup fetch",
            );
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

  // ── Build PDF line items ─────────────────────────────────────────────────
  const lineItems: GstInvoiceData["lineItems"] = [];

  if (structuredSections.length > 0) {
    for (const section of nonAdHocSections) {
      for (const item of section.items) {
        const desc = item.description || item.booking_number || section.label;
        let label = String(desc);
        if (section.type === "booking_usage" && item.date) {
          label = [String(item.date), item.space ? String(item.space) : "", item.time ? String(item.time) : "", item.duration ? String(item.duration) : ""].filter(Boolean).join(" · ");
        }
        lineItems.push({
          description: withProrationBreakdown(label || section.label, item),
          hsnSac: resolveHsnCode(section.type, String(item.hsn_sac_code || ""), section.label),
          qty: resolveLineItemQty(item, "send-proforma"),
          rate: resolveLineItemRate(item),
          amount: Number(item.amount || 0),
        });
      }
    }
  } else if (fixedAmount > 0) {
    lineItems.push({ description: contract?.title || `Workspace — ${partyRef}`, hsnSac: resolveHsnCode("rent"), qty: 1, rate: fixedAmount, amount: fixedAmount });
  }
  for (const charge of usageCharges) {
    lineItems.push({ description: charge.description, hsnSac: resolveHsnCode("ad_hoc_charges", (charge as { hsn_sac_code?: string | null }).hsn_sac_code), qty: Number(charge.quantity || 1), rate: Number(charge.unit_price), amount: Number(charge.total) });
  }

  // ── Generate PDF ─────────────────────────────────────────────────────────
  let razorpayQrBase64: string | undefined;
  const linkExpiry = new Date(Date.now() + 15 * 24 * 60 * 60 * 1000);
  const razorpayExpiry = linkExpiry.toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric" });
  if (razorpayLinkUrl) {
    try {
      razorpayQrBase64 = await QRCode.toDataURL(razorpayLinkUrl, { width: 200, margin: 1, errorCorrectionLevel: "M" });
    } catch { /* skip QR */ }
  }

  // Customer-facing proof attached at bill-customer time — appended as extra
  // pages after the PDF is generated below (see mergeSupportingDocuments).
  const supportingDocs = (statement.statement_type as string) === "reimbursement"
    ? await fetchSupportingDocuments(adminSupabase, statement.id as string)
    : [];

  const invoiceData: GstInvoiceData = {
    invoiceNumber: proformaRef,
    // Rent proformas: invoice date = 1st of the billed month (period_start).
    //   e.g. June rent sent May 30 → prints "1 June 2026"
    // Usage proformas: invoice date = actual send date (today).
    //   Usage charges are issued after month-end; the date reflects when
    //   the invoice was actually raised, not the period it covers.
    invoiceDate: (statement.statement_type as string) === "rent"
      ? (statement.period_start as string)
      : new Date().toISOString().slice(0, 10),
    isProforma: true,
    // Reimbursement PIs collapse to Description | Amount — no per-line
    // qty/rate/HSN/tax breakdown, just the consolidated totals block below.
    compactLineItems: (statement.statement_type as string) === "reimbursement",
    buyerName: lead?.company || `${lead?.first_name || ""} ${lead?.last_name || ""}`.trim() || "Customer",
    buyerGstin: lead?.gst_number || undefined,
    buyerState: lead?.state || undefined,
    periodStart: statement.period_start as string,
    periodEnd: statement.period_end as string,
    dueDate: (statement.due_date as string | null) || undefined,
    contractNumber: partyRef,
    poNumber: statement.po_number as string | null,
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
    supportingDocsCount: supportingDocs.length || undefined,
  };

  const doc = generateGstInvoicePDF(invoiceData);
  let pdfBuffer = Buffer.from(doc.output("arraybuffer"));
  if (supportingDocs.length > 0) {
    pdfBuffer = await mergeSupportingDocuments(adminSupabase, pdfBuffer, supportingDocs);
  }

  // Upload PDF to storage
  const storagePath = `proforma/${proformaRef.replace(/\//g, "-")}.pdf`;
  await adminSupabase.storage
    .from("crm-documents")
    .upload(storagePath, pdfBuffer, { contentType: "application/pdf", upsert: true });

  // ── Send email ────────────────────────────────────────────────────────────
  const appBaseUrl = (process.env.NEXT_PUBLIC_APP_URL || process.env.APP_URL || "https://twv-crm.vercel.app").trim();
  const proformaTrackingUrl = `${appBaseUrl}/api/billing-statements/${statement.id}/track?type=proforma`;

  // Virtual Office case statements bill the case's whole tenure as a single
  // one-time license fee (see src/lib/case-invoicing.ts), not a calendar
  // month — a "Aug 2026"-style period label misrepresents it. Contract/
  // proposal-sourced proformas are unaffected and keep the month label.
  const periodLabel = voCase && voCase.tenure_months
    ? `${voCase.tenure_months} month${voCase.tenure_months === 1 ? "" : "s"}`
    : new Date((statement.period_start as string) + "T00:00:00").toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", month: "short", year: "numeric" });
  const introSentence = voCase
    ? "Please find attached your proforma invoice for Virtual Office space. Kindly make the payment at your earliest convenience."
    : `Please find attached your proforma invoice for <strong>${periodLabel}</strong>. Kindly make the payment at your earliest convenience.`;
  const dueDateStr = statement.due_date
    ? new Date((statement.due_date as string) + "T00:00:00").toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric" })
    : null;
  const customerName = lead ? `${lead.first_name || ""} ${lead.last_name || ""}`.trim() : "Customer";

  const BILLING_BCC = "billing@theworkvilla.com";

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
        <p style="color:#333;font-size:14px;">${introSentence}</p>
        <table style="width:100%;border-collapse:collapse;margin:16px 0;font-size:13px;">
          <tr><td style="padding:6px 0;color:#666;">Proforma Ref</td><td style="padding:6px 0;font-weight:600;">${proformaRef}</td></tr>
          <tr><td style="padding:6px 0;color:#666;">${contract ? "Contract" : "Proposal Ref"}</td><td style="padding:6px 0;">${partyRef}</td></tr>
          <tr><td style="padding:6px 0;color:#666;">Period</td><td style="padding:6px 0;">${periodLabel}</td></tr>
          ${dueDateStr ? `<tr><td style="padding:6px 0;color:#666;">Payment Due By</td><td style="padding:6px 0;font-weight:600;color:#b45309;">${dueDateStr}</td></tr>` : ""}
          <tr><td style="padding:6px 0;color:#666;">Amount Due</td><td style="padding:6px 0;font-weight:600;color:#015E65;font-size:16px;">Rs. ${Math.round(totalAmount).toLocaleString("en-IN", { maximumFractionDigits: 0 })}</td></tr>
        </table>
        ${paymentOptionsHtml}
        <div style="text-align:center;margin:24px 0 12px;">
          <a href="${proformaTrackingUrl}" style="background:#f0faf5;color:#015E65;padding:10px 24px;text-decoration:none;border-radius:8px;font-weight:bold;display:inline-block;font-size:13px;border:1px solid #015E65;">View Invoice Online</a>
        </div>
        ${razorpayLinkUrl ? `
        <div style="text-align:center;margin:12px 0;">
          <a href="${razorpayLinkUrl}" style="background:#015E65;color:white;padding:12px 32px;text-decoration:none;border-radius:8px;font-weight:bold;display:inline-block;font-size:14px;">Pay Now</a>
          <p style="color:#888;font-size:11px;margin:8px 0 0;">This payment link is valid for 15 days. If expired, please contact us to regenerate a new link.</p>
        </div>` : ""}
        <p style="color:#333;font-size:14px;margin-top:24px;">Warm regards,<br/><strong>The WorkVilla</strong></p>
        <div style="background:#fff8e1;border:1px solid #ffe082;border-radius:6px;padding:10px 16px;margin-top:24px;font-size:11px;color:#5d4037;">
          ⚠️ This is a proforma invoice for payment purposes only. A formal GST tax invoice will be issued once payment is confirmed.
        </div>
      </div>
      <div style="background:#015E65;padding:12px 32px;text-align:center;">
        <p style="color:#fff;margin:0;font-size:10px;">SREE DESIGN INFRASTRUCTURE PVT LTD</p>
        <p style="color:rgba(255,255,255,0.6);margin:4px 0 0;font-size:9px;">Prakash Presidium, 110, MG Road, Nungambakkam, Chennai - 600034 | GSTIN: 33AAACU4245J1ZF</p>
      </div>
    </div>
  `;

  const now = new Date().toISOString();
  let emailedSuccessfully = false;
  let emailError: string | null = null;
  const emailSubject = `Proforma Invoice ${proformaRef} — ${partyRef} — The WorkVilla`;

  if (toList.length > 0) {
    try {
      const ccList = additionalCc.filter(Boolean);
      await withTimeout(
        resend.emails.send({
          from: EMAIL_FROM,
          replyTo: EMAIL_REPLY_TO,
          to: toList,
          cc: ccList.length > 0 ? ccList : undefined,
          bcc: BILLING_BCC,
          subject: emailSubject,
          html: emailHtml,
          attachments: [{ filename: `Proforma-${proformaRef.replace(/\//g, "-")}.pdf`, content: pdfBuffer, contentType: "application/pdf" }],
        }),
        EMAIL_TIMEOUT_MS,
        "Resend email send",
      );
      emailedSuccessfully = true;
    } catch (err) {
      emailError = err instanceof Error ? err.message : "Email send failed";
      console.error("[send-proforma] Email failed:", err);
    }
  }

  let commLogEntry: CommunicationLogEntry | null = null;
  if (toList.length > 0) {
    commLogEntry = await logCommunication(adminSupabase, {
      entityType: "billing_statement",
      entityId: statementId,
      channel: "email",
      recipient: toList.join(", "),
      subject: emailSubject,
      body: emailHtml,
      attachmentUrl: storagePath,
      attachmentName: `Proforma-${proformaRef.replace(/\//g, "-")}.pdf`,
      status: emailedSuccessfully ? "sent" : "failed",
      errorMessage: emailError,
      sentBy: dispatchedBy,
    });
  }

  // The proforma is only "sent" when a channel actually delivered something the
  // client can act on: an email reached them, OR a payment link exists to share.
  // If neither (no contact, or every channel failed), leave proforma_sent_at NULL
  // so the UI shows "No Contact Info" / "Dispatch Failed" instead of a false
  // green "Proforma Sent", and so the rent generator does not advance a quarterly anchor.
  const delivered = emailedSuccessfully || Boolean(razorpayLinkUrl);

  // ── Update statement ──────────────────────────────────────────────────────
  const updatePayload: Record<string, unknown> = {
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
  if (delivered) updatePayload.proforma_sent_at = now;
  if (delivered) updatePayload.due_date = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  if (delivered && dispatchedBy) updatePayload.proforma_sent_by = dispatchedBy;
  if (razorpayLinkId) updatePayload.razorpay_payment_link_id = razorpayLinkId;
  if (razorpayLinkUrl) updatePayload.razorpay_payment_link_url = razorpayLinkUrl;

  await adminSupabase.from("billing_statements").update(updatePayload).eq("id", statementId);

  if (dispatchedBy) {
    logAudit(adminSupabase, {
      entityType: "billing_statement",
      entityId: statementId,
      action: "update",
      performedBy: dispatchedBy,
      changes: {
        proforma_sent_at: { old: null, new: delivered ? now : null },
        razorpay_payment_link_url: { old: null, new: razorpayLinkUrl || null },
        emailed_to: { old: null, new: emailedSuccessfully ? (customerEmail || null) : null },
      },
    });
  }

  if (toList.length > 0) {
    await adminSupabase.from("billing_send_log").insert(
      toList.map((recipient) => ({
        billing_statement_id: statementId,
        send_type: "proforma" as const,
        recipient,
        status: emailedSuccessfully ? ("sent" as const) : ("failed" as const),
        triggered_by: dispatchedBy ? ("manual" as const) : ("cron" as const),
        triggered_by_user_id: dispatchedBy || null,
      })),
    );
  }

  return {
    success: true,
    proformaRef,
    totalAmount,
    razorpayLinkUrl,
    emailedTo: emailedSuccessfully ? (toList.join(", ") || null) : null,
    emailSkipped: toList.length === 0,
    noContact,
    pdfStoragePath: storagePath,
    commLogEntry,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// dispatchGstDirect — GST Direct billing mode
//
// Skips the proforma step entirely. Issues a GST tax invoice directly on the
// first dispatch (either the auto-run for rent or the manual Verify & Send for
// usage). Due date = period_start + 7 for rent, today + 7 for usage.
// ─────────────────────────────────────────────────────────────────────────────

export async function dispatchGstDirect(
  adminSupabase: SupabaseClient,
  statementId: string,
  dispatchedBy: string | null = null,
  additionalCc: string[] = [],
  toOverride: string[] = [],
): Promise<DispatchResult> {
  // ── Fetch statement with contract + lead ──────────────────────────────────
  const { data: statement, error: fetchErr } = await adminSupabase
    .from("billing_statements")
    .select(`
      *,
      contract:contracts!billing_statements_contract_id_fkey(
        id, contract_number, title, total_amount, subtotal, tax_percentage,
        start_date, end_date, billing_cycle, location_id, items,
        lead:leads!contracts_lead_id_fkey(id, first_name, last_name, company, email, phone, state, gst_number, mobile, billing_emails)
      ),
      usage_charges:usage_charges(id, description, quantity, unit_price, total, is_waived, hsn_sac_code)
    `)
    .eq("id", statementId)
    .single();

  if (fetchErr || !statement) {
    return { success: false, proformaRef: "", totalAmount: 0, razorpayLinkUrl: null, emailedTo: null, emailSkipped: true, noContact: false, error: "Statement not found" };
  }

  // On hold — something on this statement is being clarified/corrected.
  // Blocks send only; the draft itself stays editable elsewhere.
  if (statement.held_at) {
    return { success: false, proformaRef: "", totalAmount: 0, razorpayLinkUrl: null, emailedTo: null, emailSkipped: true, noContact: false, error: `Statement is on hold: ${statement.hold_reason}` };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const contract = statement.contract as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const lead = contract?.lead as any;
  if (!contract) {
    return { success: false, proformaRef: "", totalAmount: 0, razorpayLinkUrl: null, emailedTo: null, emailSkipped: true, noContact: false, error: "No contract linked" };
  }

  const customerEmail = lead?.email as string | undefined;
  const customerPhone = (lead?.phone || lead?.mobile) as string | undefined;
  const noContact = !customerEmail && !customerPhone;
  const billingEmails = (lead?.billing_emails as string[] | null) ?? [];
  const toList = toOverride.length > 0
    ? Array.from(new Set(toOverride.filter(Boolean)))
    : Array.from(new Set([customerEmail, ...billingEmails].filter((e): e is string => Boolean(e))));

  // ── Tally routing gate (surgical swap point #1) ───────────────────────────
  // If Tally GST issuance is active, hand the GST invoice to Tally: stamp the
  // statement issuance_channel='tally', enqueue the sales_voucher job, and STOP
  // here — the bridge mints the invoice number, then dispatchTallyInvoice (the
  // ack path) sends the PDF + Razorpay link. We must NOT mint a CRM gst number
  // or send anything from this path, or the customer gets two invoices.
  if (await routeGstGenerationToTally(statementId)) {
    return {
      success: true,
      proformaRef: statement.statement_number as string,
      totalAmount: 0,           // computed by Tally; mirrored back on ack
      razorpayLinkUrl: null,    // dispatchTallyInvoice creates the link after issuance
      emailedTo: null,
      emailSkipped: true,       // delivery deferred to dispatchTallyInvoice
      noContact,
      routedToTally: true,
    };
  }

  // ── Standby gate: CRM GST off → no invoice issued, queued for later ────────
  if (!(await isCrmGstEnabled(adminSupabase))) {
    return {
      success: true,
      proformaRef: statement.statement_number as string,
      totalAmount: 0,
      razorpayLinkUrl: null,
      emailedTo: null,
      emailSkipped: true,
      noContact,
      standby: true,
    };
  }

  // ── Totals — derive from the structured line_items sections (the same
  // data the table below is built from) so the totals box can never drift
  // from what's printed. Falls back to the legacy per-field sum only for
  // statements predating the structured line_items JSONB. ───────────────────
  // Ad-hoc charges are the one exception — see dispatchProforma's matching
  // comment above: add-charge/waive-charge never update this frozen
  // snapshot, so the live usage_charges table (filtered to non-waived) is
  // the source of truth for that section specifically.
  const usageCharges = ((statement.usage_charges || []) as { description: string; quantity: number; unit_price: number; total: number; is_waived: boolean }[])
    .filter((c) => !c.is_waived);
  const usageAmount = usageCharges.reduce((s: number, c: { total: number }) => s + Number(c.total || 0), 0);
  const fixedAmount = Number(statement.fixed_amount || 0);
  const serviceUsageAmount = Number(statement.service_usage_amount || 0);
  const bookingUsageAmount = Number(statement.booking_usage_amount || 0);
  const structuredSections = (statement.line_items || []) as Array<{
    type: string; label: string; items: Record<string, unknown>[]; subtotal: number
  }>;
  const nonAdHocSections = structuredSections.filter((sec) => sec.type !== "ad_hoc_charges");
  const subtotal = structuredSections.length > 0
    ? nonAdHocSections.reduce((s, sec) => s + Number(sec.subtotal || 0), 0) + usageAmount
    : fixedAmount + usageAmount + serviceUsageAmount + bookingUsageAmount;
  const taxPercentage = Number(statement.tax_percentage || 18);
  const isInterstate = false;
  const { cgst, sgst, igst, taxAmount, totalAmount } = computeGstAndRounding(subtotal, taxPercentage);
  const stmtRef = statement.statement_number as string;

  // ── Due date: rent = period_start + 7, usage = today + 7 ─────────────────
  const isRent = (statement.statement_type as string) === "rent";
  const issueDateYmd = isRent
    ? (statement.period_start as string)
    : new Date().toISOString().slice(0, 10);
  const [iy, im, id2] = issueDateYmd.split("-").map(Number);
  const dueDate = new Date(Date.UTC(iy, im - 1, id2 + 7)).toISOString().slice(0, 10);

  // ── Generate GST invoice number ───────────────────────────────────────────
  const now = new Date();
  const fyStart = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
  const fyEnd = fyStart + 1;
  const fyPrefix = `TWV/INV/${String(fyStart).slice(-2)}-${String(fyEnd).slice(-2)}/`;

  const { count: existingCount } = await adminSupabase
    .from("billing_statements")
    .select("id", { count: "exact", head: true })
    .like("gst_invoice_number", `${fyPrefix}%`);
  const seqNum = (existingCount || 0) + 1;
  const invoiceNumber = `${fyPrefix}${String(seqNum).padStart(4, "0")}`;

  // ── Fetch UPI ID and Razorpay keys from app_settings (single cached call) ─
  const appSettings = await getCachedSettings(adminSupabase, [
    "upi_id",
    "razorpay_key_id",
    "razorpay_key_secret",
    "razorpay_enabled",
  ]);
  const upiId = appSettings["upi_id"] ?? undefined;
  const rzpKeyId = appSettings["razorpay_key_id"];
  const rzpKeySecret = appSettings["razorpay_key_secret"];
  const rzpEnabled = appSettings["razorpay_enabled"] === "true";

  // ── Razorpay payment link ────────────────────────────────────────────────
  let razorpayLinkId: string | null = null;
  let razorpayLinkUrl: string | null = null;
  try {
    if (rzpEnabled && rzpKeyId && rzpKeySecret) {
      const auth = Buffer.from(`${rzpKeyId}:${rzpKeySecret}`).toString("base64");
      const appUrl = (process.env.NEXT_PUBLIC_APP_URL || "https://twv-crm.vercel.app").trim();
      const customerName = lead ? `${lead.first_name || ""} ${lead.last_name || ""}`.trim() : "Customer";
      const refId = `${invoiceNumber.replace(/[^a-zA-Z0-9_-]/g, "-")}-gst`;
      const payload: Record<string, unknown> = {
        amount: Math.round(totalAmount * 100),
        currency: "INR",
        description: `Tax Invoice ${invoiceNumber} — ${contract.contract_number} — The WorkVilla`,
        reference_id: refId,
        expire_by: Math.floor(Date.now() / 1000) + RAZORPAY_MAX_LINK_VALIDITY_SECONDS,
        notify: { sms: !!customerPhone, email: !!customerEmail },
        reminder_enable: true,
        notes: { statement_id: statementId, contract_number: contract.contract_number, gst_invoice: "true" },
        callback_url: `${appUrl}/billing`,
        callback_method: "get",
      };
      if (customerName || customerEmail || customerPhone) {
        payload.customer = {} as Record<string, string>;
        if (customerName) (payload.customer as Record<string, string>).name = customerName;
        if (customerEmail) (payload.customer as Record<string, string>).email = customerEmail;
        if (customerPhone) (payload.customer as Record<string, string>).contact = customerPhone.replace(/\s/g, "");
      }
      const rzpRes = await withTimeout(
        fetch("https://api.razorpay.com/v1/payment_links", {
          method: "POST",
          headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        }),
        RAZORPAY_TIMEOUT_MS, "Razorpay GST direct link",
      );
      if (rzpRes.ok) {
        const linkData = await rzpRes.json();
        razorpayLinkId = linkData.id;
        razorpayLinkUrl = linkData.short_url;
      } else {
        console.error("[gst-direct] Razorpay link failed:", await rzpRes.json().catch(() => ({})));
      }
    }
  } catch (err) {
    console.error("[gst-direct] Razorpay error:", err);
  }

  // ── Build PDF line items ──────────────────────────────────────────────────
  const lineItems: GstInvoiceData["lineItems"] = [];
  if (structuredSections.length > 0) {
    for (const section of nonAdHocSections) {
      for (const item of section.items) {
        const desc = item.description || item.booking_number || section.label;
        let label = String(desc);
        if (section.type === "booking_usage" && item.date) {
          label = [String(item.date), item.space ? String(item.space) : "", item.time ? String(item.time) : "", item.duration ? String(item.duration) : ""].filter(Boolean).join(" · ");
        }
        lineItems.push({ description: withProrationBreakdown(label || section.label, item), hsnSac: "997212", qty: resolveLineItemQty(item, "gst-direct"), rate: resolveLineItemRate(item), amount: Number(item.amount || 0) });
      }
    }
  } else if (fixedAmount > 0) {
    lineItems.push({ description: contract.title || `Workspace — ${contract.contract_number}`, hsnSac: "997212", qty: 1, rate: fixedAmount, amount: fixedAmount });
  }
  for (const charge of usageCharges) lineItems.push({ description: charge.description, hsnSac: "997212", qty: Number(charge.quantity || 1), rate: Number(charge.unit_price), amount: Number(charge.total) });

  // ── Generate PDF (actual GST invoice, not proforma) ───────────────────────
  let razorpayQrBase64: string | undefined;
  if (razorpayLinkUrl) {
    try { razorpayQrBase64 = await QRCode.toDataURL(razorpayLinkUrl, { width: 200, margin: 1, errorCorrectionLevel: "M" }); } catch { /* skip */ }
  }

  // Customer-facing proof attached at bill-customer time — appended as extra
  // pages after the PDF is generated below (see mergeSupportingDocuments).
  const supportingDocs = (statement.statement_type as string) === "reimbursement"
    ? await fetchSupportingDocuments(adminSupabase, statement.id as string)
    : [];

  const invoiceData: GstInvoiceData = {
    invoiceNumber,
    invoiceDate: issueDateYmd,
    isProforma: false,
    // Reimbursement GST-direct invoices collapse to Description | Amount, same
    // as the proforma and on-demand PDF paths for this statement type.
    compactLineItems: (statement.statement_type as string) === "reimbursement",
    buyerName: lead?.company || `${lead?.first_name || ""} ${lead?.last_name || ""}`.trim() || "Customer",
    buyerGstin: lead?.gst_number || undefined,
    buyerState: lead?.state || undefined,
    periodStart: statement.period_start as string,
    periodEnd: statement.period_end as string,
    dueDate,
    contractNumber: contract.contract_number,
    poNumber: statement.po_number as string | null,
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
    razorpayExpiry: undefined,
    supportingDocsCount: supportingDocs.length || undefined,
  };
  const doc = generateGstInvoicePDF(invoiceData);
  let pdfBuffer = Buffer.from(doc.output("arraybuffer"));
  if (supportingDocs.length > 0) {
    pdfBuffer = await mergeSupportingDocuments(adminSupabase, pdfBuffer, supportingDocs);
  }

  const storagePath = `gst-invoices/${invoiceNumber.replace(/\//g, "-")}.pdf`;
  await adminSupabase.storage.from("crm-documents").upload(storagePath, pdfBuffer, { contentType: "application/pdf", upsert: true });

  // Get public URL for the PDF
  const { data: publicUrlData } = adminSupabase.storage.from("crm-documents").getPublicUrl(storagePath);
  const gstInvoicePath = publicUrlData?.publicUrl || null;

  // ── Email ─────────────────────────────────────────────────────────────────
  const periodLabel = new Date((statement.period_start as string) + "T00:00:00").toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", month: "short", year: "numeric" });
  const dueDateStr = new Date(dueDate + "T00:00:00").toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric" });
  const customerName = lead ? `${lead.first_name || ""} ${lead.last_name || ""}`.trim() : "Customer";

  const BILLING_BCC = "billing@theworkvilla.com";

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
        <p style="color:#333;font-size:14px;">Please find attached your tax invoice for <strong>${periodLabel}</strong>. Kindly make the payment by the due date.</p>
        <table style="width:100%;border-collapse:collapse;margin:16px 0;font-size:13px;">
          <tr><td style="padding:6px 0;color:#666;">Invoice No.</td><td style="padding:6px 0;font-weight:600;">${invoiceNumber}</td></tr>
          <tr><td style="padding:6px 0;color:#666;">Contract</td><td style="padding:6px 0;">${contract.contract_number}</td></tr>
          <tr><td style="padding:6px 0;color:#666;">Period</td><td style="padding:6px 0;">${periodLabel}</td></tr>
          <tr><td style="padding:6px 0;color:#666;">Due By</td><td style="padding:6px 0;font-weight:600;color:#b45309;">${dueDateStr}</td></tr>
          <tr><td style="padding:6px 0;color:#666;">Amount Due</td><td style="padding:6px 0;font-weight:600;color:#015E65;font-size:16px;">Rs. ${Math.round(totalAmount).toLocaleString("en-IN", { maximumFractionDigits: 0 })}</td></tr>
        </table>
        ${paymentOptionsHtml}
        ${razorpayLinkUrl ? `<div style="text-align:center;margin:24px 0;"><a href="${razorpayLinkUrl}" style="background:#015E65;color:white;padding:12px 32px;text-decoration:none;border-radius:8px;font-weight:bold;display:inline-block;font-size:14px;">Pay Now</a><p style="color:#888;font-size:11px;margin:8px 0 0;">This payment link is valid for 15 days. If expired, please contact us to regenerate a new link.</p></div>` : ""}
        <p style="color:#333;font-size:14px;margin-top:24px;">Warm regards,<br/><strong>The WorkVilla</strong></p>
      </div>
      <div style="background:#015E65;padding:12px 32px;text-align:center;">
        <p style="color:#fff;margin:0;font-size:10px;">SREE DESIGN INFRASTRUCTURE PVT LTD</p>
        <p style="color:rgba(255,255,255,0.6);margin:4px 0 0;font-size:9px;">Prakash Presidium, 110, MG Road, Nungambakkam, Chennai - 600034 | GSTIN: 33AAACU4245J1ZF</p>
      </div>
    </div>
  `;

  const nowIso = new Date().toISOString();
  let emailedSuccessfully = false;
  let emailError: string | null = null;
  const emailSubject = `Tax Invoice ${invoiceNumber} — ${contract.contract_number} — The WorkVilla`;
  if (toList.length > 0) {
    try {
      const ccList = additionalCc.filter(Boolean);
      await withTimeout(
        resend.emails.send({
          from: EMAIL_FROM,
          replyTo: EMAIL_REPLY_TO,
          to: toList,
          cc: ccList.length > 0 ? ccList : undefined,
          bcc: BILLING_BCC,
          subject: emailSubject,
          html: emailHtml,
          attachments: [{ filename: `Invoice-${invoiceNumber.replace(/\//g, "-")}.pdf`, content: pdfBuffer, contentType: "application/pdf" }],
        }),
        EMAIL_TIMEOUT_MS, "Resend GST direct email",
      );
      emailedSuccessfully = true;
    } catch (err) {
      emailError = err instanceof Error ? err.message : "Email send failed";
      console.error("[gst-direct] Email failed:", err);
    }
  }

  let commLogEntry: CommunicationLogEntry | null = null;
  if (toList.length > 0) {
    commLogEntry = await logCommunication(adminSupabase, {
      entityType: "billing_statement",
      entityId: statementId,
      channel: "email",
      recipient: toList.join(", "),
      subject: emailSubject,
      body: emailHtml,
      attachmentUrl: storagePath,
      attachmentName: `Invoice-${invoiceNumber.replace(/\//g, "-")}.pdf`,
      status: emailedSuccessfully ? "sent" : "failed",
      errorMessage: emailError,
      sentBy: dispatchedBy,
    });
  }

  const delivered = emailedSuccessfully || Boolean(razorpayLinkUrl);

  // ── Update statement — mark as GST-issued directly ────────────────────────
  const updatePayload: Record<string, unknown> = {
    subtotal,
    usage_amount: usageAmount,
    tax_amount: taxAmount,
    total_amount: totalAmount,
    cgst_amount: cgst,
    sgst_amount: sgst,
    igst_amount: igst,
    is_interstate: isInterstate,
    buyer_gstin: lead?.gst_number || null,
    due_date: dueDate,
    gst_invoice_number: invoiceNumber,
    gst_invoice_date: issueDateYmd,
    gst_invoice_path: gstInvoicePath,
  };
  if (razorpayLinkId) updatePayload.razorpay_payment_link_id = razorpayLinkId;
  if (razorpayLinkUrl) updatePayload.razorpay_payment_link_url = razorpayLinkUrl;
  if (delivered) updatePayload.emailed_at = nowIso;

  await adminSupabase.from("billing_statements").update(updatePayload).eq("id", statementId);

  if (dispatchedBy) {
    logAudit(adminSupabase, {
      entityType: "billing_statement",
      entityId: statementId,
      action: "update",
      performedBy: dispatchedBy,
      changes: {
        gst_invoice_number: { old: null, new: invoiceNumber },
        due_date: { old: null, new: dueDate },
        billing_mode: { old: null, new: "gst_direct" },
      },
    });
  }

  if (toList.length > 0) {
    await adminSupabase.from("billing_send_log").insert(
      toList.map((recipient) => ({
        billing_statement_id: statementId,
        send_type: "gst_invoice" as const,
        recipient,
        status: emailedSuccessfully ? ("sent" as const) : ("failed" as const),
        triggered_by: dispatchedBy ? ("manual" as const) : ("cron" as const),
        triggered_by_user_id: dispatchedBy || null,
      })),
    );
  }

  return {
    success: true,
    proformaRef: stmtRef,
    totalAmount,
    razorpayLinkUrl,
    emailedTo: emailedSuccessfully ? (toList.join(", ") || null) : null,
    emailSkipped: toList.length === 0,
    noContact,
    commLogEntry,
  };
}
