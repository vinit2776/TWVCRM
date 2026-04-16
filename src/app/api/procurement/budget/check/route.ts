import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 403 });

  const searchParams = request.nextUrl.searchParams;
  const department = searchParams.get("department");
  const mrAmount = parseFloat(searchParams.get("amount") ?? "0");

  if (!department) return NextResponse.json({ error: "department required" }, { status: 400 });

  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59).toISOString();

  // Fetch budget for this department
  const { data: budget } = await supabase
    .from("department_budgets")
    .select("monthly_budget, is_active, notes")
    .eq("department", department)
    .is("location_id", null)
    .maybeSingle();

  if (!budget || !budget.is_active || !budget.monthly_budget) {
    return NextResponse.json({ has_budget: false });
  }

  const monthlyBudget = Number(budget.monthly_budget);

  // Fetch spend this month
  const { data: mrs } = await supabase
    .from("purchase_requests")
    .select("total_estimated_amount")
    .eq("department", department)
    .gte("created_at", monthStart)
    .lte("created_at", monthEnd)
    .not("status", "in", '("cancelled","rejected")');

  const spentSoFar = (mrs ?? []).reduce((s, mr) => s + Number(mr.total_estimated_amount ?? 0), 0);
  const projectedTotal = spentSoFar + mrAmount;
  const isOverBudget = projectedTotal > monthlyBudget;
  const remainingBudget = Math.max(0, monthlyBudget - spentSoFar);

  return NextResponse.json({
    has_budget: true,
    monthly_budget: monthlyBudget,
    spent_so_far: spentSoFar,
    this_mr_amount: mrAmount,
    projected_total: projectedTotal,
    remaining_before_mr: remainingBudget,
    is_over_budget: isOverBudget,
    over_by: isOverBudget ? projectedTotal - monthlyBudget : 0,
    utilisation_before: Math.round((spentSoFar / monthlyBudget) * 100),
    utilisation_after: Math.round((projectedTotal / monthlyBudget) * 100),
  });
}
