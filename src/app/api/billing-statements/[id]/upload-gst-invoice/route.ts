import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { normalizeUploadServer, UploadValidationError } from "@/lib/uploads/normalize-upload-server";
import { stampSignatureOnPdf } from "@/lib/uploads/stamp-pdf-signature";
import { isHandoffV2Enabled, setHandoffState } from "@/lib/tally-handoff-server";
import { resend, EMAIL_FROM, EMAIL_REPLY_TO } from "@/lib/mailer";
import { COMPANY_BANK_DETAILS } from "@/lib/constants";

/**
 * POST /api/billing-statements/[id]/upload-gst-invoice
 *
 * Accounts uploads the Tally GST invoice PDF for a statement that's in the
 * inbox. The endpoint:
 *   1. Validates the upload body (series + IRN rule, amount equality, mandatory fields)
 *   2. Stores the PDF in Supabase Storage (crm-documents bucket)
 *   3. Inserts a gst_invoice_uploads row (DB-level CHECK reinforces series-IRN pair)
 *   4. Mirrors number/IRN onto billing_statements (gst_invoice_number,
 *      tally_invoice_number, issuance_channel='tally')
 *   5. Transitions handoff_state to ready_to_send OR name_check_pending
 *   6. For unpaid statements going to ready_to_send: creates a Razorpay payment
 *      link and emails the invoice to the customer (To: customer,
 *      BCC: billing@theworkvilla.com, Reply-To: billing@theworkvilla.com)
 *
 * Hard-block rules (see docs/tally-handoff-redesign.md §8E):
 *   - Amount on PDF ≠ statement total → 422, no upload row inserted
 *   - A-series upload with wrong-length IRN → 422 (IRN itself is optional)
 *   - B-series upload with IRN → 422
 *   - Customer has GSTIN but B-series uploaded → 422
 *   - Customer has no GSTIN but A-series uploaded → 422
 */
export const dynamic = "force-dynamic";

interface UploadBody {
  tally_invoice_number: string;
  tally_invoice_series: "SDIPL-REG" | "SDIPL-UNREG";
  irn: string | null;
  invoice_date: string;
  invoice_amount: number;
  party_name_matches_contract: boolean;
  autofill_source: "qr" | "pdf_text" | "bridge_match" | "manual";
  qr_payload: Record<string, unknown> | null;
  nic_signature_verified: boolean;
}

