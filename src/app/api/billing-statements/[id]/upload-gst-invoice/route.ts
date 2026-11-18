import { NextRequest, NextResponse } from "next/server";
import { rejectIfBookingPiStatement } from "@/lib/booking-pi-statement-server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { normalizeUploadServer, UploadValidationError } from "@/lib/uploads/normalize-upload-server";
import { stampSignatureOnPdf } from "@/lib/uploads/stamp-pdf-signature";
import { isHandoffV2Enabled, setHandoffState } from "@/lib/tally-handoff-server";
import { resend, EMAIL_FROM, EMAIL_REPLY_TO } from "@/lib/mailer";
import { COMPANY_BANK_DETAILS, RAZORPAY_MAX_LINK_VALIDITY_SECONDS } from "@/lib/constants";
import { fetchSupportingDocuments, mergeSupportingDocuments } from "@/lib/reimbursement-supporting-docs";
import { appendElectricityAnnexure } from "@/lib/electricity-annexure-pdf";
import { annexureFromSections } from "@/lib/electricity-annexure";
import { isInvoiceDateOffPeriod } from "@/lib/invoice-date-period";
import { invoicePeriodMismatch } from "@/lib/invoice-period-text";
import { logAudit } from "@/lib/audit";
import { extractFromPdf } from "@/lib/tally-pdf-extract";
import { isRealCompanyName } from "@/lib/tally-handoff";
import { createOrRecoverGstLink, gstLinkReferenceId } from "@/lib/razorpay-gst-link";

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
 *   - Period printed on the PDF shares no month with the statement's → 422 without acknowledge_period_mismatch
 *   - Invoice date outside the period's months without acknowledge_off_period_date → 422
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
  /** Accounts confirmed an invoice date outside the billing period is intended. */
  acknowledge_off_period_date?: boolean;
  /** Accounts confirmed the period printed on the PDF differs from the statement's on purpose. */
  acknowledge_period_mismatch?: boolean;
  /** Accounts confirmed the customer name on the PDF differs from the CRM's on purpose. */
  acknowledge_party_name_mismatch?: boolean;
  /** Accounts confirmed the customer GSTIN on the PDF differs from the CRM's on purpose. */
  acknowledge_gstin_mismatch?: boolean;
  /** The file's text could not be read (image / scanned PDF); accounts checked name, GSTIN and period by eye. */
  acknowledge_unverified_document?: boolean;
  /** Replace the live upload (wrong invoice / period) instead of adding the first one. */
  replace?: boolean;
  /** Why the live upload is being replaced; required once the invoice has gone to the customer. */
  replace_reason?: string;
  /** Second confirmation: the number of the invoice being replaced, typed back by the user. */
  confirm_replace_number?: string;
}

function conflict(reason: string) {
  return NextResponse.json({ error: reason }, { status: 409 });
}

