import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { computeAmcCommitted } from "@/lib/procurement/amc-budget";
import { asString, fetchByIds, istMonthKey, round2, type DashRow } from "@/lib/dashboard-query";
import { fyDateRange, fyMonthKeys, fyStartYearOf, todayIst } from "@/lib/sales-widget";
import {
  PO_WIDGET_DEPARTMENTS,
  PO_WIDGET_STATES,
  derivePoState,
  normaliseDepartment,
  type PoBillShape,
  type PoWidgetDepartment,
  type PoWidgetState,
} from "@/lib/procurement-widget";

export const maxDuration = 30;

/**
 * GET /api/dashboard/procurement-po?fy=2026&company_id=&location_id=
 *   → PO value issued per month × department × state for the financial year,
 *     plus department budgets and committed material-request spend.
 * GET ...&view=documents&month=2026-09&state=&department=
 *   → the POs behind a selection.
 *
 * Read-only. Value is the PO's ordered amount before GST, attributed to the
 * month (IST) the PO was issued. Budgets follow the existing Procurement budget
 * screen exactly: committed material requests (approved and beyond) in the
 * month the request was created, against the company's monthly department
 * budget — and, for AMC, the annual budget. They are per company, so budget
 * figures only appear once a single company is selected.
 *
 * Access: admin, accounts.
 */

const PAGE = 1000;
const DOC_LIMIT = 25;
const COMMITTED_MR_STATUSES = ["approved", "partially_ordered", "po_created"];

type Admin = Awaited<ReturnType<typeof createAdminClient>>;

