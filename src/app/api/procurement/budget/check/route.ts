import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { computeAmcCommitted } from "@/lib/procurement/amc-budget";

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

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 403 });

  const searchParams = request.nextUrl.searchParams;
  const department = searchParams.get("department");
  const expenditureType = searchParams.get("expenditure_type") ?? "operational";
  const mrAmount = parseFloat(searchParams.get("amount") ?? "0");

  if (!department) return NextResponse.json({ error: "department required" }, { status: 400 });

  // ── AMC annual budget check ──────────────────────────────────────────────
  if (expenditureType === "amc") {
    const currentFY = getCurrentFY();
    const { fyStart, fyEnd } = getFYWindow(currentFY);

    const { data: budget } = await supabase
      .from("department_budgets")
      .select("monthly_budget, is_active, notes")
      .eq("department", "amc")
      .eq("budget_period", "annual")
      .eq("financial_year", currentFY)
      .is("location_id", null)
      .maybeSingle();

    if (!budget || !budget.is_active || !budget.monthly_budget) {
      return NextResponse.json({ has_budget: false, budget_type: "annual" });
    }

    const annualBudget = Number(budget.monthly_budget);

    // Committed: approved and beyond, excluding requests whose POs were all
    // cancelled. Shared with the AMC register so the two cannot show different
    // numbers for the same thing.
    const committedTotal = await computeAmcCommitted(supabase, fyStart, fyEnd);

    // Provisional: submitted pending approval
    const { data: provisional } = await supabase
      .from("purchase_requests")
      .select("total_estimated_amount")
      .eq("expenditure_type", "amc")
      .gte("created_at", fyStart)
      .lte("created_at", fyEnd)
      .eq("status", "submitted");

    const provisionalTotal = (provisional ?? []).reduce((s, r) => s + Number(r.total_estimated_amount ?? 0), 0);
    const projectedTotal = committedTotal + mrAmount;
    const isOverBudget = projectedTotal > annualBudget;
    const remainingBudget = Math.max(0, annualBudget - committedTotal);

    return NextResponse.json({
      has_budget: true,
      budget_type: "annual",
      financial_year: currentFY,
      annual_budget: annualBudget,
      committed_so_far: committedTotal,
      provisional_in_pipeline: provisionalTotal,
      this_mr_amount: mrAmount,
      projected_committed: projectedTotal,
      remaining_before_mr: remainingBudget,
      is_over_budget: isOverBudget,
      over_by: isOverBudget ? projectedTotal - annualBudget : 0,
      utilisation_before: Math.round((committedTotal / annualBudget) * 100),
      utilisation_after: Math.round((projectedTotal / annualBudget) * 100),
    });
  }

  // ── Operational monthly budget check (existing logic) ────────────────────
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59).toISOString();

  const { data: budget } = await supabase
    .from("department_budgets")
    .select("monthly_budget, is_active, notes")
    .eq("department", department)
    .eq("budget_period", "monthly")
    .is("location_id", null)
    .maybeSingle();

  if (!budget || !budget.is_active || !budget.monthly_budget) {
    return NextResponse.json({ has_budget: false, budget_type: "monthly" });
  }

  const monthlyBudget = Number(budget.monthly_budget);

  // Same committed/provisional split as the AMC check above and the dashboard
  // budget route: only approved-and-beyond requests count as real spend.
  // Draft/submitted requests haven't actually been committed yet.
  const { data: committed, error: committedError } = await supabase
    .from("purchase_requests")
    .select("total_estimated_amount")
    .eq("department", department)
    .eq("expenditure_type", "operational")
    .gte("created_at", monthStart)
    .lte("created_at", monthEnd)
    .in("status", ["approved", "partially_ordered", "po_created"]);
  if (committedError) console.error("[budget check] operational committed spend query failed:", committedError.message);

  const { data: provisional } = await supabase
    .from("purchase_requests")
    .select("total_estimated_amount")
    .eq("department", department)
    .eq("expenditure_type", "operational")
    .gte("created_at", monthStart)
    .lte("created_at", monthEnd)
    .eq("status", "submitted");

  const spentSoFar = (committed ?? []).reduce((s, mr) => s + Number(mr.total_estimated_amount ?? 0), 0);
  const provisionalTotal = (provisional ?? []).reduce((s, mr) => s + Number(mr.total_estimated_amount ?? 0), 0);
  const projectedTotal = spentSoFar + mrAmount;
  const isOverBudget = projectedTotal > monthlyBudget;
  const remainingBudget = Math.max(0, monthlyBudget - spentSoFar);

  return NextResponse.json({
    has_budget: true,
    budget_type: "monthly",
    monthly_budget: monthlyBudget,
    spent_so_far: spentSoFar,
    provisional_in_pipeline: provisionalTotal,
    this_mr_amount: mrAmount,
    projected_total: projectedTotal,
    remaining_before_mr: remainingBudget,
    is_over_budget: isOverBudget,
    over_by: isOverBudget ? projectedTotal - monthlyBudget : 0,
    utilisation_before: Math.round((spentSoFar / monthlyBudget) * 100),
    utilisation_after: Math.round((projectedTotal / monthlyBudget) * 100),
  });
}