function badRequest(reason: string) {
  return NextResponse.json({ error: reason }, { status: 422 });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const piBlock = await rejectIfBookingPiStatement(id);
  if (piBlock) return piBlock;
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
      statement_number, period_start, period_end, statement_type, line_items, razorpay_payment_link_url,
      tally_delivered_at, voided_at, cancellation_requested_at,
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
    statement_type: string | null;
    line_items: unknown;
    razorpay_payment_link_url: string | null;
    tally_delivered_at: string | null;
    voided_at: string | null;
    cancellation_requested_at: string | null;
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

  // ── Replace / duplicate-upload guard ─────────────────────────────────────
  // Exactly one upload per statement is live. A second upload is only legal as
  // an explicit replacement of an invoice that has not reached the customer.
  const { data: liveUploads } = await adminClient
    .from("gst_invoice_uploads")
    .select("id, tally_invoice_number")
    .eq("billing_statement_id", statement.id)
    .is("superseded_by", null);
  const live = liveUploads ?? [];
  const isInitialState = statement.handoff_state === "pi_paid_awaiting_gst" || statement.handoff_state === "direct_gst_requested";

  const REPLACEABLE_STATES = ["ready_to_send", "gst_sent_awaiting_payment", "gst_sent"];
  const replaceReason = (meta.replace_reason ?? "").trim();
  // True when the customer already has the invoice being replaced. Replacing it
  // is a deliberate act on a sent tax invoice, so it needs a recorded reason.
  const replacingSent = meta.replace === true && statement.handoff_state !== "ready_to_send";

  if (meta.replace === true) {
    if (live.length === 0) return conflict("There is no uploaded invoice to replace.");
    if (!REPLACEABLE_STATES.includes(statement.handoff_state ?? "")) {
      return conflict("This invoice is past the point where it can be replaced (payment already confirmed or closed).");
    }
    if (statement.voided_at || statement.cancellation_requested_at) {
      return conflict("This invoice is voided or being cancelled, so it can't be replaced.");
    }
    if (replacingSent) {
      if (replaceReason.length < 10) {
        return badRequest("Give a reason of at least 10 characters for replacing an invoice that was already sent.");
      }
      // Second step of the confirmation, re-checked here so the API can't be used to skip it.
      const typed = (meta.confirm_replace_number ?? "").trim().toLowerCase();
      if (!live.some((u) => (u.tally_invoice_number ?? "").trim().toLowerCase() === typed) || !typed) {
        return badRequest("Confirmation failed: type the number of the invoice being replaced exactly to confirm.");
      }
    } else {
      if (statement.tally_delivered_at) {
        return conflict("This invoice was already delivered, so it can't be replaced here.");
      }
      const { data: sentRows } = await adminClient
        .from("billing_send_log")
        .select("id")
        .eq("billing_statement_id", statement.id)
        .eq("send_type", "gst_invoice")
        .eq("status", "sent")
        .limit(1);
      if ((sentRows ?? []).length > 0) {
        return conflict("This invoice was already emailed to the customer, so it can't be replaced from this state.");
      }
    }
  } else if (live.length > 0 && !isInitialState) {
    return conflict("An invoice is already uploaded for this statement. Use Replace invoice to correct it.");
  }

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

  if (
    isInvoiceDateOffPeriod(meta.invoice_date, statement.period_start, statement.period_end) &&
    meta.acknowledge_off_period_date !== true
  ) {
    return badRequest(
      `Invoice date ${meta.invoice_date} doesn't fit the billing period ` +
      `${statement.period_start} → ${statement.period_end}. Confirm the date is intended to upload anyway.`,
    );
  }

  // What the PDF says is re-read here rather than trusted from the client, so
  // the form's warnings can't be skipped by leaving a field out. A PDF whose
  // text names no period / name / GSTIN passes that check: absence of evidence
  // isn't a mismatch. A file with no readable text at all (image, scanned PDF)
  // can't be checked by anything, so accounts must say they checked it by eye.
  const partyNames = [
    isRealCompanyName(partyLead?.company) ? partyLead.company : null,
    [partyLead?.first_name, partyLead?.last_name].filter(Boolean).join(" ") || null,
  ];
  const overrides: string[] = [];
  const extracted = file.type === "application/pdf"
    ? await extractFromPdf(Buffer.from(await file.arrayBuffer()), null, {
        names: partyNames,
        gstin: partyLead?.gst_number ?? null,
      })
    : null;

  if (!extracted?.text_readable) {
    if (meta.acknowledge_unverified_document !== true) {
      return badRequest(
        "The text of this file can't be read, so the customer name, GSTIN and billing period could not be checked. " +
        "Confirm you checked them on the invoice to upload anyway.",
      );
    }
    overrides.push("file text unreadable — name, GSTIN and period confirmed by eye");
  } else {
    // First gate: is this a tax invoice at all? No override — a different
    // document is the wrong file, not a judgement call.
    if (extracted.is_tax_invoice === false) {
      return badRequest(
        "This file doesn't look like a GST tax invoice (no Tally invoice number or \"Tax Invoice\" heading found). " +
        "Check you attached the invoice PDF and not another document.",
      );
    }
    if (meta.acknowledge_period_mismatch !== true
      && invoicePeriodMismatch(extracted.invoice_period_months, statement.period_start, statement.period_end)) {
      return badRequest(
        `This invoice says it bills ${extracted.invoice_period_months.join(", ")}, but the statement covers ` +
        `${statement.period_start} → ${statement.period_end}. Confirm the period is correct to upload anyway.`,
      );
    }
    if (extracted.party_name_found === false && meta.acknowledge_party_name_mismatch !== true) {
      return badRequest(
        `The customer name on this invoice doesn't match the CRM ("${partyNames.find(Boolean)}"). ` +
        "Check you picked the right Tally voucher, or confirm the name is correct to upload anyway.",
      );
    }
    if (extracted.party_name_found === false) overrides.push("customer name on invoice differs from CRM");
    if (extracted.party_gstin_found === false && meta.acknowledge_gstin_mismatch !== true) {
      return badRequest(
        `The customer GSTIN ${partyLead?.gst_number} from the CRM isn't printed on this invoice. ` +
        "Check you picked the right Tally voucher, or confirm the GSTIN is correct to upload anyway.",
      );
    }
    if (extracted.party_gstin_found === false) overrides.push("customer GSTIN on invoice differs from CRM");
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

    // Reimbursement invoices carry customer-facing proof (receipts, vendor
    // bills) — append them here so the merged PDF, once stored below, is the
    // one file every downstream view/resend/email route reads from. Merging
    // per-route instead would risk double-appending pages on a resend.
    if (statement.statement_type === "reimbursement") {
      const supportingDocs = await fetchSupportingDocuments(adminClient, statement.id);
      if (supportingDocs.length > 0) {
        normalized.buffer = await mergeSupportingDocuments(adminClient, Buffer.from(normalized.buffer), supportingDocs);
      }
    }

    // Electricity re-bills: the customer receives this Tally PDF, not a CRM
    // one, so the frozen Annexure A page is appended here (once, before
    // storing) rather than in the view/resend routes. Fails soft.
    if (statement.statement_type === "electricity") {
      normalized.buffer = await appendElectricityAnnexure(normalized.buffer, {
        invoiceNumber: meta.tally_invoice_number,
        contractNumber: statement.contract?.contract_number ?? "",
        annexure: annexureFromSections(statement.line_items),
      });
    }
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
      name_check_status: overrides.length ? "overridden" : "approved",
      name_check_notes: [
        ...overrides,
        ...(meta.replace === true
          ? [`replaces ${live.map((u) => u.tally_invoice_number).join(", ")}${replaceReason ? `: ${replaceReason}` : ""}`]
          : []),
      ].join("; ") || null,
      name_check_decided_by: dbUser.id,
      name_check_decided_at: new Date().toISOString(),
    })
    .select("id")
    .single();

  if (insertErr) {
    return NextResponse.json({ error: insertErr.message }, { status: 500 });
  }

  // ── Retire earlier live uploads ───────────────────────────────────────────
  // Keeps "one live upload per statement" true for replacements and also heals
  // any duplicate left by an earlier double upload. Rows are never deleted.
  if (live.length > 0) {
    const { error: supersedeErr } = await adminClient
      .from("gst_invoice_uploads")
      .update({ superseded_by: insertedUpload.id })
      .in("id", live.map((u) => u.id));
    if (supersedeErr) {
      return NextResponse.json(
        { error: `New invoice saved (id: ${insertedUpload.id}) but the old one could not be retired: ${supersedeErr.message}. Refresh and check the statement.` },
        { status: 500 },
      );
    }
    if (meta.replace === true) {
      // Awaited: a fire-and-forget write can be dropped once the response is sent.
      await logAudit(adminClient, {
        entityType: "billing_statement",
        entityId: statement.id,
        action: "replace",
        performedBy: dbUser.id,
        changes: {
          gst_invoice_upload: {
            old: live.map((u) => u.tally_invoice_number).join(", "),
            new: meta.tally_invoice_number,
          },
          ...(replacingSent
            ? {
                replaced_after_sent: { old: null, new: true },
                replace_reason: { old: null, new: replaceReason },
                replace_confirmed_by_typing_invoice_number: { old: null, new: true },
                handoff_state_at_replace: { old: statement.handoff_state, new: statement.handoff_state },
              }
            : {}),
        },
      });
    }
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
  if (replacingSent) {
    // The customer already has an invoice, so the workflow state stays where it
    // was. The caller re-sends the corrected PDF through resend-gst-invoice.
    return NextResponse.json({
      ok: true,
      upload_id: insertedUpload.id,
      handoff_state: statement.handoff_state,
      needs_resend: true,
    });
  }
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
    // A replacement keeps the link the statement already has: the link lives on
    // the CRM row, not in the PDF, so the corrected email can carry it as is.
    // (Same statement, same amount, so a payment on it reconciles normally.)
    if (rzpAuth && !(meta.replace === true && statement.razorpay_payment_link_url)) {
      try {
        const appUrl = (process.env.NEXT_PUBLIC_APP_URL || "https://twv-crm.vercel.app").trim();
        const payload: Record<string, unknown> & { reference_id: string; amount: number } = {
          amount: Math.round(totalAmount * 100),
          currency: "INR",
          description: `Tax Invoice ${invoiceNumber} — ${contractNumber} — The WorkVilla`,
          reference_id: gstLinkReferenceId(invoiceNumber),
          expire_by: Math.floor(Date.now() / 1000) + RAZORPAY_MAX_LINK_VALIDITY_SECONDS,
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
        const link = await createOrRecoverGstLink({ rzpAuth, payload, logTag: "upload-gst-invoice" });
        if (link) {
          rzpLinkId = link.id;
          rzpLinkUrl = link.url;
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

    // No new link: the email still carries the one already on the statement
    // rather than going out with nothing to click.
    const emailLinkUrl = rzpLinkUrl ?? statement.razorpay_payment_link_url ?? null;

    const nowIso = new Date().toISOString();
    const nowYmd = nowIso.slice(0, 10);

    // ── Persist Razorpay link + due date ─────────────────────────────────────
    // Resetting the ladder alongside due_date is load-bearing, not tidiness:
    // the reminder cron picks a stage from days-overdue against due_date but
    // gates it on reminder_count, so a stale count behind a fresh due date
    // reads as "stage already sent" for every rung already fired and the
    // statement stops being chased until days-overdue catches back up.
    // The link columns are only written when a link was obtained: a failed
    // attempt used to overwrite a stored link with null.
    await adminSupabase.from("billing_statements").update({
      ...(rzpLinkId && rzpLinkUrl
        ? { razorpay_payment_link_id: rzpLinkId, razorpay_payment_link_url: rzpLinkUrl }
        : {}),
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
            ${emailLinkUrl ? `
            <h3 style="color:#015E65;font-size:14px;margin:20px 0 10px;">Payment Options</h3>
            <table style="width:100%;border-collapse:collapse;font-size:13px;">
              <tr><td style="padding:4px 0;color:#666;">Bank Transfer</td><td style="padding:4px 0;">${COMPANY_BANK_DETAILS.accountName}<br/>${COMPANY_BANK_DETAILS.bank}, ${COMPANY_BANK_DETAILS.branch}<br/>A/C: ${COMPANY_BANK_DETAILS.accountNumber} | IFSC: ${COMPANY_BANK_DETAILS.ifscCode}</td></tr>
              ${upiId ? `<tr><td style="padding:4px 0;color:#666;">UPI</td><td style="padding:4px 0;">${upiId}</td></tr>` : ""}
              <tr><td style="padding:4px 0;color:#666;">Pay Online</td><td style="padding:4px 0;"><a href="${emailLinkUrl}" style="color:#015E65;font-weight:bold;">${emailLinkUrl}</a></td></tr>
            </table>
            <div style="text-align:center;margin:24px 0;">
              <a href="${emailLinkUrl}" style="background:#015E65;color:white;padding:12px 32px;text-decoration:none;border-radius:8px;font-weight:bold;display:inline-block;font-size:14px;">Pay Now</a>
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
          patient: true,
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
