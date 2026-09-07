import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { paymentCredit, balanceDue } from "@/lib/settlement";
import {
  daysOverdue, isStale, depositIsChaseable, todayIst, type ReceivableRow,
} from "@/lib/receivables";
import { invoiceParty } from "@/lib/invoice-party";

/**
 * Average payment days per customer — amount-weighted (payment_date −
 * due_date) across every payment made in the trailing 12 months, rolled up
 * by customer rather than by contract. A customer with several contracts
 * gets one consistent number instead of a different figure on each of their
 * rows — keyed the same way the page's own partyOf() resolves a customer:
 * the lead behind a contract/proposal/ad-hoc invoice, or (since there's no
 * shared customer id across multiple VO cases) the case/aggregator itself.
 *
 * Windowed by payment_date, not due_date — a statement due 18 months ago but
 * paid last week still reflects this customer's *current* behavior.
 */
async function computeAvgPaymentDays(
  supabase: Awaited<ReturnType<typeof createClient>>
): Promise<Record<string, number>> {
  const cutoff = new Date(Date.parse(todayIst() + "T00:00:00Z") - 365 * 86400000)
    .toISOString().slice(0, 10);

  const { data: payments } = await supabase
    .from("billing_payments")
    .select(`
      amount, tds_amount, payment_date,
      billing_statement:billing_statements!billing_payments_billing_statement_id_fkey(
        due_date, voided_at, contract_id, proposal_id, invoice_id, case_id, aggregator_id
      )
    `)
    .gte("payment_date", cutoff);

  interface PayRow {
    amount: number;
    tds_amount: number | null;
    payment_date: string;
    billing_statement: {
      due_date: string | null;
      voided_at: string | null;
      contract_id: string | null;
      proposal_id: string | null;
      invoice_id: string | null;
      case_id: string | null;
      aggregator_id: string | null;
    } | null;
  }

  const rows = ((payments || []) as unknown as PayRow[]).filter(
    (p) => p.billing_statement?.due_date && !p.billing_statement.voided_at
  );

  const contractIds = [...new Set(rows.map((r) => r.billing_statement!.contract_id).filter((x): x is string => !!x))];
  const proposalIds = [...new Set(rows.map((r) => r.billing_statement!.proposal_id).filter((x): x is string => !!x))];
  const invoiceIds = [...new Set(rows.map((r) => r.billing_statement!.invoice_id).filter((x): x is string => !!x))];

  const [{ data: contractLeads }, { data: proposalLeads }, { data: invoiceLeads }] = await Promise.all([
    contractIds.length ? supabase.from("contracts").select("id, lead_id").in("id", contractIds) : Promise.resolve({ data: [] }),
    proposalIds.length ? supabase.from("proposals").select("id, lead_id").in("id", proposalIds) : Promise.resolve({ data: [] }),
    invoiceIds.length ? supabase.from("proforma_invoices").select("id, lead_id").in("id", invoiceIds) : Promise.resolve({ data: [] }),
  ]);
  const contractLeadMap = new Map((contractLeads || []).map((c: { id: string; lead_id: string | null }) => [c.id, c.lead_id]));
  const proposalLeadMap = new Map((proposalLeads || []).map((p: { id: string; lead_id: string | null }) => [p.id, p.lead_id]));
  const invoiceLeadMap = new Map((invoiceLeads || []).map((i: { id: string; lead_id: string | null }) => [i.id, i.lead_id]));

  const weightedSum = new Map<string, number>();
  const weightedAmount = new Map<string, number>();

  for (const r of rows) {
    const s = r.billing_statement!;
    const customerKey =
      (s.contract_id && contractLeadMap.get(s.contract_id)) ||
      (s.proposal_id && proposalLeadMap.get(s.proposal_id)) ||
      (s.invoice_id && invoiceLeadMap.get(s.invoice_id)) ||
      s.case_id ||
      s.aggregator_id ||
      null;
    if (!customerKey) continue;

    const amount = paymentCredit({ amount: r.amount, tds_amount: r.tds_amount });
    if (amount <= 0) continue;
    const daysDiff = (Date.parse(r.payment_date + "T00:00:00Z") - Date.parse(s.due_date! + "T00:00:00Z")) / 86400000;

    weightedSum.set(customerKey, (weightedSum.get(customerKey) || 0) + amount * daysDiff);
    weightedAmount.set(customerKey, (weightedAmount.get(customerKey) || 0) + amount);
  }

  const avgDays: Record<string, number> = {};
  for (const [key, amt] of weightedAmount) {
    avgDays[key] = Math.round((weightedSum.get(key)! / amt) * 10) / 10;
  }
  return avgDays;
}

