import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

const DEPARTMENTS = ["pantry", "maintenance", "administration", "asset"] as const;

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 403 });
  if (!["admin", "manager"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Access denied" }, { status: 403 });
  }

  const searchParams = request.nextUrl.searchParams;
  const year = parseInt(searchParams.get("year") ?? String(new Date().getFullYear()));
  const month = parseInt(searchParams.get("month") ?? String(new Date().getMonth() + 1));

  // Month window
  const monthStart = new Date(year, month - 1, 1).toISOString();
  const monthEnd = new Date(year, month, 0, 23, 59, 59).toISOString();

  // Fetch all budgets
  const { data: budgets } = await supabase
    .from("department_budgets")
    .select("*, creator:users!department_budgets_created_by_fkey(id, full_name), updater:users!department_budgets_updated_by_fkey(id, full_name)")
    .order("department");

  // Fetch MR spend per department for this month (exclude cancelled/rejected)
  const { data: mrSpend } = await supabase
    .from("purchase_requests")
    .select("department, total_estimated_amount, status")
    .gte("created_at", monthStart)
    .lte("created_at", monthEnd)
    .not("status", "in", '("cancelled","rejected")');

  // Aggregate spend per department
  const spendMap: Record<string, number> = {};
  for (const dept of DEPARTMENTS) spendMap[dept] = 0;
  for (const mr of mrSpend ?? []) {
    spendMap[mr.department] = (spendMap[mr.department] ?? 0) + Number(mr.total_estimated_amount ?? 0);
  }

  // Merge budgets with spend
  const result = DEPARTMENTS.map((dept) => {
    const budget = (budgets ?? []).find((b) => b.department === dept && b.location_id == null);
    const spent = spendMap[dept] ?? 0;
    const budgetAmount = budget?.monthly_budget ? Number(budget.monthly_budget) : null;
    const utilisation = budgetAmount ? Math.round((spent / budgetAmount) * 100) : null;
    return {
      department: dept,
      monthly_budget: budgetAmount,
      is_active: budget?.is_active ?? false,
      notes: budget?.notes ?? null,
      id: budget?.id ?? null,
      spent_this_month: spent,
      utilisation_pct: utilisation,
      is_over_budget: budgetAmount != null && spent > budgetAmount,
      creator: budget?.creator ?? null,
      updater: budget?.updater ?? null,
      updated_at: budget?.updated_at ?? null,
    };
  });

  return NextResponse.json({ data: result, year, month });
}

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 403 });
  if (dbUser.role !== "admin") {
    return NextResponse.json({ error: "Only admin can configure department budgets" }, { status: 403 });
  }

  const body = await request.json();
  // body = Array<{ department, monthly_budget, is_active, notes }>
  if (!Array.isArray(body.budgets)) {
    return NextResponse.json({ error: "Expected { budgets: [...] }" }, { status: 400 });
  }

  const upserts = body.budgets.map((b: { department: string; monthly_budget: number | null; is_active: boolean; notes?: string }) => ({
    department: b.department,
    location_id: null,
    monthly_budget: b.monthly_budget ?? 0,
    is_active: b.is_active,
    notes: b.notes ?? null,
    created_by: dbUser.id,
    updated_by: dbUser.id,
  }));

  const { error } = await supabase
    .from("department_budgets")
    .upsert(upserts, { onConflict: "department,location_id" });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ message: "Budgets saved successfully" });
}
