import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  AGING_ESCALATE_HOURS,
  bucketFor,
  bucketForBooking,
  HANDOFF_STATE_LABELS,
  INBOX_ACTIONABLE_STATES,
  isInboxRole,
  type BookingHandoffState,
  type BookingInboxRow,
  type BookingPaymentConfirmation,
  type HandoffState,
  type InboxPayment,
  type InboxResponse,
  type InboxRow,
  type InboxSnapshot,
  type InboxUpload,
  type TimelineEvent,
} from "@/lib/tally-handoff";

/**
 * GET /api/accounting/inbox
 *
 * Read-only feed for the Accounts Inbox page. Returns:
 *   - stats: counts by bucket (gst to issue, payments to record, discrepancies, aging)
 *   - rows: actionable handoff items (open states minus `pi_awaiting_payment`,
 *           which has no available action here and is tracked in Accounts
 *           Receivable instead — see INBOX_ACTIONABLE_STATES)
 *           enriched with contract + lead + latest upload + latest tally snapshot match
 *   - last_synced_at: most recent tally_voucher_snapshots.last_synced_at (or null)
 *
 * Until PR #2c starts writing handoff_state on payment capture / upload, the
 * rows array will be empty for new statements. Existing legacy statements
 * keep handoff_state = NULL and are excluded by design.
 */
export const dynamic = "force-dynamic";

const CLOSED_PAGE_SIZE = 50;

