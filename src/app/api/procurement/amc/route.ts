import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

function getCurrentFY(date = new Date()): number {
  const month = date.getMonth() + 1;
  return month >= 4 ? date.getFullYear() : date.getFullYear() - 1;
}

function getFYWindow(fyStart: number) {
  return {
    fyStart: new Date(fyStart, 3, 1).toISOString(),
    fyEnd: new Date(fyStart + 1, 2, 31, 23, 59, 59).toISOString(),
  };
}

/**
 * GET /api/procurement/amc
 * Returns service POs linked to AMC material requests that have at least
 * one vendor bill with payment_status = 'paid' or 'partially_paid'.
 * Also returns the current FY AMC budget summary.
 */
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 403 });

  const { searchParams } = new URL(request.url);
  const amcStatus   = searchParams.get("amc_status");
  const locationId  = searchParams.get("location_id");

  // ── Fetch AMC service POs with vendor bill payment info ──────────────────
  const query = supabase
    .from("purchase_orders")
    .select(`
      id, po_number, po_type, status, amc_status,
      amc_start_date, amc_end_date,
      amc_visits_covered, amc_visits_used,
      amc_contact_name, amc_helpline_number, amc_contact_email,
      amc_scope_covered, amc_scope_exclusions,
      total_ordered_amount, created_at,
      procurement_vendors(id, name),
      locations(id, name),
      purchase_requests(id, pr_number, department, expenditure_type),
      purchase_order_items(id, item_name, unit),
      vendor_bills(id, payment_status),
      linked_asset:facility_assets!purchase_orders_linked_asset_id_fkey(id, name, asset_code)
    `)
    .order("created_at", { ascending: false });

  const { data: rows, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // ── Filter to AMC contracts ──────────────────────────────────────────────
  // Identity comes from the linked material request (expenditure_type = 'amc'),
  // not from po_type: AMC POs raised before the service-PO flow existed
  // (commit eefcf4e0, 2026-06-20) are still typed 'goods' but are real contracts.
  // Payment state no longer gates visibility — a signed, ordered AMC is a live
  // commitment worth tracking, so it is surfaced and flagged instead of hidden.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let amcRows = (rows ?? []).filter((r: any) => {
    if (r.purchase_requests?.expenditure_type !== "amc") return false;
    if (r.status === "cancelled") return false;
    return Boolean(r.amc_start_date);
  });

  // Recompute live amc_status for each row
  const today = new Date();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  amcRows = amcRows.map((r: any) => {
    const computed = computeAmcStatus(
      r.amc_start_date, r.amc_end_date, r.amc_visits_covered, r.amc_visits_used ?? 0, today
    );
    const { vendor_bills: bills, ...rest } = r;
    return { ...rest, amc_status: computed, payment_state: computePaymentState(bills) };
  });

  // Apply filters
  if (amcStatus) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    amcRows = amcRows.filter((r: any) => r.amc_status === amcStatus);
  }
  if (locationId) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    amcRows = amcRows.filter((r: any) => r.location_id === locationId);
  }

  // ── AMC annual budget summary (for budget banner on the page) ────────────
  const canSeeBudget = ["admin", "manager"].includes(dbUser.role);
  let budgetSummary = null;

  if (canSeeBudget) {
    const currentFY = getCurrentFY();
    const { fyStart, fyEnd } = getFYWindow(currentFY);

    const [{ data: budgetRow }, { data: committed, error: committedError }, { data: provisional }] = await Promise.all([
      supabase
        .from("department_budgets")
        .select("monthly_budget, is_active, notes")
        .eq("department", "amc")
        .eq("budget_period", "annual")
        .eq("financial_year", currentFY)
        .is("location_id", null)
        .maybeSingle(),
      supabase
        .from("purchase_requests")
        .select("id, total_estimated_amount")
        .eq("expenditure_type", "amc")
        .gte("created_at", fyStart)
        .lte("created_at", fyEnd)
        .in("status", ["approved", "partially_ordered", "po_created"]),
      supabase
        .from("purchase_requests")
        .select("total_estimated_amount")
        .eq("expenditure_type", "amc")
        .gte("created_at", fyStart)
        .lte("created_at", fyEnd)
        .eq("status", "submitted"),
    ]);
    if (committedError) console.error("[amc] committed spend query failed:", committedError.message);

    // Cancelling a PO does not move its request out of 'approved', so a request
    // whose every PO was cancelled would otherwise still count as committed spend.
    const committedRequests = committed ?? [];
    const { data: committedPos, error: committedPosError } = committedRequests.length
      ? await supabase
          .from("purchase_orders")
          .select("pr_id, status")
          .in("pr_id", committedRequests.map((r) => r.id))
      : { data: [], error: null };
    if (committedPosError) console.error("[amc] committed PO query failed:", committedPosError.message);

    const fullyCancelledPrIds = new Set<string>();
    for (const req of committedRequests) {
      const pos = (committedPos ?? []).filter((po) => po.pr_id === req.id);
      if (pos.length > 0 && pos.every((po) => po.status === "cancelled")) {
        fullyCancelledPrIds.add(req.id);
      }
    }

    const annualBudget = budgetRow?.monthly_budget ? Number(budgetRow.monthly_budget) : null;
    const committedTotal = committedRequests
      .filter((r) => !fullyCancelledPrIds.has(r.id))
      .reduce((s, r) => s + Number(r.total_estimated_amount ?? 0), 0);
    const provisionalTotal = (provisional ?? []).reduce((s, r) => s + Number(r.total_estimated_amount ?? 0), 0);

    budgetSummary = {
      financial_year: currentFY,
      annual_budget: annualBudget,
      is_active: budgetRow?.is_active ?? false,
      committed: committedTotal,
      provisional: provisionalTotal,
      utilisation_pct: annualBudget ? Math.round((committedTotal / annualBudget) * 100) : null,
      is_over_budget: annualBudget != null && committedTotal > annualBudget,
    };
  }

  return NextResponse.json({ data: amcRows, budget: budgetSummary });
}

/**
 * Payment state of an AMC contract, derived from its vendor bills.
 * Contracts are listed regardless of payment; this drives the UI badge so the
 * paid/unpaid distinction stays visible without hiding live commitments.
 */
function computePaymentState(
  bills: Array<{ payment_status: string | null }> | null | undefined
): "paid" | "partially_paid" | "unpaid" | "no_bill" {
  const rows = bills ?? [];
  if (rows.length === 0) return "no_bill";
  if (rows.some((b) => b.payment_status === "paid")) return "paid";
  if (rows.some((b) => b.payment_status === "partially_paid")) return "partially_paid";
  return "unpaid";
}

function computeAmcStatus(
  startDate: string | null,
  endDate: string | null,
  visitsCovered: number | null,
  visitsUsed: number,
  today: Date
): string {
  if (!startDate) return "inactive";
  const start = new Date(startDate);
  if (today < start) return "inactive";
  if (endDate) {
    const end = new Date(endDate);
    if (today > end) return "expired";
    const daysLeft = Math.floor((end.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
    if (daysLeft <= 60) return "expiring";
  }
  if (visitsCovered !== null && visitsUsed >= visitsCovered) return "exhausted";
  return "active";
}
