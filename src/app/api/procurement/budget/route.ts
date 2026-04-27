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

  // Fetch operational MR spend per department for this month (AMC excluded from budget)
  const { data: mrSpend } = await supabase
    .from("purchase_requests")
    .select("department, total_estimated_amount, status")
    .eq("expenditure_type", "operational")
    .gte("created_at", monthStart)
    .lte("created_at", monthEnd)
    .not("status", "in", '("cancelled","rejected")');

  // Fetch AMC spend per department for this month (informational only)
  const { data: amcSpend } = await supabase
    .from("purchase_requests")
    .select("department, total_estimated_amount, status")
    .eq("expenditure_type", "amc")
    .gte("created_at", monthStart)
    .lte("created_at", monthEnd)
    .not("status", "in", '("cancelled","rejected")');

  // Aggregate spend per department
  const spendMap: Record<string, number> = {};
  const amcMap: Record<string, number> = {};
  for (const dept of DEPARTMENTS) { spendMap[dept] = 0; amcMap[dept] = 0; }
  for (const mr of mrSpend ?? []) {
    spendMap[mr.department] = (spendMap[mr.department] ?? 0) + Number(mr.total_estimated_amount ?? 0);
  }
  for (const mr of amcSpend ?? []) {
    amcMap[mr.department] = (amcMap[mr.department] ?? 0) + Number(mr.total_estimated_amount ?? 0);
  }

  // Merge budgets with spend
  const result = DEPARTMENTS.map((dept) => {
    const budget = (budgets ?? []).find((b) => b.department === dept && b.location_id == null);
    const spent = spendMap[dept] ?? 0;
    const amcSpentThisMonth = amcMap[dept] ?? 0;
    const budgetAmount = budget?.monthly_budget ? Number(budget.monthly_budget) : null;
    const utilisation = budgetAmount ? Math.round((spent / budgetAmount) * 100) : null;
    return {
      department: dept,
      monthly_budget: budgetAmount,
      is_active: budget?.is_active ?? false,
      notes: budget?.notes ?? null,
      id: budget?.id ?? null,
      spent_this_month: spent,
      amc_spent_this_month: amcSpentThisMonth,
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
  if (!Array.isArray(body.budgets)) {
    return NextResponse.json({ error: "Expected { budgets: [...] }" }, { status: 400 });
  }

  // Fetch existing rows by ID first — upsert with onConflict: "department,location_id" silently
  // inserts new rows when location_id IS NULL because PostgreSQL treats NULL != NULL in unique
  // index matching. We must explicitly update by primary key instead.
  const { data: existing } = await supabase
    .from("department_budgets")
    .select("id, department")
    .is("location_id", null);

  const existingByDept: Record<string, string> = {};
  for (const e of existing ?? []) {
    // If somehow duplicates exist (from the old broken upsert), prefer the first (oldest) row
    if (!existingByDept[e.department]) existingByDept[e.department] = e.id;
  }

  let lastError: string | null = null;

  for (const b of body.budgets as Array<{
    department: string;
    monthly_budget: number | null;
    is_active: boolean;
    notes?: string;
  }>) {
    const existingId = existingByDept[b.department];
    if (existingId) {
      const { error } = await supabase
        .from("department_budgets")
        .update({
          monthly_budget: b.monthly_budget ?? 0,
          is_active: b.is_active,
          notes: b.notes ?? null,
          updated_by: dbUser.id,
        })
        .eq("id", existingId);
      if (error) lastError = error.message;
    } else {
      const { error } = await supabase
        .from("department_budgets")
        .insert({
          department: b.department,
          location_id: null,
          monthly_budget: b.monthly_budget ?? 0,
          is_active: b.is_active,
          notes: b.notes ?? null,
          created_by: dbUser.id,
          updated_by: dbUser.id,
        });
      if (error) lastError = error.message;
    }
  }

  if (lastError) return NextResponse.json({ error: lastError }, { status: 500 });
  return NextResponse.json({ message: "Budgets saved successfully" });
}
