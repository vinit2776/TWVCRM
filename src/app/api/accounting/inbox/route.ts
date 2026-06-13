import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  AGING_ESCALATE_HOURS,
  bucketFor,
  INBOX_OPEN_STATES,
  isInboxRole,
  type HandoffState,
  type InboxPayment,
  type InboxResponse,
  type InboxRow,
  type InboxSnapshot,
  type InboxUpload,
} from "@/lib/tally-handoff";

/**
 * GET /api/accounting/inbox
 *
 * Read-only feed for the Accounts Inbox page. Returns:
 *   - stats: counts by bucket (gst to issue, payments to record, discrepancies, aging)
 *   - rows: open handoff items (handoff_state IS NOT NULL AND <> 'complete')
 *           enriched with contract + lead + latest upload + latest tally snapshot match
 *   - last_synced_at: most recent tally_voucher_snapshots.last_synced_at (or null)
 *
 * Until PR #2c starts writing handoff_state on payment capture / upload, the
 * rows array will be empty for new statements. Existing legacy statements
 * keep handoff_state = NULL and are excluded by design.
 */
export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest) {
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

  // Pull open inbox items. We select the columns the UI needs plus
  // contract → lead via the standard FK joins (same pattern as receivables).
  const { data: statements, error } = await supabase
    .from("billing_statements")
    .select(`
      id, statement_number, period_start, period_end,
      total_amount, payment_status, handoff_state, updated_at,
      statement_type, fixed_amount, usage_amount,
      service_usage_amount, booking_usage_amount,
      subtotal, tax_percentage, tax_amount,
      cgst_amount, sgst_amount, igst_amount,
      is_interstate, place_of_supply, hsn_sac_code,
      contract:contracts!billing_statements_contract_id_fkey(
        id, contract_number, title, billing_mode,
        lead:leads!contracts_lead_id_fkey(
          id, first_name, last_name, company, email, phone, gst_number
        )
      )
    `)
    .in("handoff_state", INBOX_OPEN_STATES as readonly string[])
    .order("updated_at", { ascending: true });

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
  }>;

  const statementIds = statementList.map((s) => s.id);

  // PERF: the four side queries below used to await sequentially, adding
  // 4× the slowest single round-trip to the API response time. They have
  // no dependencies on each other, so we fan them out via Promise.all.
  // Combined with the 00256 index on billing_payments.billing_statement_id,
  // this should bring inbox load from "noticeably slow" to "snappy."

  const noIds = statementIds.length === 0;

  const [uploadsRes, snapshotsRes, lastSyncRes, paymentsRes] = await Promise.all([
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
      .select("id, billing_statement_id, amount, payment_date, payment_mode, payment_reference, razorpay_payment_id")
      .in("billing_statement_id", statementIds)
      .order("payment_date", { ascending: false }),
  ]);

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

  // Payments per statement.
  const paymentsByStatement = new Map<string, InboxPayment[]>();
  for (const p of paymentsRes.data || []) {
    const sid = (p as { billing_statement_id: string }).billing_statement_id;
    const list = paymentsByStatement.get(sid) ?? [];
    list.push({
      id: p.id as string,
      amount: Number(p.amount),
      payment_date: p.payment_date as string,
      payment_mode: p.payment_mode as string,
      payment_reference: (p.payment_reference as string | null) ?? null,
      razorpay_payment_id: (p.razorpay_payment_id as string | null) ?? null,
    });
    paymentsByStatement.set(sid, list);
  }

  const now = Date.now();
  const rows: InboxRow[] = statementList.map((s) => {
    const upload = uploadByStatement.get(s.id) ?? null;
    const snapshot = snapshotByStatement.get(s.id) ?? null;

    // Discrepancy detection. The bridge sees a Tally voucher whose amount
    // doesn't match what we expected, OR the upload's amount diverges from
    // the statement total. Either case blocks send.
    let hasDiscrepancy = false;
    let discrepancyReason: string | null = null;
    if (upload && Number(upload.invoice_amount).toFixed(2) !== Number(s.total_amount).toFixed(2)) {
      hasDiscrepancy = true;
      discrepancyReason = `Upload amount ₹${upload.invoice_amount} does not match statement total ₹${s.total_amount}`;
    } else if (snapshot && snapshot.voucher_amount != null &&
               Number(snapshot.voucher_amount).toFixed(2) !== Number(s.total_amount).toFixed(2)) {
      hasDiscrepancy = true;
      discrepancyReason = `Tally voucher amount ₹${snapshot.voucher_amount} does not match statement total ₹${s.total_amount}`;
    }

    const stateChangedAt = s.updated_at;
    const agingHours = Math.max(0, Math.round((now - Date.parse(stateChangedAt)) / 3_600_000));
    const bucket = bucketFor(s.handoff_state, hasDiscrepancy) ?? "in_flight";

    const customerHasGstin = !!s.contract?.lead?.gst_number;
    const payments = paymentsByStatement.get(s.id) ?? [];
    const totalPaid = payments.reduce((sum, p) => sum + p.amount, 0);

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
      contract: s.contract
        ? {
            id: s.contract.id,
            contract_number: s.contract.contract_number,
            title: s.contract.title,
            billing_mode: s.contract.billing_mode,
            lead: s.contract.lead,
          }
        : null,
      latest_upload: upload,
      latest_snapshot: snapshot,
      has_discrepancy: hasDiscrepancy,
      discrepancy_reason: discrepancyReason,
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
      payments_received: payments,
      total_paid: totalPaid,
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

  const response: InboxResponse = {
    stats,
    rows,
    last_synced_at: lastSyncedAt,
  };

  return NextResponse.json(response);
}