function badRequest(reason: string) {
  return NextResponse.json({ error: reason }, { status: 422 });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const supabase = await createClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users")
    .select("id, role")
    .eq("auth_id", user.id)
    .maybeSingle();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 404 });
  if (!["accounts", "admin"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const adminClient = await createAdminClient();
  if (!(await isHandoffV2Enabled(adminClient))) {
    return NextResponse.json(
      { error: "Tally handoff v2 is not enabled. Enable the feature flag first." },
      { status: 409 },
    );
  }

  // ── Parse multipart form ─────────────────────────────────────────────────
  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return badRequest("Could not parse upload");
  }

  const file = formData.get("file") as File | null;
  const metaRaw = formData.get("meta") as string | null;
  if (!file) return badRequest("No file provided");
  if (!metaRaw) return badRequest("No upload metadata provided");

  let meta: UploadBody;
  try {
    meta = JSON.parse(metaRaw) as UploadBody;
  } catch {
    return badRequest("Invalid meta JSON");
  }

  // Normalise: empty-string IRN must become null so the DB CHECK passes.
  if (!meta.irn?.trim()) meta.irn = null;

  // ── Fetch the statement + contract + lead ────────────────────────────────
  const { data: statementRow, error: fetchErr } = await supabase
    .from("billing_statements")
    .select(`
      id, total_amount, payment_status, handoff_state, issuance_channel,
      statement_number, period_start, period_end,
      contract:contracts!billing_statements_contract_id_fkey(
        id, billing_mode, contract_number,
        lead:leads!contracts_lead_id_fkey(id, gst_number, first_name, last_name, company, email, billing_emails, mobile, phone)
      ),
      proposal:proposals!billing_statements_proposal_id_fkey(
        id, proposal_number,
        lead:leads!proposals_lead_id_fkey(id, gst_number, first_name, last_name, company, email, billing_emails, mobile, phone)
      ),
      invoice:proforma_invoices!billing_statements_invoice_id_fkey(
        id, invoice_number,
        lead:leads!proforma_invoices_lead_id_fkey(id, gst_number, first_name, last_name, company, email, billing_emails, mobile, phone)
      ),
      case:cases!billing_statements_case_id_fkey(
        id, case_number, bill_to, client_name, client_company_name, client_email, client_phone, client_gst_number,
        aggregator:aggregators!cases_aggregator_id_fkey(id, name, primary_email, primary_phone, gst_number)
      ),
      aggregator:aggregators!billing_statements_aggregator_id_fkey(id, name, primary_email, primary_phone, gst_number)
    `)
    .eq("id", id)
    .maybeSingle();

  if (fetchErr || !statementRow) {
    return NextResponse.json({ error: "Statement not found" }, { status: 404 });
  }

  const statement = statementRow as unknown as {
    id: string;
    total_amount: number;
    payment_status: string;
    handoff_state: string | null;
    issuance_channel: string | null;
    statement_number: string | null;
    period_start: string | null;
    period_end: string | null;
    contract: {
      id: string;
      billing_mode: "proforma_first" | "gst_direct" | null;
      contract_number: string | null;
      lead: {
        id: string;
        gst_number: string | null;
        first_name: string | null;
        last_name: string | null;
        company: string | null;
        email: string | null;
        billing_emails: string[] | null;
        mobile: string | null;
        phone: string | null;
      } | null;
    } | null;
    proposal: {
      id: string;
      proposal_number: string | null;
      lead: {
        id: string;
        gst_number: string | null;
        first_name: string | null;
        last_name: string | null;
        company: string | null;
        email: string | null;
        billing_emails: string[] | null;
        mobile: string | null;
        phone: string | null;
      } | null;
    } | null;
    invoice: {
      id: string;
      invoice_number: string | null;
      lead: {
        id: string;
        gst_number: string | null;
        first_name: string | null;
        last_name: string | null;
        company: string | null;
        email: string | null;
        billing_emails: string[] | null;
        mobile: string | null;
        phone: string | null;
      } | null;
    } | null;
    case: {
      id: string;
      case_number: string;
      bill_to: "aggregator" | "client" | null;
      client_name: string;
      client_company_name: string | null;
      client_email: string | null;
      client_phone: string | null;
      client_gst_number: string | null;
      aggregator: { id: string; name: string; primary_email: string | null; primary_phone: string | null; gst_number: string | null } | null;
    } | null;
    aggregator: { id: string; name: string; primary_email: string | null; primary_phone: string | null; gst_number: string | null } | null;
  };

  /** Synthesizes the same lead-like shape (email/company/name/mobile/gst_number)
   *  used elsewhere in this route from a VO case or aggregator-consolidated
   *  statement, so the rest of the function doesn't need a branch per source. */
  function leadFromVoSource(s: typeof statement) {
    if (s.case) {
      const billToAggregator = s.case.bill_to === "aggregator" ? s.case.aggregator : null;
      if (billToAggregator) {
        return {
          id: billToAggregator.id, gst_number: billToAggregator.gst_number,
          first_name: null, last_name: null, company: billToAggregator.name,
          email: billToAggregator.primary_email, billing_emails: null,
          mobile: billToAggregator.primary_phone, phone: null,
        };
      }
      return {
        id: s.case.id, gst_number: s.case.client_gst_number,
        first_name: null, last_name: null, company: s.case.client_company_name || s.case.client_name,
        email: s.case.client_email, billing_emails: null,
        mobile: s.case.client_phone, phone: null,
      };
    }
    if (s.aggregator) {
      return {
        id: s.aggregator.id, gst_number: s.aggregator.gst_number,
        first_name: null, last_name: null, company: s.aggregator.name,
        email: s.aggregator.primary_email, billing_emails: null,
        mobile: s.aggregator.primary_phone, phone: null,
      };
    }
    return null;
  }

  const partyId = statement.contract?.id ?? statement.proposal?.id ?? statement.invoice?.id ?? statement.case?.id ?? statement.aggregator?.id ?? "unknown";
  const partyRef = statement.contract?.contract_number ?? statement.proposal?.proposal_number ?? statement.invoice?.invoice_number ?? statement.case?.case_number ?? statement.aggregator?.name ?? "";
  const partyLead = statement.contract?.lead ?? statement.proposal?.lead ?? statement.invoice?.lead ?? leadFromVoSource(statement);

  // ── Hard-block rules ──────────────────────────────────────────────────────
  // Compare at whole-rupee level — Razorpay collects in paise and the stored
  // amount may differ by a few paise from the rounded GST invoice amount
  // (GST invoices in Tally are always whole rupees).
  if (Math.round(Number(meta.invoice_amount)) !== Math.round(Number(statement.total_amount))) {
    return badRequest(
      `Tally amount ₹${meta.invoice_amount} does not match statement total ₹${statement.total_amount}. ` +
      `Fix the Tally voucher or void+reissue the statement; no override is allowed.`,
    );
  }

  const customerHasGstin = !!partyLead?.gst_number;

  if (customerHasGstin && meta.tally_invoice_series !== "SDIPL-REG") {
    return badRequest(
      "Customer has GSTIN in CRM — must use A-series (SDIPL-REG) invoice with IRN.",
    );
  }
  if (!customerHasGstin && meta.tally_invoice_series !== "SDIPL-UNREG") {
    return badRequest(
      "Customer has no GSTIN in CRM — must use B-series (SDIPL-UNREG) invoice without IRN.",
    );
  }

  if (meta.tally_invoice_series === "SDIPL-REG") {
    // IRN is optional (autofill may fail for system-generated PDFs where IRN
    // is only embedded in the QR code). If present, it must be 64 chars.
    if (meta.irn && meta.irn.length !== 64) {
      return badRequest("IRN must be exactly 64 characters if provided.");
    }
  } else {
    if (meta.irn) {
      return badRequest("B-series invoices must NOT carry an IRN.");
    }
  }

  // Series-vs-prefix sanity (A-series number must start with SD/A/…, etc.)
  const expectedPrefix = meta.tally_invoice_series === "SDIPL-REG" ? "SD/A/" : "SD/B/";
  if (!meta.tally_invoice_number.startsWith(expectedPrefix)) {
    return badRequest(
      `Invoice number "${meta.tally_invoice_number}" does not match expected ${expectedPrefix}* prefix for series ${meta.tally_invoice_series}.`,
    );
  }

  // ── Normalize + upload the PDF ────────────────────────────────────────────
  const allowedTypes = ["application/pdf", "image/jpeg", "image/png"];
  if (!allowedTypes.includes(file.type)) {
    return badRequest("Only PDF / JPEG / PNG files are allowed.");
  }

  let normalized: { buffer: Buffer; mimeType: string; ext: string };
  try {
    normalized = await normalizeUploadServer(file);
  } catch (err) {
    if (err instanceof UploadValidationError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }

  if (normalized.mimeType === "application/pdf") {
    normalized.buffer = await stampSignatureOnPdf(normalized.buffer);
  }

  const timestamp = Date.now();
  const safeNumber = meta.tally_invoice_number.replace(/[^\w-]/g, "_");
  const filePath = `tally-handoff/${partyId}/${timestamp}-${safeNumber}.${normalized.ext}`;

  const { error: uploadError } = await supabase.storage
    .from("crm-documents")
    .upload(filePath, normalized.buffer, { contentType: normalized.mimeType });

  if (uploadError) {
    return NextResponse.json({ error: `Upload failed: ${uploadError.message}` }, { status: 500 });
  }

  // ── Insert gst_invoice_uploads row ────────────────────────────────────────
  const { data: insertedUpload, error: insertErr } = await supabase
    .from("gst_invoice_uploads")
    .insert({
      billing_statement_id: statement.id,
      uploaded_by: dbUser.id,
      tally_invoice_number: meta.tally_invoice_number,
      tally_invoice_series: meta.tally_invoice_series,
      irn: meta.irn,
      invoice_date: meta.invoice_date,
      invoice_amount: meta.invoice_amount,
      invoice_pdf_url: filePath,
      qr_payload: meta.qr_payload,
      autofill_source: meta.autofill_source,
      nic_signature_verified: meta.nic_signature_verified,
      name_check_status: "approved",
      name_check_decided_by: dbUser.id,
      name_check_decided_at: new Date().toISOString(),
    })
    .select("id")
    .single();

  if (insertErr) {
    return NextResponse.json({ error: insertErr.message }, { status: 500 });
  }

  // ── Mirror onto billing_statements + stamp issuance_channel='tally' ───────
  // D2 (decide once): once stamped, CRM will refuse to generate its own GST invoice.
  // Must use adminClient — accounts role RLS does not permit updating gst_invoice_number.
  // Fix #6 (ported from booking-gst-tasks/upload-gst-invoice): check the error —
  // this update was previously unchecked and silently failing on every call because
  // it referenced tally_total_amount, a column that only exists on booking_gst_tasks,
  // not billing_statements. The invoice amount is already validated equal to
  // statement.total_amount above, so there's nothing new to mirror there.
  const { error: mirrorErr } = await adminClient
    .from("billing_statements")
    .update({
      gst_invoice_number: meta.tally_invoice_number,
      tally_invoice_number: meta.tally_invoice_number,
      issuance_channel: "tally",
      tally_sync_status: "issued",
    })
    .eq("id", statement.id);

  if (mirrorErr) {
    return NextResponse.json(
      { error: `Invoice saved (id: ${insertedUpload.id}) but mirroring onto the statement failed: ${mirrorErr.message}. Refresh and check statement state.` },
      { status: 500 },
    );
  }

  // ── Also mirror the GST invoice number onto the linked ad-hoc invoice ─────
  // (proforma_invoices) so it shows on the lead page. The mirror above only
  // updates the accounting-side statement row — nothing previously kept the
  // customer-facing invoice's gst_invoice_number in sync. Non-fatal: the
  // upload itself already succeeded (PDF stored, statement updated); a failure
  // here just means the lead page won't show the GST number until retried.
  if (statement.invoice) {
    const { error: invoiceMirrorErr } = await adminClient
      .from("proforma_invoices")
      .update({ gst_invoice_number: meta.tally_invoice_number })
      .eq("id", statement.invoice.id);
    if (invoiceMirrorErr) {
      console.error("[upload-gst-invoice] proforma_invoices mirror failed (non-fatal):", invoiceMirrorErr);
    }
  }

  // ── Transition handoff_state ─────────────────────────────────────────────
  await setHandoffState(supabase, statement.id, "ready_to_send", "gst_invoice_uploaded");

  // ── Razorpay link + email (unpaid statements reaching ready_to_send) ──────
  // This covers both direct_gst_requested (PI override) and pi_paid flow
  // for unpaid statements. Skipped entirely for already-paid statements.
  if (statement.payment_status !== "paid") {
    const adminSupabase = await createAdminClient();

    const lead = partyLead;
    const customerEmail = lead?.email ?? null;
    const customerName = lead?.company || [lead?.first_name, lead?.last_name].filter(Boolean).join(" ") || "Customer";
    const customerPhone = (lead?.mobile || lead?.phone || "").replace(/\s/g, "");
    const contractNumber = partyRef;
    const invoiceNumber = meta.tally_invoice_number;
    const totalAmount = Number(meta.invoice_amount);

    // ── Fetch Razorpay credentials + UPI ─────────────────────────────────────
    const { data: settingsRows } = await adminSupabase
      .from("app_settings").select("key, value")
      .in("key", ["razorpay_enabled", "razorpay_key_id", "razorpay_key_secret", "upi_id"]);
    const settings = (settingsRows || []).reduce((m: Record<string, string>, r: { key: string; value: string }) => {
      m[r.key] = r.value; return m;
    }, {});
    const rzpEnabled = settings.razorpay_enabled === "true" && !!settings.razorpay_key_id && !!settings.razorpay_key_secret;
    const rzpAuth = rzpEnabled
      ? Buffer.from(`${settings.razorpay_key_id}:${settings.razorpay_key_secret}`).toString("base64")
      : null;
    const upiId = settings.upi_id ?? undefined;

    // ── Create Razorpay payment link ──────────────────────────────────────────
    let rzpLinkId: string | null = null;
    let rzpLinkUrl: string | null = null;
    if (rzpAuth) {
      try {
        const appUrl = (process.env.NEXT_PUBLIC_APP_URL || "https://twv-crm.vercel.app").trim();
        const refId = `${invoiceNumber.replace(/[^a-zA-Z0-9_-]/g, "-")}-gst`;
        const payload: Record<string, unknown> = {
          amount: Math.round(totalAmount * 100),
          currency: "INR",
          description: `Tax Invoice ${invoiceNumber} — ${contractNumber} — The WorkVilla`,
          reference_id: refId,
          expire_by: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
          notify: { sms: !!customerPhone, email: !!customerEmail },
          reminder_enable: true,
          notes: {
            statement_id: id,
            contract_number: contractNumber,
            gst_invoice: invoiceNumber,
          },
          callback_url: `${appUrl}/billing`,
          callback_method: "get",
        };
        if (customerName || customerEmail || customerPhone) {
          payload.customer = {
            ...(customerName ? { name: customerName } : {}),
            ...(customerEmail ? { email: customerEmail } : {}),
            ...(customerPhone ? { contact: customerPhone } : {}),
          };
        }
        const rzpRes = await fetch("https://api.razorpay.com/v1/payment_links", {
          method: "POST",
          headers: { Authorization: `Basic ${rzpAuth}`, "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (rzpRes.ok) {
          const linkData = await rzpRes.json() as { id: string; short_url: string };
          rzpLinkId = linkData.id;
          rzpLinkUrl = linkData.short_url;
        } else {
          console.error("[upload-gst-invoice] Razorpay link failed:", await rzpRes.text());
        }
      } catch (err) {
        console.error("[upload-gst-invoice] Razorpay link threw:", err);
      }
    }

    // ── Download stamped PDF for email attachment ─────────────────────────────
    let pdfAttachment: Buffer | null = null;
    try {
      const { data: pdfData } = await supabase.storage
        .from("crm-documents")
        .download(filePath);
      if (pdfData) {
        pdfAttachment = Buffer.from(await pdfData.arrayBuffer());
      }
    } catch (err) {
      console.error("[upload-gst-invoice] PDF download for attachment failed (non-blocking):", err);
    }

    const nowIso = new Date().toISOString();
    const nowYmd = nowIso.slice(0, 10);

    // ── Persist Razorpay link + due date ─────────────────────────────────────
    // Resetting the ladder alongside due_date is load-bearing, not tidiness:
    // the reminder cron picks a stage from days-overdue against due_date but
    // gates it on reminder_count, so a stale count behind a fresh due date
    // reads as "stage already sent" for every rung already fired and the
    // statement stops being chased until days-overdue catches back up.
    await adminSupabase.from("billing_statements").update({
      razorpay_payment_link_id: rzpLinkId,
      razorpay_payment_link_url: rzpLinkUrl,
      due_date: nowYmd,
      reminder_count: 0,
      last_reminder_sent_at: null,
    }).eq("id", id);

    // ── Send email to customer ────────────────────────────────────────────────
    if (customerEmail) {
      const periodLabel = statement.period_start
        ? new Date(statement.period_start + "T00:00:00").toLocaleDateString("en-IN", {
            timeZone: "Asia/Kolkata", month: "short", year: "numeric",
          })
        : "this period";
      const amountFormatted = Math.round(totalAmount).toLocaleString("en-IN", { maximumFractionDigits: 0 });
      const invoiceDateFormatted = new Date(meta.invoice_date + "T00:00:00").toLocaleDateString("en-IN", {
        timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric",
      });

      const emailHtml = `
        <div style="font-family:sans-serif;max-width:640px;margin:0 auto;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
          <div style="background:#015E65;padding:24px 32px;">
            <h1 style="color:white;margin:0;font-size:20px;">The WorkVilla</h1>
            <p style="color:#00AE6C;margin:4px 0 0;font-size:12px;">Tax Invoice</p>
          </div>
          <div style="padding:32px;">
            <p style="color:#333;font-size:14px;">Dear ${customerName},</p>
            <p style="color:#333;font-size:14px;">Please find attached your GST tax invoice for <strong>${periodLabel}</strong>. Kindly make payment at your earliest convenience.</p>
            <table style="width:100%;border-collapse:collapse;margin:16px 0;font-size:13px;">
              <tr><td style="padding:6px 0;color:#666;">Invoice No.</td><td style="padding:6px 0;font-weight:600;">${invoiceNumber}</td></tr>
              <tr><td style="padding:6px 0;color:#666;">${statement.contract ? "Contract" : statement.proposal ? "Proposal Ref" : "Invoice"}</td><td style="padding:6px 0;">${contractNumber}</td></tr>
              <tr><td style="padding:6px 0;color:#666;">Period</td><td style="padding:6px 0;">${periodLabel}</td></tr>
              <tr><td style="padding:6px 0;color:#666;">Invoice Date</td><td style="padding:6px 0;">${invoiceDateFormatted}</td></tr>
              <tr><td style="padding:6px 0;color:#666;">Amount Due</td><td style="padding:6px 0;font-weight:600;color:#015E65;font-size:16px;">Rs. ${amountFormatted}</td></tr>
            </table>
            ${rzpLinkUrl ? `
            <h3 style="color:#015E65;font-size:14px;margin:20px 0 10px;">Payment Options</h3>
            <table style="width:100%;border-collapse:collapse;font-size:13px;">
              <tr><td style="padding:4px 0;color:#666;">Bank Transfer</td><td style="padding:4px 0;">${COMPANY_BANK_DETAILS.accountName}<br/>${COMPANY_BANK_DETAILS.bank}, ${COMPANY_BANK_DETAILS.branch}<br/>A/C: ${COMPANY_BANK_DETAILS.accountNumber} | IFSC: ${COMPANY_BANK_DETAILS.ifscCode}</td></tr>
              ${upiId ? `<tr><td style="padding:4px 0;color:#666;">UPI</td><td style="padding:4px 0;">${upiId}</td></tr>` : ""}
              <tr><td style="padding:4px 0;color:#666;">Pay Online</td><td style="padding:4px 0;"><a href="${rzpLinkUrl}" style="color:#015E65;font-weight:bold;">${rzpLinkUrl}</a></td></tr>
            </table>
            <div style="text-align:center;margin:24px 0;">
              <a href="${rzpLinkUrl}" style="background:#015E65;color:white;padding:12px 32px;text-decoration:none;border-radius:8px;font-weight:bold;display:inline-block;font-size:14px;">Pay Now</a>
            </div>
            ` : ""}
            <p style="color:#333;font-size:14px;margin-top:24px;">Warm regards,<br/><strong>The WorkVilla</strong></p>
          </div>
          <div style="background:#015E65;padding:12px 32px;text-align:center;">
            <p style="color:#fff;margin:0;font-size:10px;">SREE DESIGN INFRASTRUCTURE PVT LTD</p>
            <p style="color:rgba(255,255,255,0.6);margin:4px 0 0;font-size:9px;">Prakash Presidium, 110, MG Road, Nungambakkam, Chennai - 600034 | GSTIN: 33AAACU4245J1ZF</p>
          </div>
        </div>
      `;

      // CC every additional billing contact on file — the primary "email" field
      // is only one of potentially several finance-team recipients the customer
      // registered (leads.billing_emails). Missing these silently drops the
      // invoice for everyone but the primary contact.
      const ccEmails = Array.from(
        new Set((lead?.billing_emails ?? []).filter((e) => e && e !== customerEmail)),
      );

      let emailWarning: string | null = null;
      try {
        const safeFilename = `${invoiceNumber.replace(/[^a-zA-Z0-9_-]/g, "-")}.pdf`;
        const sendResult = await resend.emails.send({
          from: EMAIL_FROM,
          replyTo: EMAIL_REPLY_TO,
          to: [customerEmail],
          cc: ccEmails.length > 0 ? ccEmails : undefined,
          bcc: [EMAIL_REPLY_TO],
          subject: `Tax Invoice ${invoiceNumber} — ${contractNumber} — The WorkVilla`,
          html: emailHtml,
          attachments: pdfAttachment
            ? [{ filename: safeFilename, content: pdfAttachment, contentType: "application/pdf" }]
            : undefined,
        });
        if (sendResult.error) throw new Error(sendResult.error.message);
        await adminSupabase.from("billing_statements").update({
          gst_invoice_sent_at: nowIso,
          gst_invoice_sent_to: [customerEmail, ...ccEmails].join(", "),
          // Stamp the same delivery-bookkeeping fields dispatchTallyInvoice uses
          // (tally_delivered_at, lifecycle_stage). Without this, the payment-reminder
          // cron's "never dun an undelivered Tally invoice" gate treats this
          // statement as permanently undelivered even though it was just emailed —
          // see docs/tally-integration-status.md for the incident this fixed.
          tally_delivered_at: nowIso,
          lifecycle_stage: "sent",
          emailed_at: nowIso,
          emailed_to: customerEmail,
        }).eq("id", id);
        if (statement.invoice) {
          await adminSupabase.from("proforma_invoices").update({
            gst_invoice_sent_at: nowIso,
            gst_invoice_sent_to: [customerEmail, ...ccEmails].join(", "),
          }).eq("id", statement.invoice.id);
        }
        await setHandoffState(adminSupabase, id, "gst_sent_awaiting_payment", "gst_invoice_email_sent");
        // Log every recipient to billing_send_log — this is what actually feeds
        // the "Communications" timeline on the lead page (GET
        // /api/leads/[id]/billing-communications). Without this, the auto-send
        // that just happened is invisible there even though it succeeded.
        await adminSupabase.from("billing_send_log").insert(
          [customerEmail, ...ccEmails].map((recipient) => ({
            billing_statement_id: id,
            send_type: "gst_invoice" as const,
            recipient,
            status: "sent" as const,
            triggered_by: "manual" as const,
            triggered_by_user_id: dbUser.id,
          })),
        );
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        emailWarning = `Email delivery failed: ${errMsg}. Invoice uploaded — use Save & send from the inbox to retry.`;
        await adminSupabase.from("audit_trail").insert({
          entity_type: "billing_statement",
          entity_id: id,
          action: "email_failed",
          performed_by: null,
          changes: { error: errMsg, recipient: customerEmail, trigger: "upload_gst_invoice" },
        });
        await adminSupabase.from("billing_send_log").insert(
          [customerEmail, ...ccEmails].map((recipient) => ({
            billing_statement_id: id,
            send_type: "gst_invoice" as const,
            recipient,
            status: "failed" as const,
            error: errMsg,
            triggered_by: "manual" as const,
            triggered_by_user_id: dbUser.id,
          })),
        );
      }

      return NextResponse.json({
        ok: true,
        upload_id: insertedUpload.id,
        handoff_state: emailWarning ? "ready_to_send" : "gst_sent_awaiting_payment",
        email_warning: emailWarning ?? undefined,
      });
    }
  }

  return NextResponse.json({
    ok: true,
    upload_id: insertedUpload.id,
    handoff_state: "ready_to_send",
  });
}