async function fetchPaged(admin: Admin, build: (from: number, to: number) => PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>): Promise<DashRow[]> {
  const out: DashRow[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    out.push(...((data ?? []) as DashRow[]));
    if (!data || data.length < PAGE) break;
  }
  return out;
}

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = await createAdminClient();
  const { data: dbUser } = await admin.from("users").select("role").eq("auth_id", user.id).single();
  if (!dbUser || !["admin", "accounts"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const sp = request.nextUrl.searchParams;
  const today = todayIst();
  const fyParam = parseInt(sp.get("fy") ?? "", 10);
  const fy = Number.isFinite(fyParam) && fyParam >= 2020 && fyParam <= 2100 ? fyParam : fyStartYearOf(today);
  const companyId = sp.get("company_id");
  const locationId = sp.get("location_id");
  const view = sp.get("view") === "documents" ? "documents" : "summary";
  const { start, end } = fyDateRange(fy);
  // FY boundaries are IST midnights.
  const fromTs = `${start}T00:00:00+05:30`;
  const toTs = `${end}T23:59:59+05:30`;

  try {
    const pos = await fetchPaged(admin, (from, to) => {
      let q = admin
        .from("purchase_orders")
        .select("id, po_number, status, total_ordered_amount, total_amount_with_gst, advance_amount, pr_id, vendor_id, location_id, created_at")
        .gte("created_at", fromTs)
        .lte("created_at", toTs)
        .order("created_at")
        .order("id")
        .range(from, to);
      if (companyId) q = q.eq("company_id", companyId);
      if (locationId) q = q.eq("location_id", locationId);
      return q;
    });

    const [prs, bills, vendors] = await Promise.all([
      fetchByIds(admin, "purchase_requests", "id, department", pos.map((p) => asString(p.pr_id)).filter(Boolean) as string[]),
      fetchByIds(admin, "vendor_bills", "po_id, total_amount, amount_paid, approval_status", pos.map((p) => p.id as string), "po_id"),
      view === "documents"
        ? fetchByIds(admin, "procurement_vendors", "id, name", pos.map((p) => asString(p.vendor_id)).filter(Boolean) as string[])
        : Promise.resolve([] as DashRow[]),
    ]);
    const deptByPr = new Map(prs.map((r) => [r.id as string, asString(r.department)]));
    const vendorName = new Map(vendors.map((v) => [v.id as string, asString(v.name) ?? "—"]));
    const billsByPo = new Map<string, PoBillShape[]>();
    for (const b of bills) {
      const id = b.po_id as string;
      const list = billsByPo.get(id) ?? [];
      list.push(b as unknown as PoBillShape);
      billsByPo.set(id, list);
    }

    const enriched = pos.map((p) => ({
      p,
      month: istMonthKey(p.created_at as string),
      department: normaliseDepartment(deptByPr.get(asString(p.pr_id) ?? "")),
      state: derivePoState({ status: asString(p.status) }, billsByPo.get(p.id as string) ?? []),
      value: Number(p.total_ordered_amount ?? 0),
    }));

    if (view === "documents") {
      const month = sp.get("month");
      const stateParam = sp.get("state");
      const deptParam = sp.get("department");
      const state = (PO_WIDGET_STATES as readonly string[]).includes(stateParam ?? "") ? (stateParam as PoWidgetState) : null;
      const department = (PO_WIDGET_DEPARTMENTS as readonly string[]).includes(deptParam ?? "") ? (deptParam as PoWidgetDepartment) : null;

      const docs = enriched
        // Cancelled POs are only listed when asked for by name.
        .filter((e) => (state ? e.state === state : e.state !== "cancelled"))
        .filter((e) => !month || e.month === month)
        .filter((e) => !department || e.department === department)
        .map((e) => ({
          id: e.p.id as string,
          po_number: asString(e.p.po_number) ?? "—",
          vendor: vendorName.get(asString(e.p.vendor_id) ?? "") ?? "—",
          department: e.department,
          state: e.state,
          value: round2(e.value),
          value_with_gst: round2(Number(e.p.total_amount_with_gst ?? e.value)),
          advance: round2(Number(e.p.advance_amount ?? 0)),
        }))
        .sort((a, b) => b.value - a.value);

      return NextResponse.json({
        data: {
          documents: docs.slice(0, DOC_LIMIT),
          total_count: docs.length,
          total_value: round2(docs.reduce((a, d) => a + d.value, 0)),
        },
      });
    }

    // ── Summary: PO value month × department × state ───────────────────────
    const monthKeys = fyMonthKeys(fy);
    type Cell = { v: number; n: number };
    const cells: Record<string, Record<string, Record<string, Cell>>> = {};
    for (const e of enriched) {
      if (!monthKeys.includes(e.month)) continue;
      const cell = ((cells[e.month] ??= {})[e.department] ??= {})[e.state] ??= { v: 0, n: 0 };
      cell.v += e.value;
      cell.n += 1;
    }
    for (const byDept of Object.values(cells)) {
      for (const byState of Object.values(byDept)) {
        for (const c of Object.values(byState)) c.v = round2(c.v);
      }
    }

    // ── Budgets (per company) ──────────────────────────────────────────────
    let budget: {
      monthly: Record<string, number | null>;
      amc_annual: number | null;
      amc_committed: number;
      committed_by_month: Record<string, Record<string, number>>;
    } | null = null;

    if (companyId) {
      const [budgetRows, mrRows, amcCommitted] = await Promise.all([
        admin
          .from("department_budgets")
          .select("department, location_id, monthly_budget, budget_period, financial_year, is_active")
          .eq("company_id", companyId)
          .eq("is_active", true)
          .then((r) => (r.data ?? []) as DashRow[]),
        fetchPaged(admin, (from, to) => {
          let q = admin
            .from("purchase_requests")
            .select("department, total_estimated_amount, created_at")
            .eq("company_id", companyId)
            .eq("expenditure_type", "operational")
            .in("status", COMMITTED_MR_STATUSES)
            .gte("created_at", fromTs)
            .lte("created_at", toTs)
            .order("created_at")
            .order("id")
            .range(from, to);
          if (locationId) q = q.eq("location_id", locationId);
          return q;
        }),
        computeAmcCommitted(admin, fromTs, toTs, companyId),
      ]);

      // With a centre selected, use that centre's own budget row (as the budget
      // screen does); otherwise the company-wide row.
      const monthly: Record<string, number | null> = {};
      for (const dept of PO_WIDGET_DEPARTMENTS) {
        const row = budgetRows.find(
          (b) =>
            b.department === dept &&
            (b.budget_period ?? "monthly") === "monthly" &&
            (locationId ? b.location_id === locationId : b.location_id == null)
        );
        monthly[dept] = row?.monthly_budget != null ? Number(row.monthly_budget) : null;
      }
      const amcRow = budgetRows.find(
        (b) => b.department === "amc" && b.budget_period === "annual" && Number(b.financial_year) === fy && b.location_id == null
      );

      const committedByMonth: Record<string, Record<string, number>> = {};
      for (const mr of mrRows) {
        const m = istMonthKey(mr.created_at as string);
        const d = normaliseDepartment(asString(mr.department));
        const row = (committedByMonth[m] ??= {});
        row[d] = (row[d] ?? 0) + Number(mr.total_estimated_amount ?? 0);
      }
      for (const row of Object.values(committedByMonth)) for (const k of Object.keys(row)) row[k] = round2(row[k]);

      budget = {
        monthly,
        amc_annual: amcRow?.monthly_budget != null ? Number(amcRow.monthly_budget) : null,
        amc_committed: round2(amcCommitted),
        committed_by_month: committedByMonth,
      };
    }

    return NextResponse.json({ data: { fy, today, months: monthKeys, cells, budget } });
  } catch (err) {
    // Message only — rows carry vendor and spend detail, never log them.
    console.error("[dashboard/procurement-po]", err instanceof Error ? err.message : "unknown error");
    return NextResponse.json({ error: "Failed to load procurement data" }, { status: 500 });
  }
}
