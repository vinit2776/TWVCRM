import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { isDeadBillStatus } from "@/lib/constants";
import { getChainState } from "@/lib/procurement/chain-lock";
import { auditAmcs, type AuditPoInput } from "@/lib/procurement/amc-audit";

const AUDIT_ROLES = ["admin", "manager", "accounts"];
const CHAIN_BATCH = 5;

const PO_SELECT = `
  id, po_number, po_type, status, amc_status, amc_terminated_at,
  amc_start_date, amc_end_date, amc_visits_covered, amc_visits_used,
  billing_cycle, cycle_count, opening_cycles, unit_cost_per_cycle,
  total_ordered_amount, linked_asset_id, created_at,
  procurement_vendors(name),
  locations(name),
  purchase_requests(pr_number, department, expenditure_type),
  purchase_order_items(linked_asset_id)
`;

type Row = Record<string, unknown>;
const one = <T,>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? v[0] ?? null : v ?? null);
const num = (v: unknown) => Number(v ?? 0);

/**
 * GET /api/procurement/amc/audit
 * Read-only health check of every AMC: what is wrong with its setup and what money
 * (bills, payments, TDS) is attached, so it is clear which can stay, which can be fixed
 * in place and which have to be retired and set up again. Writes nothing.
 */
export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser || !AUDIT_ROLES.includes(dbUser.role)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  // An AMC is whatever the material request says is one, or whatever has been given AMC dates —
  // so a contract that was set up wrongly still shows up here rather than hiding from the report.
  const [byRequest, byDates] = await Promise.all([
    supabase.from("purchase_orders").select(`${PO_SELECT}, pr:purchase_requests!inner(expenditure_type)`).eq("pr.expenditure_type", "amc"),
    supabase.from("purchase_orders").select(PO_SELECT).or("amc_start_date.not.is.null,amc_status.neq.inactive"),
  ]);
  const err = byRequest.error ?? byDates.error;
  if (err) return NextResponse.json({ error: err.message }, { status: 500 });

  const poMap = new Map<string, Row>();
  for (const r of [...(byRequest.data ?? []), ...(byDates.data ?? [])] as unknown as Row[]) poMap.set(r.id as string, r);
  const pos = [...poMap.values()];
  const poIds = pos.map((p) => p.id as string);
  if (poIds.length === 0) return NextResponse.json({ data: { rows: [], summary: { total: 0, byBucket: {}, moneyTouched: 0 } } });

  const { data: bills, error: billErr } = await supabase
    .from("vendor_bills")
    .select("id, po_id, bill_number, approval_status, payment_status, total_amount")
    .in("po_id", poIds);
  if (billErr) return NextResponse.json({ error: billErr.message }, { status: 500 });
  const liveBills = (bills ?? []).filter((b) => !isDeadBillStatus(b.approval_status as string));
  const billIds = liveBills.map((b) => b.id as string);

  const [paymentsRes, tdsRes, eventsRes] = await Promise.all([
    billIds.length
      ? supabase.from("vendor_bill_payments").select("bill_id, amount").in("bill_id", billIds).is("reversed_at", null)
      : Promise.resolve({ data: [] as Row[], error: null }),
    billIds.length
      ? supabase.from("vendor_bill_tds").select("bill_id, tds_amount, status").in("bill_id", billIds).is("reversed_at", null)
      : Promise.resolve({ data: [] as Row[], error: null }),
    supabase.from("amc_service_events").select("po_id").in("po_id", poIds),
  ]);
  const readErr = paymentsRes.error ?? tdsRes.error ?? eventsRes.error;
  if (readErr) return NextResponse.json({ error: readErr.message }, { status: 500 });

  const billPo = new Map(liveBills.map((b) => [b.id as string, b.po_id as string]));
  const sumByPo = (rows: Row[] | null, field: string) => {
    const m = new Map<string, number>();
    for (const r of rows ?? []) {
      const po = billPo.get(r.bill_id as string);
      if (po) m.set(po, (m.get(po) ?? 0) + num(r[field]));
    }
    return m;
  };
  const paidByPo = sumByPo(paymentsRes.data as Row[] | null, "amount");
  const tdsByPo = sumByPo(tdsRes.data as Row[] | null, "tds_amount");
  const tdsDeposited = new Map<string, number>();
  for (const t of (tdsRes.data ?? []) as Row[]) {
    const po = billPo.get(t.bill_id as string);
    if (po && t.status === "deposited") tdsDeposited.set(po, (tdsDeposited.get(po) ?? 0) + num(t.tds_amount));
  }
  const eventsByPo = new Map<string, number>();
  for (const e of (eventsRes.data ?? []) as Row[]) eventsByPo.set(e.po_id as string, (eventsByPo.get(e.po_id as string) ?? 0) + 1);

  const inputs: AuditPoInput[] = pos.map((p) => {
    const id = p.id as string;
    const mine = liveBills.filter((b) => b.po_id === id);
    const assets = new Set<string>();
    for (const i of (p.purchase_order_items ?? []) as Row[]) if (i.linked_asset_id) assets.add(i.linked_asset_id as string);
    if (p.linked_asset_id) assets.add(p.linked_asset_id as string);
    return {
      id,
      po_number: p.po_number as string,
      status: p.status as string,
      po_type: (p.po_type as string) ?? null,
      amc_terminated_at: (p.amc_terminated_at as string) ?? null,
      amc_start_date: (p.amc_start_date as string) ?? null,
      amc_end_date: (p.amc_end_date as string) ?? null,
      billing_cycle: (p.billing_cycle as string) ?? null,
      cycle_count: p.cycle_count != null ? num(p.cycle_count) : null,
      total_ordered_amount: num(p.total_ordered_amount),
      assetIds: [...assets],
      liveBills: mine.length,
      billedTotal: mine.reduce((s, b) => s + num(b.total_amount), 0),
    };
  });
  const audit = auditAmcs(inputs);

  // Whether a correction would be refused: the lock is computed per chain, so ask in small batches.
  const chainStates = new Map<string, string>();
  for (let i = 0; i < poIds.length; i += CHAIN_BATCH) {
    await Promise.all(
      poIds.slice(i, i + CHAIN_BATCH).map(async (id) => {
        try {
          const found = await getChainState(supabase, { poId: id });
          chainStates.set(id, found?.chain.state ?? "open");
        } catch {
          chainStates.set(id, "unknown");
        }
      })
    );
  }

  const rows = pos.map((p) => {
    const id = p.id as string;
    const input = inputs.find((i) => i.id === id)!;
    const result = audit.get(id)!;
    const paid = paidByPo.get(id) ?? 0;
    const tds = tdsByPo.get(id) ?? 0;
    return {
      id,
      po_number: input.po_number,
      pr_number: one(p.purchase_requests as { pr_number: string } | { pr_number: string }[] | null)?.pr_number ?? null,
      vendor: one(p.procurement_vendors as { name: string } | { name: string }[] | null)?.name ?? null,
      location: one(p.locations as { name: string } | { name: string }[] | null)?.name ?? null,
      status: input.status,
      po_type: input.po_type,
      terminated: !!input.amc_terminated_at,
      amc_start_date: input.amc_start_date,
      amc_end_date: input.amc_end_date,
      billing_cycle: input.billing_cycle,
      cycle_count: input.cycle_count,
      opening_cycles: num(p.opening_cycles),
      po_value: input.total_ordered_amount,
      asset_count: input.assetIds.length,
      visits_logged: eventsByPo.get(id) ?? 0,
      live_bills: input.liveBills,
      billed_total: input.billedTotal,
      paid_total: paid,
      tds_total: tds,
      tds_deposited: tdsDeposited.get(id) ?? 0,
      money_touched: paid > 0 || tds > 0,
      chain_state: chainStates.get(id) ?? "open",
      bucket: result.bucket,
      issues: result.issues,
    };
  });

  const byBucket: Record<string, number> = {};
  for (const r of rows) byBucket[r.bucket] = (byBucket[r.bucket] ?? 0) + 1;

  return NextResponse.json({
    data: {
      rows: rows.sort((a, b) => a.bucket.localeCompare(b.bucket) || a.po_number.localeCompare(b.po_number)),
      summary: {
        total: rows.length,
        byBucket,
        moneyTouched: rows.filter((r) => r.money_touched).length,
        tdsOnChallan: rows.filter((r) => r.tds_deposited > 0).length,
      },
    },
  });
}
