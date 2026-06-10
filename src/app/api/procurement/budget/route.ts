import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

const DEPARTMENTS = ["pantry", "maintenance", "administration", "asset"] as const;

// Returns the financial year start year for a given date.
// FY 2025-26 starts April 2025 → returns 2025.
function getCurrentFY(date = new Date()): number {
  const month = date.getMonth() + 1; // 1-based
  const year = date.getFullYear();
  return month >= 4 ? year : year - 1;
}

// FY window: April 1 of fyStart to March 31 of fyStart+1
function getFYWindow(fyStart: number) {
  return {
    fyStart: new Date(fyStart, 3, 1).toISOString(),         // April 1
    fyEnd: new Date(fyStart + 1, 2, 31, 23, 59, 59).toISOString(), // March 31
  };
}

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

  // Month window for operational departments
  const monthStart = new Date(year, month - 1, 1).toISOString();
  const monthEnd = new Date(year, month, 0, 23, 59, 59).toISOString();

  // Current FY for AMC budget (always current FY, not driven by month picker)
  const currentFY = getCurrentFY();
  const { fyStart, fyEnd } = getFYWindow(currentFY);

  // ── Fetch all budget config rows ─────────────────────────────────────────
  const { data: budgets } = await supabase
    .from("department_budgets")
    .select("*, creator:users!department_budgets_created_by_fkey(id, full_name), updater:users!department_budgets_updated_by_fkey(id, full_name)")
    .order("department");

  // ── Operational MR spend per department (this calendar month) ────────────
  const { data: mrSpend } = await supabase
    .from("purchase_requests")
    .select("department, total_estimated_amount, status")
    .eq("expenditure_type", "operational")
    .gte("created_at", monthStart)
    .lte("created_at", monthEnd)
    .not("status", "in", '("cancelled","rejected")');

  // ── AMC MR spend for current FY — two-state model ────────────────────────
  // Committed: approved and beyond
  const { data: amcCommitted } = await supabase
    .from("purchase_requests")
    .select("total_estimated_amount")
    .eq("expenditure_type", "amc")
    .gte("created_at", fyStart)
    .lte("created_at", fyEnd)
    .in("status", ["approved", "partially_ordered", "po_created", "fully_ordered", "closed"]);

  // Provisional: submitted, pending approval
  const { data: amcProvisional } = await supabase
    .from("purchase_requests")
    .select("total_estimated_amount")
    .eq("expenditure_type", "amc")
    .gte("created_at", fyStart)
    .lte("created_at", fyEnd)
    .eq("status", "submitted");

  // ── Aggregate operational spend ──────────────────────────────────────────
  const spendMap: Record<string, number> = {};
  for (const dept of DEPARTMENTS) { spendMap[dept] = 0; }
  for (const mr of mrSpend ?? []) {
    spendMap[mr.department] = (spendMap[mr.department] ?? 0) + Number(mr.total_estimated_amount ?? 0);
  }

  // ── Build operational department rows (unchanged logic) ──────────────────
  const result = DEPARTMENTS.map((dept) => {
    const budget = (budgets ?? []).find(
      (b) => b.department === dept && b.location_id == null && (b.budget_period ?? "monthly") === "monthly"
    );
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
      amc_spent_this_month: 0, // AMC no longer rolled up per-dept — has its own budget
      utilisation_pct: utilisation,
      is_over_budget: budgetAmount != null && spent > budgetAmount,
      creator: budget?.creator ?? null,
      updater: budget?.updater ?? null,
      updated_at: budget?.updated_at ?? null,
    };
  });

  // ── Build AMC annual budget summary ─────────────────────────────────────
  const amcBudgetRow = (budgets ?? []).find(
    (b) => b.department === "amc" && b.budget_period === "annual" && b.financial_year === currentFY && b.location_id == null
  );
  const amcAnnualBudget = amcBudgetRow?.monthly_budget ? Number(amcBudgetRow.monthly_budget) : null;
  const amcCommittedTotal = (amcCommitted ?? []).reduce((s, r) => s + Number(r.total_estimated_amount ?? 0), 0);
  const amcProvisionalTotal = (amcProvisional ?? []).reduce((s, r) => s + Number(r.total_estimated_amount ?? 0), 0);
  const amcUtilisation = amcAnnualBudget ? Math.round((amcCommittedTotal / amcAnnualBudget) * 100) : null;
  const amcIsOverBudget = amcAnnualBudget != null && amcCommittedTotal > amcAnnualBudget;

  const amcSummary = {
    financial_year: currentFY,
    annual_budget: amcAnnualBudget,
    is_active: amcBudgetRow?.is_active ?? false,
    notes: amcBudgetRow?.notes ?? null,
    id: amcBudgetRow?.id ?? null,
    committed: amcCommittedTotal,
    provisional: amcProvisionalTotal,
    utilisation_pct: amcUtilisation,
    is_over_budget: amcIsOverBudget,
    updater: amcBudgetRow?.updater ?? null,
    updated_at: amcBudgetRow?.updated_at ?? null,
  };

  return NextResponse.json({ data: result, amc: amcSummary, year, month });
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

  // ── Save operational department budgets ──────────────────────────────────
  if (Array.isArray(body.budgets)) {
    const { data: existing } = await supabase
      .from("department_budgets")
      .select("id, department")
      .is("location_id", null)
      .eq("budget_period", "monthly");

    const existingByDept: Record<string, string> = {};
    for (const e of existing ?? []) {
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
            budget_period: "monthly",
            created_by: dbUser.id,
            updated_by: dbUser.id,
          });
        if (error) lastError = error.message;
      }
    }

    if (lastError) return NextResponse.json({ error: lastError }, { status: 500 });
  }

  // ── Save AMC annual budget ────────────────────────────────────────────────
  if (body.amc != null) {
    const amc = body.amc as {
      annual_budget: number | null;
      is_active: boolean;
      notes?: string;
      financial_year: number;
    };

    if (!amc.financial_year) {
      return NextResponse.json({ error: "financial_year required for AMC budget" }, { status: 400 });
    }

    // Look for existing AMC row for this FY
    const { data: existingAmc } = await supabase
      .from("department_budgets")
      .select("id")
      .eq("department", "amc")
      .eq("budget_period", "annual")
      .eq("financial_year", amc.financial_year)
      .is("location_id", null)
      .maybeSingle();

    if (existingAmc) {
      const { error } = await supabase
        .from("department_budgets")
        .update({
          monthly_budget: amc.annual_budget ?? 0,
          is_active: amc.is_active,
          notes: amc.notes ?? null,
          updated_by: dbUser.id,
        })
        .eq("id", existingAmc.id);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    } else {
      const { error } = await supabase
        .from("department_budgets")
        .insert({
          department: "amc",
          location_id: null,
          monthly_budget: amc.annual_budget ?? 0,
          is_active: amc.is_active,
          notes: amc.notes ?? null,
          budget_period: "annual",
          financial_year: amc.financial_year,
          created_by: dbUser.id,
          updated_by: dbUser.id,
        });
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    }
  }

  return NextResponse.json({ message: "Budgets saved successfully" });
}