export async function GET(req: NextRequest) {
  const supabase = await createClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: dbUser } = await supabase
    .from("users")
    .select("id, role")
    .eq("auth_id", user.id)
    .maybeSingle();

  if (!dbUser || !isInboxRole(dbUser.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Query params:
  //   tab=open|closed (default open)
  //   q=<search text>
  //   id=<statement_id> — single-row mode; bypasses the open/closed filter and
  //     returns just that one statement regardless of handoff_state. Used by
  //     ViewStatementDialog / contract page / billing list when they want
  //     lifecycle info for one specific row.
  //   include=timeline — when set, the row carries a timeline_events[] array
  //     synthesized from billing_payments, gst_invoice_uploads, audit_trail,
  //     and billing_statements milestone columns. Only honored with ?id=.
  const url = new URL(req.url);
  const tab = url.searchParams.get("tab") === "closed" ? "closed" : "open";
  const q = (url.searchParams.get("q") ?? "").trim();
  const singleId = (url.searchParams.get("id") ?? "").trim() || null;
  const page = Math.max(1, parseInt(url.searchParams.get("page") ?? "1", 10));
  const includeTimeline =
    !!singleId && (url.searchParams.get("include") ?? "").split(",").includes("timeline");

  // Pull statements by tab. We select the columns the UI needs plus
  // contract → lead via the standard FK joins (same pattern as receivables).
  let query = supabase
    .from("billing_statements")
    .select(`
      id, statement_number, period_start, period_end,
      total_amount, payment_status, handoff_state, updated_at,
      created_at, proforma_sent_at, tally_delivered_at,
      voided_at, void_reason, pi_cancelled_at,
      lifecycle_stage, tally_credit_note_number,
      statement_type, fixed_amount, usage_amount,
      service_usage_amount, booking_usage_amount,
      subtotal, tax_percentage, tax_amount,
      cgst_amount, sgst_amount, igst_amount,
      is_interstate, place_of_supply, hsn_sac_code,
      gst_invoice_number, tally_invoice_number, gst_invoice_sent_at,
      line_items,
      usage_charges:usage_charges(description, quantity, unit_price, total, notes),
      contract:contracts!billing_statements_contract_id_fkey(
        id, contract_number, title, billing_mode,
        lead:leads!contracts_lead_id_fkey(
          id, first_name, last_name, company, email, phone, gst_number, billing_emails
        )
      ),
      proposal:proposals!billing_statements_proposal_id_fkey(
        id, proposal_number,
        lead:leads!proposals_lead_id_fkey(
          id, first_name, last_name, company, email, phone, gst_number, billing_emails
        )
      ),
      invoice:proforma_invoices!billing_statements_invoice_id_fkey(
        id, invoice_number, title, internal_notes,
        lead:leads!proforma_invoices_lead_id_fkey(
          id, first_name, last_name, company, email, phone, gst_number, billing_emails
        )
      ),
      case:cases!billing_statements_case_id_fkey(
        id, case_number, client_name, client_company_name, client_email, client_phone, client_gst_number,
        aggregator:aggregators!cases_aggregator_id_fkey(id, name, primary_email, primary_phone, gst_number)
      ),
      aggregator:aggregators!billing_statements_aggregator_id_fkey(id, name, primary_email, primary_phone, gst_number)
    `);

  if (singleId) {
    // Single-row mode: return exactly that statement regardless of state.
    // Used by lifecycle-badge / quick-actions / timeline lookups from
    // surfaces outside the inbox (contract page, billing dialog, etc.).
    query = query.eq("id", singleId).limit(1);
  } else if (tab === "closed") {
    query = query
      .or("handoff_state.eq.complete,voided_at.not.is.null")
      .order("updated_at", { ascending: false })
      .range((page - 1) * CLOSED_PAGE_SIZE, page * CLOSED_PAGE_SIZE);
  } else {
    query = query.in("handoff_state", INBOX_ACTIONABLE_STATES as readonly string[])
      .is("voided_at", null)
      .order("updated_at", { ascending: true });
  }

  const { data: statements, error } = await query;

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Supabase types joins as arrays even when FK relation is single.
  // The runtime returns a single object; cast through unknown to bridge.
  const statementList = (statements || []) as unknown as Array<{
    id: string;
    statement_number: string | null;
    period_start: string | null;
    period_end: string | null;
    total_amount: number;
    payment_status: string;
    handoff_state: HandoffState;
    updated_at: string;
    statement_type: "rent" | "usage" | "combined" | null;
    fixed_amount: number | null;
    usage_amount: number | null;
    service_usage_amount: number | null;
    booking_usage_amount: number | null;
    subtotal: number | null;
    tax_percentage: number | null;
    tax_amount: number | null;
    cgst_amount: number | null;
    sgst_amount: number | null;
    igst_amount: number | null;
    is_interstate: boolean | null;
    place_of_supply: string | null;
    hsn_sac_code: string | null;
    gst_invoice_number: string | null;
    tally_invoice_number: string | null;
    gst_invoice_sent_at: string | null;
    line_items: Array<{
      type: string;
      label: string;
      items: Array<{ description?: string; qty?: number; unit_price?: number; amount?: number; notes?: string }>;
    }> | null;
    usage_charges: Array<{
      description: string | null;
      quantity: number | null;
      unit_price: number | null;
      total: number | null;
      notes: string | null;
    }> | null;
    created_at: string;
    proforma_sent_at: string | null;
    tally_delivered_at: string | null;
    voided_at: string | null;
    void_reason: string | null;
    pi_cancelled_at: string | null;
    lifecycle_stage: string | null;
    tally_credit_note_number: string | null;
    contract: {
      id: string;
      contract_number: string;
      title: string | null;
      billing_mode: "proforma_first" | "gst_direct" | null;
      lead: {
        id: string;
        first_name: string | null;
        last_name: string | null;
        company: string | null;
        email: string | null;
        phone: string | null;
        gst_number: string | null;
      } | null;
    } | null;
    proposal: {
      id: string;
      proposal_number: string;
      lead: {
        id: string;
        first_name: string | null;
        last_name: string | null;
        company: string | null;
        email: string | null;
        phone: string | null;
        gst_number: string | null;
      } | null;
    } | null;
    invoice: {
      id: string;
      invoice_number: string;
      title: string | null;
      internal_notes: string | null;
      lead: {
        id: string;
        first_name: string | null;
        last_name: string | null;
        company: string | null;
        email: string | null;
        phone: string | null;
        gst_number: string | null;
      } | null;
    } | null;
    case: {
      id: string;
      case_number: string;
      client_name: string;
      client_company_name: string | null;
      client_email: string | null;
      client_phone: string | null;
      client_gst_number: string | null;
      aggregator: { id: string; name: string; primary_email: string | null; primary_phone: string | null; gst_number: string | null } | null;
    } | null;
    aggregator: { id: string; name: string; primary_email: string | null; primary_phone: string | null; gst_number: string | null } | null;
  }>;

  // JS post-filter for search. The result set is already capped (closed=200,
  // open=unbounded but realistically small). Doing this in JS keeps the
  // search flexible across joined fields (customer name, GSTIN) without
  // fighting PostgREST's nested-OR syntax.
  const filtered = q
    ? statementList.filter((s) => {
        const lc = q.toLowerCase();
        const haystack: string[] = [
          s.statement_number ?? "",
          s.gst_invoice_number ?? "",
          s.tally_invoice_number ?? "",
          s.contract?.contract_number ?? "",
          s.contract?.title ?? "",
          s.contract?.lead?.gst_number ?? "",
          s.contract?.lead?.company ?? "",
          s.contract?.lead?.first_name ?? "",
          s.contract?.lead?.last_name ?? "",
          s.contract?.lead?.email ?? "",
          s.proposal?.proposal_number ?? "",
          s.proposal?.lead?.gst_number ?? "",
          s.proposal?.lead?.company ?? "",
          s.proposal?.lead?.first_name ?? "",
          s.proposal?.lead?.last_name ?? "",
          s.proposal?.lead?.email ?? "",
          s.invoice?.invoice_number ?? "",
          s.invoice?.lead?.gst_number ?? "",
          s.invoice?.lead?.company ?? "",
          s.invoice?.lead?.first_name ?? "",
          s.invoice?.lead?.last_name ?? "",
          s.invoice?.lead?.email ?? "",
          s.case?.case_number ?? "",
          s.case?.client_name ?? "",
          s.case?.client_company_name ?? "",
          s.case?.client_email ?? "",
          s.case?.client_gst_number ?? "",
          s.case?.aggregator?.name ?? "",
          s.aggregator?.name ?? "",
          s.aggregator?.gst_number ?? "",
        ];
        return haystack.some((h) => h.toLowerCase().includes(lc));
      })
    : statementList;

  const statementIds = filtered.map((s) => s.id);

  // PERF: the four side queries below used to await sequentially, adding
  // 4× the slowest single round-trip to the API response time. They have
  // no dependencies on each other, so we fan them out via Promise.all.
  // Combined with the 00256 index on billing_payments.billing_statement_id,
  // this should bring inbox load from "noticeably slow" to "snappy."

  const noIds = statementIds.length === 0;

  const [uploadsRes, snapshotsRes, lastSyncRes, paymentsRes, auditRes, allUploadsRes, openQueriesRes] = await Promise.all([
    noIds ? Promise.resolve({ data: null }) : supabase
      .from("gst_invoice_uploads")
      .select("id, billing_statement_id, tally_invoice_number, tally_invoice_series, irn, invoice_amount, uploaded_at, name_check_status, autofill_source, superseded_by")
      .in("billing_statement_id", statementIds)
      .is("superseded_by", null)
      .order("uploaded_at", { ascending: false }),
    noIds ? Promise.resolve({ data: null }) : supabase
      .from("tally_voucher_snapshots")
      .select("voucher_master_id, matched_statement_id, invoice_number, voucher_amount, irn, match_confidence, last_synced_at")
      .in("matched_statement_id", statementIds)
      .order("last_synced_at", { ascending: false }),
    supabase
      .from("tally_voucher_snapshots")
      .select("last_synced_at")
      .order("last_synced_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    noIds ? Promise.resolve({ data: null }) : supabase
      .from("billing_payments")
      .select("id, billing_statement_id, amount, payment_date, payment_mode, payment_reference, notes, razorpay_payment_id, recorder:users!billing_payments_recorded_by_fkey(full_name)")
      .in("billing_statement_id", statementIds)
      .order("payment_date", { ascending: false }),
    // Only fetched in single-row mode with ?include=timeline.
    !includeTimeline || noIds ? Promise.resolve({ data: null }) : supabase
      .from("audit_trail")
      .select("action, changes, performed_by, created_at")
      .eq("entity_type", "billing_statement")
      .eq("entity_id", statementIds[0])
      .order("created_at", { ascending: true }),
    // All uploads (including superseded) for the timeline.
    !includeTimeline || noIds ? Promise.resolve({ data: null }) : supabase
      .from("gst_invoice_uploads")
      .select("id, tally_invoice_number, uploaded_at, uploaded_by, superseded_by")
      .eq("billing_statement_id", statementIds[0])
      .order("uploaded_at", { ascending: true }),
    noIds ? Promise.resolve({ data: null }) : supabase
      .from("billing_queries")
      .select("billing_statement_id")
      .in("billing_statement_id", statementIds)
      .eq("status", "open"),
  ]);

  // Open billing_queries count per statement — one grouped-in-JS count from
  // a single batched query, same pattern as uploadByStatement below.
  const openQueryCountByStatement = new Map<string, number>();
  for (const r of openQueriesRes.data || []) {
    const sid = (r as { billing_statement_id: string }).billing_statement_id;
    openQueryCountByStatement.set(sid, (openQueryCountByStatement.get(sid) ?? 0) + 1);
  }

  // gst_invoice_uploads.uploaded_by references auth.users(id), not
  // public.users(id) — no FK exists for Supabase to embed a join, so
  // resolve display names with a second lookup keyed on auth_id. Only
  // needed for the timeline (same gating as allUploadsRes above).
  const uploaderNameByAuthId = new Map<string, string>();
  if (includeTimeline && allUploadsRes.data) {
    const uploaderAuthIds = [...new Set(
      (allUploadsRes.data as Array<{ uploaded_by: string | null }>)
        .map((u) => u.uploaded_by)
        .filter((id): id is string => !!id)
    )];
    if (uploaderAuthIds.length > 0) {
      const { data: uploaderUsers } = await supabase
        .from("users")
        .select("auth_id, full_name")
        .in("auth_id", uploaderAuthIds);
      for (const u of (uploaderUsers ?? []) as Array<{ auth_id: string; full_name: string | null }>) {
        if (u.full_name) uploaderNameByAuthId.set(u.auth_id, u.full_name);
      }
    }
  }

  // Latest gst_invoice_upload per statement (most recent non-superseded).
  const uploadByStatement = new Map<string, InboxUpload>();
  for (const u of uploadsRes.data || []) {
    const sid = (u as { billing_statement_id: string }).billing_statement_id;
    if (!uploadByStatement.has(sid)) {
      uploadByStatement.set(sid, {
        id: u.id as string,
        tally_invoice_number: u.tally_invoice_number as string,
        tally_invoice_series: u.tally_invoice_series as "SDIPL-REG" | "SDIPL-UNREG",
        irn: (u.irn as string | null) ?? null,
        invoice_amount: Number(u.invoice_amount),
        uploaded_at: u.uploaded_at as string,
        name_check_status: u.name_check_status as "pending" | "approved" | "overridden",
        autofill_source: u.autofill_source as "qr" | "pdf_text" | "bridge_match" | "manual",
      });
    }
  }

  // Latest matched tally_voucher_snapshot per statement.
  const snapshotByStatement = new Map<string, InboxSnapshot>();
  for (const s of snapshotsRes.data || []) {
    const sid = (s as { matched_statement_id: string }).matched_statement_id;
    if (sid && !snapshotByStatement.has(sid)) {
      snapshotByStatement.set(sid, {
        voucher_master_id: s.voucher_master_id as string,
        invoice_number: (s.invoice_number as string | null) ?? null,
        voucher_amount: s.voucher_amount == null ? null : Number(s.voucher_amount),
        irn: (s.irn as string | null) ?? null,
        match_confidence: (s.match_confidence as "exact" | "probable" | "unmatched" | null) ?? null,
        last_synced_at: s.last_synced_at as string,
      });
    }
  }

  // Last bridge sync (any voucher).
  const lastSyncedAt = ((lastSyncRes as { data: { last_synced_at: string } | null }).data?.last_synced_at) ?? null;

  // Payments per statement — with settlement data joined from razorpay_settlement_cache.
  const stmtRzpIds = (paymentsRes.data || [])
    .map((p) => p.razorpay_payment_id as string | null)
    .filter(Boolean) as string[];

  const stmtSettlementMap = new Map<string, { settled: boolean; settled_at: string | null; settlement_utr: string | null }>();
  if (stmtRzpIds.length > 0) {
    const { data: stmtSRows } = await supabase
      .from("razorpay_settlement_cache")
      .select("razorpay_payment_id, settled, settled_at, settlement_utr")
      .in("razorpay_payment_id", stmtRzpIds);
    for (const s of stmtSRows || []) {
      stmtSettlementMap.set(s.razorpay_payment_id as string, {
        settled: s.settled as boolean,
        settled_at: (s.settled_at as string | null) ?? null,
        settlement_utr: (s.settlement_utr as string | null) ?? null,
      });
    }
  }

  const paymentsByStatement = new Map<string, InboxPayment[]>();
  for (const p of paymentsRes.data || []) {
    const sid = (p as { billing_statement_id: string }).billing_statement_id;
    const rzpId = (p.razorpay_payment_id as string | null) ?? null;
    const settlement = rzpId ? (stmtSettlementMap.get(rzpId) ?? null) : null;
    const recorderRaw = (p as { recorder: { full_name: string | null } | { full_name: string | null }[] | null }).recorder;
    const recorder = Array.isArray(recorderRaw) ? recorderRaw[0] ?? null : recorderRaw;
    const list = paymentsByStatement.get(sid) ?? [];
    list.push({
      id: p.id as string,
      amount: Number(p.amount),
      payment_date: p.payment_date as string,
      payment_mode: p.payment_mode as string,
      payment_reference: (p.payment_reference as string | null) ?? null,
      notes: (p.notes as string | null) ?? null,
      razorpay_payment_id: rzpId,
      recorded_by_name: recorder?.full_name ?? null,
      settled: settlement?.settled ?? null,
      settled_at: settlement?.settled_at ?? null,
      settlement_utr: settlement?.settlement_utr ?? null,
    });
    paymentsByStatement.set(sid, list);
  }

  const now = Date.now();
  const rows: InboxRow[] = filtered.map((s) => {
    const upload = uploadByStatement.get(s.id) ?? null;
    const snapshot = snapshotByStatement.get(s.id) ?? null;

    // Discrepancy detection. The bridge sees a Tally voucher whose amount
    // doesn't match what we expected, OR the upload's amount diverges from
    // the statement total. Either case blocks send.
    // Compare at whole-rupee level — Tally GST invoices are always rounded to
    // the nearest rupee (standard round-off), so a statement total carrying
    // paisa (e.g. ₹123334.40) will legitimately be invoiced as ₹123334. This
    // mirrors the tolerance already applied client-side and at upload time
    // (see upload-gst-invoice/route.ts) — don't flag a real accounting
    // round-off as a discrepancy.
    let hasDiscrepancy = false;
    let discrepancyReason: string | null = null;
    if (upload && Math.round(Number(upload.invoice_amount)) !== Math.round(Number(s.total_amount))) {
      hasDiscrepancy = true;
      discrepancyReason = `Upload amount ₹${upload.invoice_amount} does not match statement total ₹${s.total_amount}`;
    } else if (snapshot && snapshot.voucher_amount != null &&
               Math.round(Number(snapshot.voucher_amount)) !== Math.round(Number(s.total_amount))) {
      hasDiscrepancy = true;
      discrepancyReason = `Tally voucher amount ₹${snapshot.voucher_amount} does not match statement total ₹${s.total_amount}`;
    }

    const stateChangedAt = s.updated_at;
    const agingHours = Math.max(0, Math.round((now - Date.parse(stateChangedAt)) / 3_600_000));
    const bucket = bucketFor(s.handoff_state, hasDiscrepancy) ?? "in_flight";

    const customerHasGstin = !!(
      s.contract?.lead?.gst_number ?? s.proposal?.lead?.gst_number ?? s.invoice?.lead?.gst_number ??
      s.case?.aggregator?.gst_number ?? s.case?.client_gst_number ?? s.aggregator?.gst_number
    );
    const payments = paymentsByStatement.get(s.id) ?? [];
    const totalPaid = payments.reduce((sum, p) => sum + p.amount, 0);
    const isVoided = !!s.voided_at;

    // Timeline events (only when single-row mode + include=timeline).
    // Synthesized from heterogeneous sources, sorted chronologically.
    let timelineEvents: TimelineEvent[] | undefined;
    if (includeTimeline && s.id === singleId) {
      timelineEvents = buildTimelineEvents({
        statement: s,
        payments,
        uploads: (allUploadsRes.data || []) as Array<{
          id: string;
          tally_invoice_number: string;
          uploaded_at: string;
          uploaded_by: string | null;
          superseded_by: string | null;
        }>,
        auditEntries: (auditRes.data || []) as Array<{
          action: string;
          changes: Record<string, unknown> | null;
          performed_by: string | null;
          created_at: string;
        }>,
        uploaderNameByAuthId,
      });
    }

    // Prefer structured line_items (the same source proforma-pdf builds
    // from), fall back to usage_charges rows — accounts sees the exact same
    // itemization that ends up on the customer-facing PDF, not a lump total.
    const structuredSections = s.line_items ?? [];
    const itemizedCharges =
      structuredSections.length > 0
        ? structuredSections.flatMap((section) =>
            section.items.map((item) => ({
              description: item.description || section.label,
              quantity: item.qty ?? 1,
              unit_price: item.unit_price ?? Number(item.amount ?? 0),
              amount: Number(item.amount ?? 0),
              notes: item.notes ?? null,
            }))
          )
        : (s.usage_charges ?? []).map((c) => ({
            description: c.description ?? "Usage charge",
            quantity: Number(c.quantity ?? 1),
            unit_price: Number(c.unit_price ?? 0),
            amount: Number(c.total ?? 0),
            notes: c.notes,
          }));

    return {
      statement_id: s.id,
      statement_number: s.statement_number,
      statement_total_amount: Math.round(Number(s.total_amount)),
      period_start: s.period_start,
      period_end: s.period_end,
      payment_status: s.payment_status,
      handoff_state: s.handoff_state,
      bucket,
      aging_hours: agingHours,
      state_changed_at: stateChangedAt,
      is_voided: isVoided,
      voided_at: s.voided_at,
      void_reason: s.void_reason,
      pi_was_cancelled: !!s.pi_cancelled_at,
      lifecycle_stage: s.lifecycle_stage,
      tally_credit_note_number: s.tally_credit_note_number,
      ...(timelineEvents ? { timeline_events: timelineEvents } : {}),
      contract: s.contract
        ? {
            id: s.contract.id,
            contract_number: s.contract.contract_number,
            title: s.contract.title,
            billing_mode: s.contract.billing_mode,
            lead: s.contract.lead,
          }
        : null,
      proposal: s.proposal
        ? {
            id: s.proposal.id,
            proposal_number: s.proposal.proposal_number,
            lead: s.proposal.lead,
          }
        : null,
      invoice: s.invoice
        ? {
            id: s.invoice.id,
            invoice_number: s.invoice.invoice_number,
            title: s.invoice.title,
            internal_notes: s.invoice.internal_notes,
            lead: s.invoice.lead,
          }
        : null,
      case: s.case,
      aggregator: s.aggregator,
      latest_upload: upload,
      latest_snapshot: snapshot,
      has_discrepancy: hasDiscrepancy,
      discrepancy_reason: discrepancyReason,
      open_query_count: openQueryCountByStatement.get(s.id) ?? 0,
      // New detail fields
      irn_required: customerHasGstin,
      expected_series: customerHasGstin ? "SDIPL-REG" : "SDIPL-UNREG",
      expected_prefix: customerHasGstin ? "SD/A/" : "SD/B/",
      tax: {
        subtotal: Number(s.subtotal ?? 0),
        tax_percentage: Number(s.tax_percentage ?? 18),
        tax_amount: Number(s.tax_amount ?? 0),
        cgst_amount: s.cgst_amount == null ? null : Number(s.cgst_amount),
        sgst_amount: s.sgst_amount == null ? null : Number(s.sgst_amount),
        igst_amount: s.igst_amount == null ? null : Number(s.igst_amount),
        is_interstate: !!s.is_interstate,
        place_of_supply: s.place_of_supply,
        hsn_sac_code: s.hsn_sac_code,
      },
      line_items: {
        statement_type: s.statement_type,
        fixed_amount: Number(s.fixed_amount ?? 0),
        usage_amount: Number(s.usage_amount ?? 0),
        service_usage_amount: Number(s.service_usage_amount ?? 0),
        booking_usage_amount: Number(s.booking_usage_amount ?? 0),
        period_start: s.period_start,
        period_end: s.period_end,
      },
      itemized_charges: itemizedCharges,
      payments_received: payments,
      total_paid: totalPaid,
      gst_invoice_sent_at: s.gst_invoice_sent_at ?? null,
    };
  });

  // ── Booking GST tasks ────────────────────────────────────────────────────
  // Fix #4: Skip booking tasks in single-row mode. singleId targets a specific
  // billing_statement; returning all booking tasks would leak unrelated customer
  // data (PII: names, GSTINs, emails) to callers who only need one statement.
  if (singleId) {
    const singleStats = rows.reduce(
      (acc, r) => {
        acc.total_open += 1;
        if (r.has_discrepancy) acc.discrepancies += 1;
        else if (r.bucket === "gst_to_issue") acc.gst_to_issue += 1;
        else if (r.bucket === "payment_to_record") acc.payments_to_record += 1;
        if (r.aging_hours >= AGING_ESCALATE_HOURS) acc.aging_over_48h += 1;
        return acc;
      },
      { gst_to_issue: 0, payments_to_record: 0, discrepancies: 0, aging_over_48h: 0, total_open: 0 },
    );
    return NextResponse.json({
      stats: singleStats,
      rows,
      booking_rows: [],
      last_synced_at: lastSyncedAt,
    } satisfies InboxResponse);
  }

  // Fetch open booking_gst_tasks (or closed if tab=closed). These are non-contract
  // bookings that are checked_out + paid and need a Tally GST invoice.
  let bookingTasksQuery = supabase
    .from("booking_gst_tasks")
    .select(`
      id, handoff_state, updated_at, created_at,
      gst_invoice_number, tally_invoice_number, gst_invoice_sent_at,
      booking:bookings!booking_gst_tasks_booking_id_fkey(
        id, booking_number, total_amount_with_gst, total_amount, gst_amount, gst_rate,
        payment_status, payment_mode, payment_reference,
        booking_date, start_time, end_time, check_in_at, check_out_at,
        duration_hours, pricing_model,
        guest_name, guest_email, guest_phone, guest_company,
        space:spaces!bookings_space_id_fkey(id, name),
        location:locations!bookings_location_id_fkey(id, name),
        lead:leads!bookings_lead_id_fkey(id, first_name, last_name, company, email, phone, gst_number, billing_emails, id_proof_path),
        booking_addons(id, description, addon_type, quantity, unit_price, amount, gst_rate, gst_amount, total_with_gst, unit_label)
      )
    `);

  if (tab === "closed") {
    bookingTasksQuery = bookingTasksQuery.eq("handoff_state", "complete");
  } else {
    bookingTasksQuery = bookingTasksQuery.neq("handoff_state", "complete");
  }

  const { data: bookingTaskData } = await bookingTasksQuery
    .order("updated_at", { ascending: tab !== "closed" });

  type RawBookingTask = {
    id: string;
    handoff_state: string;
    updated_at: string;
    created_at: string;
    gst_invoice_number: string | null;
    tally_invoice_number: string | null;
    gst_invoice_sent_at: string | null;
    booking: {
      id: string;
      booking_number: string | null;
      total_amount_with_gst: number;
      total_amount: number;
      gst_amount: number | null;
      gst_rate: number | null;
      payment_status: string;
      payment_mode: string | null;
      payment_reference: string | null;
      booking_date: string | null;
      start_time: string | null;
      end_time: string | null;
      check_in_at: string | null;
      check_out_at: string | null;
      duration_hours: number | null;
      pricing_model: string | null;
      guest_name: string | null;
      guest_email: string | null;
      guest_phone: string | null;
      guest_company: string | null;
      space: { id: string; name: string } | null;
      location: { id: string; name: string } | null;
      lead: {
        id: string;
        first_name: string | null;
        last_name: string | null;
        company: string | null;
        email: string | null;
        phone: string | null;
        gst_number: string | null;
        id_proof_path: string | null;
      } | null;
      booking_addons: {
        id: string;
        description: string;
        addon_type: string;
        quantity: number;
        unit_price: number;
        amount: number;
        gst_rate: number;
        gst_amount: number;
        total_with_gst: number;
        unit_label: string | null;
      }[];
    } | null;
  };

  const rawBookingTasks = (bookingTaskData || []) as unknown as RawBookingTask[];

  // Apply search filter to booking tasks
  const filteredBookingTasks = q
    ? rawBookingTasks.filter((t) => {
        const lc = q.toLowerCase();
        const lead = t.booking?.lead;
        const haystack: string[] = [
          t.booking?.booking_number ?? "",
          t.gst_invoice_number ?? "",
          t.tally_invoice_number ?? "",
          lead?.gst_number ?? "",
          lead?.company ?? "",
          lead?.first_name ?? "",
          lead?.last_name ?? "",
          lead?.email ?? "",
          t.booking?.guest_name ?? "",
          t.booking?.guest_email ?? "",
          t.booking?.guest_company ?? "",
          t.booking?.space?.name ?? "",
        ];
        return haystack.some((h) => h.toLowerCase().includes(lc));
      })
    : rawBookingTasks;

  // Fetch uploads and payment confirmations for booking tasks
  const bookingTaskIds = filteredBookingTasks.map((t) => t.id);
  const bookingIds = filteredBookingTasks.map((t) => t.booking?.id).filter(Boolean) as string[];

  // booking_payments (+ settlement) and gst_invoice_uploads are independent
  // of each other — both only need bookingIds/bookingTaskIds, which are
  // already in hand — so run them concurrently instead of one after the
  // other. (Settlement itself stays sequential *within* the payments branch
  // since it needs the razorpay_payment_ids the payments query returns.)
  const [bookingPaymentsMap, bookingUploadsMap] = await Promise.all([
    (async () => {
      const map = new Map<string, BookingPaymentConfirmation[]>();
      if (bookingIds.length === 0) return map;
      const { data: bpRows } = await supabase
        .from("booking_payments")
        .select("id, booking_id, amount, payment_mode, payment_reference, razorpay_payment_id, created_at, status, verification_notes, screenshot_path")
        .in("booking_id", bookingIds)
        .in("status", ["confirmed", "captured", "verified"])
        .order("created_at", { ascending: false });

      // Fetch settlement data for all Razorpay payment IDs in one query
      const rzpIds = (bpRows || [])
        .map((bp) => bp.razorpay_payment_id as string | null)
        .filter(Boolean) as string[];

      const settlementMap = new Map<string, { settled: boolean; settled_at: string | null; settlement_utr: string | null }>();
      if (rzpIds.length > 0) {
        const { data: sRows } = await supabase
          .from("razorpay_settlement_cache")
          .select("razorpay_payment_id, settled, settled_at, settlement_utr")
          .in("razorpay_payment_id", rzpIds);
        for (const s of sRows || []) {
          settlementMap.set(s.razorpay_payment_id as string, {
            settled: s.settled as boolean,
            settled_at: (s.settled_at as string | null) ?? null,
            settlement_utr: (s.settlement_utr as string | null) ?? null,
          });
        }
      }

      for (const bp of bpRows || []) {
        const bid = (bp as { booking_id: string }).booking_id;
        const rzpId = (bp.razorpay_payment_id as string | null) ?? null;
        const settlement = rzpId ? (settlementMap.get(rzpId) ?? null) : null;
        const list = map.get(bid) ?? [];
        list.push({
          id: bp.id as string,
          amount: Number(bp.amount),
          payment_mode: bp.payment_mode as string,
          payment_reference: (bp.payment_reference as string | null) ?? null,
          razorpay_payment_id: rzpId,
          created_at: bp.created_at as string,
          status: bp.status as string,
          verification_notes: (bp.verification_notes as string | null) ?? null,
          screenshot_path: (bp.screenshot_path as string | null) ?? null,
          settled: settlement?.settled ?? null,
          settled_at: settlement?.settled_at ?? null,
          settlement_utr: settlement?.settlement_utr ?? null,
        });
        map.set(bid, list);
      }
      return map;
    })(),
    (async () => {
      const map = new Map<string, InboxUpload>();
      if (bookingTaskIds.length === 0) return map;
      const { data: bookingUploads } = await supabase
        .from("gst_invoice_uploads")
        .select("id, booking_gst_task_id, tally_invoice_number, tally_invoice_series, irn, invoice_amount, uploaded_at, name_check_status, autofill_source, superseded_by")
        .in("booking_gst_task_id", bookingTaskIds)
        .is("superseded_by", null)
        .order("uploaded_at", { ascending: false });

      for (const u of bookingUploads || []) {
        const tid = (u as { booking_gst_task_id: string }).booking_gst_task_id;
        if (!map.has(tid)) {
          map.set(tid, {
            id: u.id as string,
            tally_invoice_number: u.tally_invoice_number as string,
            tally_invoice_series: u.tally_invoice_series as "SDIPL-REG" | "SDIPL-UNREG",
            irn: (u.irn as string | null) ?? null,
            invoice_amount: Number(u.invoice_amount),
            uploaded_at: u.uploaded_at as string,
            name_check_status: u.name_check_status as "pending" | "approved" | "overridden",
            autofill_source: u.autofill_source as "qr" | "pdf_text" | "bridge_match" | "manual",
          });
        }
      }
      return map;
    })(),
  ]);

  const bookingRows: BookingInboxRow[] = filteredBookingTasks.map((t) => {
    const lead = t.booking?.lead ?? null;
    const customerGstin = lead?.gst_number ?? null;
    const customerHasGstin = !!customerGstin;
    const upload = bookingUploadsMap.get(t.id) ?? null;

    // Whole-rupee comparison — see the matching comment on the statement
    // discrepancy check above.
    let hasDiscrepancy = false;
    let discrepancyReason: string | null = null;
    if (upload && Math.round(Number(upload.invoice_amount)) !== Math.round(Number(t.booking?.total_amount_with_gst ?? 0))) {
      hasDiscrepancy = true;
      discrepancyReason = `Upload amount ₹${upload.invoice_amount} does not match booking total ₹${t.booking?.total_amount_with_gst}`;
    }

    const agingHours = Math.max(0, Math.round((now - Date.parse(t.updated_at)) / 3_600_000));
    const bucket = bucketForBooking(t.handoff_state as BookingHandoffState, hasDiscrepancy);

    const customerName = lead?.company
      || t.booking?.guest_company
      || [lead?.first_name ?? t.booking?.guest_name, lead?.last_name].filter(Boolean).join(" ")
      || null;

    return {
      row_type: "booking" as const,
      task_id: t.id,
      booking_id: t.booking?.id ?? "",
      booking_number: t.booking?.booking_number ?? null,
      booking_date: t.booking?.booking_date ?? null,
      start_time: t.booking?.start_time ?? null,
      end_time: t.booking?.end_time ?? null,
      check_in_at: t.booking?.check_in_at ?? null,
      check_out_at: t.booking?.check_out_at ?? null,
      duration_hours: t.booking?.duration_hours ?? null,
      pricing_model: t.booking?.pricing_model ?? null,
      base_amount: Number(t.booking?.total_amount ?? 0),
      gst_amount: Number(t.booking?.gst_amount ?? 0),
      gst_rate: Number(t.booking?.gst_rate ?? 18),
      addons: (t.booking?.booking_addons ?? []),
      space_name: t.booking?.space?.name ?? null,
      location_name: t.booking?.location?.name ?? null,
      statement_total_amount: Math.round(Number(t.booking?.total_amount_with_gst ?? 0)),
      payment_status: t.booking?.payment_status ?? "paid",
      handoff_state: t.handoff_state as BookingHandoffState,
      bucket,
      aging_hours: agingHours,
      state_changed_at: t.updated_at,
      customer_name: customerName,
      customer_email: lead?.email ?? t.booking?.guest_email ?? null,
      customer_phone: lead?.phone ?? t.booking?.guest_phone ?? null,
      lead_id: lead?.id ?? null,
      lead_id_proof_path: lead?.id_proof_path ?? null,
      lead_billing_emails: ((lead as unknown as { billing_emails?: string[] })?.billing_emails ?? null),
      customer_gstin: customerGstin,
      irn_required: customerHasGstin,
      expected_series: customerHasGstin ? "SDIPL-REG" : "SDIPL-UNREG",
      expected_prefix: customerHasGstin ? "SD/A/" : "SD/B/",
      latest_upload: upload,
      has_discrepancy: hasDiscrepancy,
      discrepancy_reason: discrepancyReason,
      gst_invoice_sent_at: t.gst_invoice_sent_at ?? null,
      payment_confirmations: (() => {
        const fromPaymentsTable = bookingPaymentsMap.get(t.booking?.id ?? "") ?? [];
        if (fromPaymentsTable.length > 0) return fromPaymentsTable;
        // Fallback: synthesize from booking-level payment_mode / payment_reference
        if (t.booking?.payment_mode && t.booking.payment_status === "paid") {
          return [{
            id: t.booking.id,
            amount: Number(t.booking.total_amount_with_gst ?? 0),
            payment_mode: t.booking.payment_mode,
            payment_reference: t.booking.payment_reference ?? null,
            razorpay_payment_id: null,
            created_at: t.updated_at,
            status: "paid",
            verification_notes: null,
            screenshot_path: null,
            settled: null,
            settled_at: null,
            settlement_utr: null,
          } satisfies BookingPaymentConfirmation];
        }
        return [];
      })(),
    };
  });

  const stats = rows.reduce(
    (acc, r) => {
      acc.total_open += 1;
      if (r.has_discrepancy) acc.discrepancies += 1;
      else if (r.bucket === "gst_to_issue") acc.gst_to_issue += 1;
      else if (r.bucket === "payment_to_record") acc.payments_to_record += 1;
      if (r.aging_hours >= AGING_ESCALATE_HOURS) acc.aging_over_48h += 1;
      return acc;
    },
    { gst_to_issue: 0, payments_to_record: 0, discrepancies: 0, aging_over_48h: 0, total_open: 0 },
  );

  // Fold booking rows into stats
  for (const br of bookingRows) {
    if (br.handoff_state === "complete") continue;
    stats.total_open += 1;
    if (br.has_discrepancy) stats.discrepancies += 1;
    else if (br.bucket === "gst_to_issue") stats.gst_to_issue += 1;
    if (br.aging_hours >= AGING_ESCALATE_HOURS) stats.aging_over_48h += 1;
  }

  const response: InboxResponse = {
    stats,
    rows,
    booking_rows: bookingRows,
    last_synced_at: lastSyncedAt,
    ...(tab === "closed" && !singleId ? {
      has_more: rows.length > CLOSED_PAGE_SIZE,
      total_closed: undefined,
    } : {}),
  };

  // Trim the extra sentinel row used to detect has_more
  if (tab === "closed" && !singleId && response.rows.length > CLOSED_PAGE_SIZE) {
    response.rows = response.rows.slice(0, CLOSED_PAGE_SIZE);
    response.has_more = true;
  } else if (tab === "closed" && !singleId) {
    response.has_more = false;
  }

  return NextResponse.json(response);
}

/**
 * Synthesizes a chronological timeline of milestone events for one statement.
 *
 * Sources, in declared order (sort happens after collection):
 *   - billing_statements.created_at        → statement_created
 *   - billing_statements.proforma_sent_at  → pi_sent
 *   - billing_payments rows                → payment_received (one per row)
 *   - gst_invoice_uploads rows             → gst_uploaded (one per row)
 *   - billing_statements.tally_delivered_at → gst_sent
 *   - audit_trail rows with changes.handoff_state → state_changed
 *   - billing_statements.voided_at         → voided
 */
function buildTimelineEvents(args: {
  statement: {
    id: string;
    created_at: string;
    proforma_sent_at: string | null;
    tally_delivered_at: string | null;
    voided_at: string | null;
    void_reason: string | null;
    statement_number: string | null;
    total_amount: number;
  };
  payments: InboxPayment[];
  uploads: Array<{
    id: string;
    tally_invoice_number: string;
    uploaded_at: string;
    uploaded_by: string | null;
    superseded_by: string | null;
  }>;
  auditEntries: Array<{
    action: string;
    changes: Record<string, unknown> | null;
    performed_by: string | null;
    created_at: string;
  }>;
  /** uploaded_by (auth.users id) → display name, resolved by the caller. */
  uploaderNameByAuthId: Map<string, string>;
}): TimelineEvent[] {
  const events: TimelineEvent[] = [];

  events.push({
    kind: "statement_created",
    at: args.statement.created_at,
    label: `Statement ${args.statement.statement_number ?? ""} created`.trim(),
    details: { total_amount: args.statement.total_amount },
  });

  if (args.statement.proforma_sent_at) {
    events.push({
      kind: "pi_sent",
      at: args.statement.proforma_sent_at,
      label: "Proforma invoice sent to customer",
      details: {},
    });
  }

  for (const p of args.payments) {
    const refSuffix = p.payment_reference ? ` · ${p.payment_reference}` : "";
    const bySuffix = p.recorded_by_name ? ` — by ${p.recorded_by_name}` : "";
    events.push({
      kind: "payment_received",
      at: p.payment_date,
      label: `Payment received: ₹${p.amount.toLocaleString("en-IN")} via ${p.payment_mode}${refSuffix}${bySuffix}`,
      details: {
        amount: p.amount,
        mode: p.payment_mode,
        reference: p.payment_reference,
        razorpay_payment_id: p.razorpay_payment_id,
        recorded_by_name: p.recorded_by_name,
      },
    });
  }

  for (const u of args.uploads) {
    const supersededNote = u.superseded_by ? " (superseded)" : "";
    const uploaderName = u.uploaded_by ? args.uploaderNameByAuthId.get(u.uploaded_by) ?? null : null;
    const bySuffix = uploaderName ? ` — by ${uploaderName}` : "";
    events.push({
      kind: "gst_uploaded",
      at: u.uploaded_at,
      label: `GST invoice uploaded: ${u.tally_invoice_number}${supersededNote}${bySuffix}`,
      details: {
        upload_id: u.id,
        invoice_number: u.tally_invoice_number,
        superseded: !!u.superseded_by,
        uploaded_by: u.uploaded_by,
        uploaded_by_name: uploaderName,
      },
    });
  }

  if (args.statement.tally_delivered_at) {
    events.push({
      kind: "gst_sent",
      at: args.statement.tally_delivered_at,
      label: "GST invoice sent to customer",
      details: {},
    });
  }

  // State changes from audit_trail — only include rows that actually
  // recorded a handoff_state transition. Skips noise like other field edits.
  for (const a of args.auditEntries) {
    const c = a.changes as { handoff_state?: { old: string | null; new: string }; trigger?: string } | null;
    if (!c?.handoff_state) continue;
    const fromLabel = c.handoff_state.old
      ? (HANDOFF_STATE_LABELS[c.handoff_state.old as HandoffState] ?? c.handoff_state.old)
      : "(initial)";
    const toLabel = HANDOFF_STATE_LABELS[c.handoff_state.new as HandoffState] ?? c.handoff_state.new;
    events.push({
      kind: "state_changed",
      at: a.created_at,
      label: `State: ${fromLabel} → ${toLabel}`,
      details: {
        from: c.handoff_state.old,
        to: c.handoff_state.new,
        trigger: c.trigger,
        performed_by: a.performed_by,
      },
    });
  }

  if (args.statement.voided_at) {
    events.push({
      kind: "voided",
      at: args.statement.voided_at,
      label: `Statement voided${args.statement.void_reason ? ` — ${args.statement.void_reason}` : ""}`,
      details: { void_reason: args.statement.void_reason },
    });
  }

  events.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return events;
}