/**
 * GET /api/accounting/receivables
 *
 * The data feed for the Accounts Receivable page. Returns every billing
 * statement that is finalized + not yet fully paid, enriched with contract +
 * lead + paid-to-date + computed days_overdue. The page does all bucket
 * filtering client-side so flipping between "All / Due soon / Overdue" is
 * instant.
 *
 * Excludes voided statements (voided_at IS NOT NULL).
 */
export async function GET(_req: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser || !["admin", "manager", "accounts", "sales_rep"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Unpaid + partially-paid finalized statements only. We never chase drafts
  // (nothing has been sent) or voided statements (back-references replaced by
  // a fresh draft).
  const { data: statements, error } = await supabase
    .from("billing_statements")
    .select(`
      id, statement_number, statement_type, period_start, period_end, due_date,
      subtotal, tax_amount, total_amount, payment_status, status,
      proforma_sent_at, proforma_viewed_at, gst_invoice_viewed_at,
      razorpay_payment_link_url, razorpay_payment_link_id,
      last_reminder_sent_at, reminder_count, voided_at, created_at,
      gst_invoice_number, pi_cancelled_at, accounted,
      contract:contracts!billing_statements_contract_id_fkey(
        id, contract_number, title, billing_mode,
        lead:leads!contracts_lead_id_fkey(id, first_name, last_name, company, email, phone, mobile, billing_emails)
      ),
      proposal:proposals!billing_statements_proposal_id_fkey(
        id, proposal_number,
        lead:leads!proposals_lead_id_fkey(id, first_name, last_name, company, email, phone, mobile, billing_emails)
      ),
      invoice:proforma_invoices!billing_statements_invoice_id_fkey(
        id, invoice_number, primary_head, internal_notes, attribution_purpose,
        lead:leads!proforma_invoices_lead_id_fkey(id, first_name, last_name, company, email, phone, mobile, billing_emails),
        attributed_contract:contracts!proforma_invoices_contract_id_fkey(id, contract_number)
      ),
      case:cases!billing_statements_case_id_fkey(
        id, case_number, client_name, client_company_name, client_email, client_phone, client_gst_number, bill_to,
        aggregator:aggregators!cases_aggregator_id_fkey(id, name, primary_email, primary_phone, gst_number)
      ),
      aggregator:aggregators!billing_statements_aggregator_id_fkey(id, name, primary_email, primary_phone, gst_number)
    `)
    .in("status", ["finalized", "exported"])
    .in("payment_status", ["unpaid", "partially_paid"])
    .is("voided_at", null)
    .order("due_date", { ascending: true, nullsFirst: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const statementIds = (statements || []).map((s) => s.id as string);
  // One round-trip to sum payments per statement instead of N selects.
  // Paid-to-date includes TDS (same settlement definition as the payment
  // route) — a TDS-bearing partial payment must not inflate balance_due.
  // Also collects the payment detail rows themselves (reference, mode, who
  // recorded it) — powers the "Payment received" dialog on partially-paid
  // rows, same shape as the Paid tab.
  let paidByStatement = new Map<string, number>();
  const paymentsByStatement = new Map<string, Array<{
    id: string; amount: number; payment_date: string; payment_mode: string;
    payment_reference: string | null; razorpay_payment_id: string | null;
    notes: string | null; recorded_by_user: { id: string; full_name: string } | null;
  }>>();
  if (statementIds.length > 0) {
    const { data: pays } = await supabase
      .from("billing_payments")
      .select(`
        billing_statement_id, id, amount, tds_amount, payment_date, payment_mode, created_at,
        payment_reference, razorpay_payment_id, notes,
        recorded_by_user:users!billing_payments_recorded_by_fkey(id, full_name)
      `)
      .in("billing_statement_id", statementIds)
      .order("created_at", { ascending: false });
    paidByStatement = (pays || []).reduce((map, p: { billing_statement_id: string; amount: number; tds_amount: number | null }) => {
      map.set(p.billing_statement_id, (map.get(p.billing_statement_id) || 0) + paymentCredit(p));
      return map;
    }, new Map<string, number>());
    for (const p of pays || []) {
      const sid = p.billing_statement_id as string;
      if (!paymentsByStatement.has(sid)) paymentsByStatement.set(sid, []);
      paymentsByStatement.get(sid)!.push({
        id: p.id as string,
        amount: p.amount as number,
        payment_date: p.payment_date as string,
        payment_mode: p.payment_mode as string,
        payment_reference: p.payment_reference as string | null,
        razorpay_payment_id: p.razorpay_payment_id as string | null,
        notes: p.notes as string | null,
        recorded_by_user: (p.recorded_by_user as unknown as { id: string; full_name: string } | null) ?? null,
      });
    }
  }

  // Open query count per statement — one grouped query for the page rather
  // than a fetch per row, same as the Tally Inbox badges. Scoped by
  // entity_type since `queries` spans every module.
  const openQueriesByStatement = new Map<string, number>();
  if (statementIds.length > 0) {
    const { data: openQueries } = await supabase
      .from("queries")
      .select("entity_id")
      .eq("entity_type", "billing_statement")
      .in("entity_id", statementIds)
      .eq("status", "open");
    for (const q of openQueries || []) {
      const id = (q as { entity_id: string }).entity_id;
      openQueriesByStatement.set(id, (openQueriesByStatement.get(id) ?? 0) + 1);
    }
  }

  // Pending deposit-adjustment requests per statement — surfaces on the row
  // so accounts/admin don't see a plain "unpaid/partially paid" balance and
  // conclude nothing is happening, when in fact an adjustment is already
  // sitting in someone's approval queue for that exact amount (the confusion
  // that motivated this: TWV-C-0079's two invoices looked untouched here
  // even though Prema had already requested adjustments against both).
  const depositAdjustmentsByStatement = new Map<string, Array<{
    id: string; amount: number; requested_at: string; requested_by_name: string | null;
  }>>();
  if (statementIds.length > 0) {
    const { data: adjustments } = await supabase
      .from("deposit_adjustments")
      .select("id, billing_statement_id, amount, requested_at, requester:users!deposit_adjustments_requested_by_fkey(full_name)")
      .in("billing_statement_id", statementIds)
      .eq("status", "pending_approval");
    for (const a of adjustments || []) {
      const sid = a.billing_statement_id as string;
      if (!depositAdjustmentsByStatement.has(sid)) depositAdjustmentsByStatement.set(sid, []);
      depositAdjustmentsByStatement.get(sid)!.push({
        id: a.id as string,
        amount: Number(a.amount),
        requested_at: a.requested_at as string,
        requested_by_name: (a.requester as unknown as { full_name: string } | null)?.full_name ?? null,
      });
    }
  }

  // Today in IST as a YYYY-MM-DD anchor for daysOverdue.
  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
  const todayIst = new Date(Date.now() + IST_OFFSET_MS).toISOString().slice(0, 10);
  const todayMs = Date.parse(todayIst + "T00:00:00Z");

  const rows = (statements || []).map((s) => {
    const paid = paidByStatement.get(s.id as string) || 0;
    const balance = balanceDue(s.total_amount as number, paid);
    let daysOverdue: number | null = null;
    if (s.due_date) {
      const dueMs = Date.parse((s.due_date as string) + "T00:00:00Z");
      daysOverdue = Math.floor((todayMs - dueMs) / 86400000);
    }
    return {
      ...s,
      amount_paid: Math.round(paid),
      balance_due: Math.round(balance),
      days_overdue: daysOverdue,
      open_query_count: openQueriesByStatement.get(s.id as string) ?? 0,
      payments: paymentsByStatement.get(s.id as string) ?? [],
      pending_deposit_adjustments: depositAdjustmentsByStatement.get(s.id as string) ?? [],
    };
  });

  // Quick aggregates for the header cards.
  const summary = {
    total_outstanding: rows.reduce((s, r) => s + r.balance_due, 0),
    count: rows.length,
    due_soon: rows.filter((r) => r.days_overdue !== null && r.days_overdue >= -7 && r.days_overdue < 0).length,
    overdue: rows.filter((r) => r.days_overdue !== null && r.days_overdue >= 0).length,
    overdue_30: rows.filter((r) => r.days_overdue !== null && r.days_overdue >= 30).length,
    oldest_days: rows.reduce((m, r) => Math.max(m, r.days_overdue ?? -Infinity), -Infinity),
  };

  const otherRows = await fetchOtherReceivables(supabase);
  const otherSummary = {
    total_outstanding: otherRows.reduce((s, r) => s + r.balance_due, 0),
    count: otherRows.length,
    overdue: otherRows.filter((r) => r.days_overdue !== null && r.days_overdue >= 0).length,
    stale: otherRows.filter((r) => r.is_stale).length,
  };

  const avgDays = await computeAvgPaymentDays(supabase);

  return NextResponse.json({ rows, summary, other_rows: otherRows, other_summary: otherSummary, avgDays });
}

/**
 * Deposits, top-ups and ad-hoc PIs — receivables that live outside
 * billing_statements and so were historically invisible to AR. Returned as
 * a separate array rather than merged into `rows`: the statement table is
 * bound tightly to the billing_statements shape, and these carry different
 * fields (no GST, no proforma lifecycle, no partial payments).
 */
export async function fetchOtherReceivables(
  supabase: Awaited<ReturnType<typeof createClient>>
): Promise<ReceivableRow[]> {
  const out: ReceivableRow[] = [];

  const partyOf = (lead: { first_name?: string; last_name?: string; company?: string } | null) =>
    lead?.company || [lead?.first_name, lead?.last_name].filter(Boolean).join(" ") || "(unnamed)";

  const finish = (
    base: Omit<ReceivableRow, "days_overdue" | "is_stale" | "balance_due">,
  ): ReceivableRow => ({
    ...base,
    balance_due: Math.round(base.total_amount - base.amount_paid),
    days_overdue: daysOverdue(base.due_date),
    is_stale: isStale(base.due_date),
  });

  // ── Proposal security deposits ─────────────────────────────────────────
  // Only accepted proposals: chasing a deposit on a rejected or still-open
  // proposal means pestering a prospect over money they never agreed to pay.
  const { data: deposits } = await supabase
    .from("proposals")
    .select(`
      id, proposal_number, status, security_deposit_amount, deposit_credit_amount,
      deposit_due_date, deposit_razorpay_link_url, deposit_razorpay_link_id,
      deposit_link_cancelled_at,
      deposit_reminder_count, deposit_last_reminder_sent_at,
      lead:leads!proposals_lead_id_fkey(id, first_name, last_name, company, email)
    `)
    .eq("deposit_payment_status", "pending")
    .gt("security_deposit_amount", 0);

  for (const d of deposits || []) {
    if (!depositIsChaseable({
      status: d.status as string,
      deposit_razorpay_link_id: d.deposit_razorpay_link_id as string | null,
      deposit_link_cancelled_at: d.deposit_link_cancelled_at as string | null,
    })) continue;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const lead = d.lead as any;
    const owed = Number(d.security_deposit_amount || 0) - Number(d.deposit_credit_amount || 0);
    if (owed <= 0) continue; // fully covered by a carried-forward deposit
    out.push(finish({
      id: d.id,
      kind: "deposit",
      reference: d.proposal_number,
      party_name: partyOf(lead),
      lead_id: lead?.id ?? null,
      lead_email: lead?.email ?? null,
      total_amount: owed,
      amount_paid: 0,
      due_date: d.deposit_due_date,
      payment_link_url: d.deposit_razorpay_link_url,
      followup_enabled: true,
      reminder_count: d.deposit_reminder_count || 0,
      last_reminder_sent_at: d.deposit_last_reminder_sent_at,
      href: `/proposals/${d.id}`,
    }));
  }

  // ── Deposit top-ups awaiting payment ───────────────────────────────────
  const { data: topups } = await supabase
    .from("deposit_topups")
    .select(`
      id, amount, due_date, razorpay_payment_link_url,
      reminder_count, last_reminder_sent_at,
      contract:contracts!deposit_topups_contract_id_fkey(
        id, contract_number,
        lead:leads!contracts_lead_id_fkey(id, first_name, last_name, company, email)
      )
    `)
    .eq("status", "pending");

  for (const t of topups || []) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const contract = t.contract as any;
    out.push(finish({
      id: t.id,
      kind: "topup",
      reference: contract?.contract_number || "—",
      party_name: partyOf(contract?.lead ?? null),
      lead_id: contract?.lead?.id ?? null,
      lead_email: contract?.lead?.email ?? null,
      total_amount: Number(t.amount || 0),
      amount_paid: 0,
      due_date: t.due_date,
      payment_link_url: t.razorpay_payment_link_url,
      followup_enabled: true,
      reminder_count: t.reminder_count || 0,
      last_reminder_sent_at: t.last_reminder_sent_at,
      href: contract?.id ? `/contracts/${contract.id}` : null,
      parent_id: contract?.id ?? null,
    }));
  }

  // ── Ad-hoc / proforma invoices ─────────────────────────────────────────
  // Can be raised against a lead OR a Virtual Office case (migration 00532)
  // — a case has no lead, so the buyer has to be resolved the same way
  // POST /api/cases/[id]/adhoc-invoices does: via invoiceParty(), which
  // reads the case's billing route (aggregator vs. direct client). Without
  // this, a case-billed invoice showed up here as "(unnamed)".
  const { data: invoices } = await supabase
    .from("proforma_invoices")
    .select(`
      id, invoice_number, title, total_amount, due_date, status, case_id,
      razorpay_link_url, followup_enabled, reminder_count, last_reminder_sent_at,
      lead:leads!proforma_invoices_lead_id_fkey(id, first_name, last_name, company, email),
      case:cases!proforma_invoices_case_id_fkey(
        id, case_number, client_name, client_company_name, client_email, client_phone,
        client_gst_number, aggregator_id, bill_to,
        aggregator:aggregators!cases_aggregator_id_fkey(name, billing_method, primary_email, primary_phone, gst_number)
      )
    `)
    .not("status", "in", "(paid,cancelled)");

  // Sending an invoice mirrors it into billing_statements specifically so it
  // flows through the same AR ladder and Tally handoff every other invoice
  // type uses (see /api/invoices/[id]/email) — that mirror, not this raw
  // proforma_invoices row, is the tracked receivable from that point on. Skip
  // any invoice that already has one, or it shows up twice on this page: once
  // here and once in the Detail view via its statement, under two different
  // ids with two different action sets. Only a still-draft invoice (never
  // sent, no mirror yet) belongs in this card.
  const invoiceIds = (invoices || []).map((inv) => inv.id);
  const invoicesWithStatement = new Set<string>();
  if (invoiceIds.length > 0) {
    const { data: linkedStatements } = await supabase
      .from("billing_statements")
      .select("invoice_id")
      .in("invoice_id", invoiceIds);
    for (const s of linkedStatements || []) {
      if (s.invoice_id) invoicesWithStatement.add(s.invoice_id as string);
    }
  }

  for (const inv of invoices || []) {
    if (invoicesWithStatement.has(inv.id)) continue;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const lead = inv.lead as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const caseRow = inv.case as any;
    const party = !lead && caseRow ? invoiceParty({ case: caseRow }) : null;
    out.push(finish({
      id: inv.id,
      kind: "adhoc_invoice",
      reference: inv.invoice_number,
      party_name: lead ? partyOf(lead) : (party?.name || "(unnamed)"),
      lead_id: lead?.id ?? null,
      lead_email: lead?.email ?? party?.email ?? null,
      total_amount: Number(inv.total_amount || 0),
      amount_paid: 0,
      due_date: inv.due_date,
      payment_link_url: inv.razorpay_link_url,
      followup_enabled: inv.followup_enabled !== false,
      reminder_count: inv.reminder_count || 0,
      last_reminder_sent_at: inv.last_reminder_sent_at,
      href: `/invoices/${inv.id}`,
    }));
  }

  // Most overdue first; undated rows sink to the bottom.
  return out.sort((a, b) => (b.days_overdue ?? -Infinity) - (a.days_overdue ?? -Infinity));
}
