import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { isContractOperational } from "@/lib/constants";

/**
 * GET /api/billing/usage-rollup?year=YYYY&month=M
 *
 * Returns one row per contract that has any usage activity in the given
 * calendar month (IST). Powers the Usage tab on /billing: per-contract
 * review-and-send workflow.
 *
 * Each row aggregates:
 *   • usage_charges (ad-hoc, facility quota overage, booking auto-rolls)
 *   • service_usage_records (printer / service overages)
 * Plus the existing usage statement for the same (contract, month) if one
 * already exists — so the UI can show DRAFT / SENT / PAID badges and link to
 * the PDF.
 *
 * "Free" vs "Paid" split is inferred from the line amount:
 *   amount <= 0 → free (e.g. ₹0 booking auto-rolls within quota)
 *   amount  > 0 → paid
 */
export async function GET(req: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const year  = parseInt(searchParams.get("year") || "0");
  const month = parseInt(searchParams.get("month") || "0");
  if (!year || !month || month < 1 || month > 12) {
    return NextResponse.json({ error: "year and month (1-12) are required" }, { status: 400 });
  }

  // Use admin client so RLS doesn't accidentally hide a contract's usage from
  // accounts staff. Auth already gated above.
  const admin = createAdminClient();

  const monthStart = `${year}-${String(month).padStart(2, "0")}-01`;
  const lastDay = new Date(year, month, 0).getDate();
  const monthEnd = `${year}-${String(month).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;

  // ── 1. Existing usage statements for the month ─────────────────────────
  const { data: stmts } = await admin
    .from("billing_statements")
    .select("id, statement_number, contract_id, status, payment_status, proforma_sent_at, total_amount, due_date")
    .eq("statement_type", "usage")
    .gte("period_start", monthStart)
    .lte("period_start", monthEnd)
    .is("voided_at", null);

  const stmtByContract = new Map<string, typeof stmts extends (infer T)[] | null ? T : never>();
  for (const s of stmts || []) {
    if (s.contract_id) stmtByContract.set(s.contract_id as string, s);
  }

  // ── 2. Raw usage charges in the month ──────────────────────────────────
  //   includes both pending (not linked) and historic (linked to the
  //   existing month statement). We want the full picture in the row, so
  //   we include both kinds.
  //
  //   These are two DISTINCT queries, not one range-filtered OR, because the
  //   created_at window only makes sense for surfacing new pending charges.
  //   A charge already linked to this month's statement is authoritatively
  //   part of this period regardless of when the row was created — e.g. a
  //   correction/backfill charge created weeks later must still show up, or
  //   an operator can never review/finalize/re-send a statement that needed
  //   a post-hoc fix.
  const stmtIds = (stmts || []).map((s) => s.id);
  const { data: pendingCharges } = await admin
    .from("usage_charges")
    .select("id, contract_id, description, total, billing_statement_id, created_at")
    .is("billing_statement_id", null)
    .gte("created_at", `${monthStart}T00:00:00`)
    .lte("created_at", `${monthEnd}T23:59:59.999`);
  const { data: linkedCharges } = stmtIds.length > 0
    ? await admin
        .from("usage_charges")
        .select("id, contract_id, description, total, billing_statement_id, created_at")
        .in("billing_statement_id", stmtIds)
    : { data: [] };
  const charges = [...(pendingCharges || []), ...(linkedCharges || [])];

  // service_usage_records has no `used_at` or `total_amount` columns — the
  // correct period filter is period_year + period_month, and the billable
  // amount lives in the `amount` column (ex-GST overage). `description` also
  // doesn't exist; join service_catalog for the display name.
  const { data: svc } = await admin
    .from("service_usage_records")
    .select("id, contract_id, service_id, amount, billing_statement_id, notes, service:service_catalog(name, printer_column)")
    .eq("period_year", year)
    .eq("period_month", month)
    .or(
      stmtIds.length > 0
        ? `billing_statement_id.is.null,billing_statement_id.in.(${stmtIds.join(",")})`
        : "billing_statement_id.is.null",
    );

  // ── 3. Group by contract ───────────────────────────────────────────────
  interface LineItem { description: string; amount: number; source: "ad_hoc" | "service"; item_id: string }
  interface Agg {
    contract_id: string;
    free_count: number;
    paid_count: number;
    paid_total: number;
    line_items: LineItem[];
    has_print_quota?: boolean;
  }
  const agg = new Map<string, Agg>();
  const bump = (contract_id: string, item: LineItem) => {
    if (!contract_id) return;
    if (!agg.has(contract_id)) {
      agg.set(contract_id, { contract_id, free_count: 0, paid_count: 0, paid_total: 0, line_items: [] });
    }
    const row = agg.get(contract_id)!;
    if (item.amount > 0) { row.paid_count += 1; row.paid_total += item.amount; }
    else { row.free_count += 1; }
    row.line_items.push(item);
  };
  for (const c of charges || []) {
    bump(c.contract_id as string, { description: c.description || "—", amount: Number(c.total || 0), source: "ad_hoc", item_id: c.id as string });
  }
  for (const s of svc || []) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svcInfo = (s as any).service as { name?: string; printer_column?: string | null } | null;
    let svcDesc = svcInfo?.name || s.notes || "Service usage";
    if (svcInfo?.printer_column === "bw")     svcDesc = "Print - B/W";
    if (svcInfo?.printer_column === "colour") svcDesc = "Print - Colour";
    bump(s.contract_id as string, { description: svcDesc, amount: Number((s as unknown as { amount: number }).amount || 0), source: "service", item_id: s.service_id as string });
  }

  // Also surface contracts that already have a usage statement but zero raw
  // charges in this window (edge case: charges all deleted but statement
  // remains).
  for (const [cid] of stmtByContract) {
    if (!agg.has(cid)) {
      agg.set(cid, { contract_id: cid, free_count: 0, paid_count: 0, paid_total: 0, line_items: [] });
    }
  }

  // ── 4. Add operational + recently-terminated contracts ─────────────────
  //   Include terminated contracts where terminated_at >= month_start so that
  //   the final billing month (e.g. May for a contract terminated 30-May) is
  //   still accessible for print entry and PI dispatch. Also include
  //   renewal_in_progress contracts that are still operational (end_date not
  //   yet passed) — a contract mid-renewal is still the customer's live
  //   contract and should keep showing the Print Log section.
  const { data: allActiveContracts } = await admin
    .from("contracts")
    .select("id, status, end_date")
    .or(`status.eq.active,status.eq.renewal_in_progress,and(status.eq.terminated,terminated_at.gte.${monthStart})`);

  for (const c of allActiveContracts || []) {
    const cid = c.id as string;
    if (
      c.status === "renewal_in_progress" &&
      !isContractOperational({ status: c.status as string, end_date: c.end_date as string })
    ) {
      continue;
    }
    if (!agg.has(cid)) {
      agg.set(cid, { contract_id: cid, free_count: 0, paid_count: 0, paid_total: 0, line_items: [], has_print_quota: true });
    } else {
      (agg.get(cid) as Agg).has_print_quota = true;
    }
  }

  if (agg.size === 0) return NextResponse.json({ year, month, rows: [] });

  // ── 5. Enrich with contract + lead info ────────────────────────────────
  const { data: contracts } = await admin
    .from("contracts")
    .select("id, contract_number, billing_mode, tax_percentage, lead:leads(first_name, last_name, company)")
    .in("id", Array.from(agg.keys()));

  const rows = (contracts || []).map((c) => {
    const a = agg.get(c.id as string)!;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const lead: any = c.lead;
    const customer = lead?.company || `${lead?.first_name || ""} ${lead?.last_name || ""}`.trim() || "—";
    const stmt = stmtByContract.get(c.id as string);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cc = c as any;
    return {
      contract_id: c.id,
      contract_number: c.contract_number,
      billing_mode: cc.billing_mode ?? null,
      tax_percentage: Number(cc.tax_percentage ?? 18),
      customer,
      free_count: a.free_count,
      paid_count: a.paid_count,
      paid_total: Math.round(a.paid_total),
      has_print_quota: a.has_print_quota ?? false,
      line_items: a.line_items.map((li) => ({ ...li, amount: Math.round(li.amount), item_id: li.item_id })),
      statement: stmt
        ? {
            id: stmt.id,
            statement_number: stmt.statement_number,
            status: stmt.status,
            payment_status: stmt.payment_status,
            proforma_sent_at: stmt.proforma_sent_at,
            total_amount: Math.round(Number(stmt.total_amount || 0)),
            due_date: stmt.due_date,
          }
        : null,
    };
  }).sort((a, b) => a.contract_number.localeCompare(b.contract_number));

  return NextResponse.json({ year, month, rows });
}
