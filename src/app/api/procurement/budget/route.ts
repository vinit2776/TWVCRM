import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { CENTER_SCOPED_DEPARTMENTS } from "@/lib/constants";

const DEPARTMENTS = CENTER_SCOPED_DEPARTMENTS;

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
  const companyId = searchParams.get("company_id");
  if (!companyId) {
    return NextResponse.json({ error: "company_id is required" }, { status: 400 });
  }
  const year = parseInt(searchParams.get("year") ?? String(new Date().getFullYear()));
  const month = parseInt(searchParams.get("month") ?? String(new Date().getMonth() + 1));

  // Month window for operational departments
  const monthStart = new Date(year, month - 1, 1).toISOString();
  const monthEnd = new Date(year, month, 0, 23, 59, 59).toISOString();

  // Current FY for AMC budget (always current FY, not driven by month picker)
  const currentFY = getCurrentFY();
  const { fyStart, fyEnd } = getFYWindow(currentFY);

  // ── Fetch all budget config rows (this company only — budgets are not
  // shared across companies) ───────────────────────────────────────────────
  const { data: budgets } = await supabase
    .from("department_budgets")
    .select("*, creator:users!department_budgets_created_by_fkey(id, full_name), updater:users!department_budgets_updated_by_fkey(id, full_name)")
    .eq("company_id", companyId)
    .order("department");

  // ── Active centers (real locations, not the hidden replenishment hub) ────
  // Used to build the per-center budget breakdown for CENTER_SCOPED_DEPARTMENTS.
  // Scoped to this company — Medworks has its own separate locations.
  const { data: locationRows } = await supabase
    .from("locations")
    .select("id, name, is_hub")
    .eq("is_active", true)
    .eq("company_id", companyId)
    .order("name");
  const centers = ((locationRows ?? []) as Array<{ id: string; name: string; is_hub: boolean | null }>)
    .filter((l) => !l.is_hub);

  // ── Operational MR spend per department (this calendar month) ────────────
  // Two-state model, same as AMC below: committed (approved and beyond) counts
  // as real spend; submitted-but-not-yet-approved is provisional/pipeline only.
  // Draft and rejected/cancelled requests are excluded from both.
  const { data: mrCommitted, error: mrCommittedError } = await supabase
    .from("purchase_requests")
    .select("department, location_id, total_estimated_amount")
    .eq("company_id", companyId)
    .eq("expenditure_type", "operational")
    .gte("created_at", monthStart)
    .lte("created_at", monthEnd)
    .in("status", ["approved", "partially_ordered", "po_created"]);
  if (mrCommittedError) console.error("[budget] operational committed spend query failed:", mrCommittedError.message);

  const { data: mrProvisional } = await supabase
    .from("purchase_requests")
    .select("department, location_id, total_estimated_amount")
    .eq("company_id", companyId)
    .eq("expenditure_type", "operational")
    .gte("created_at", monthStart)
    .lte("created_at", monthEnd)
    .eq("status", "submitted");

  // ── AMC MR spend for current FY — two-state model ────────────────────────
  // Committed: approved and beyond
  const { data: amcCommitted, error: amcCommittedError } = await supabase
    .from("purchase_requests")
    .select("total_estimated_amount")
    .eq("company_id", companyId)
    .eq("expenditure_type", "amc")
    .gte("created_at", fyStart)
    .lte("created_at", fyEnd)
    .in("status", ["approved", "partially_ordered", "po_created"]);
  if (amcCommittedError) console.error("[budget] AMC committed spend query failed:", amcCommittedError.message);

  // Provisional: submitted, pending approval
  const { data: amcProvisional } = await supabase
    .from("purchase_requests")
    .select("total_estimated_amount")
    .eq("company_id", companyId)
    .eq("expenditure_type", "amc")
    .gte("created_at", fyStart)
    .lte("created_at", fyEnd)
    .eq("status", "submitted");

  // ── Aggregate operational spend, overall and per-center ─────────────────
  // "none" bucket = spend on MRs raised before a center was required, or that
  // otherwise never got a location — surfaced separately so it isn't silently
  // dropped from view.
  const spendMap: Record<string, number> = {};
  const provisionalMap: Record<string, number> = {};
  const spendByCenter: Record<string, Record<string, number>> = {};
  const provisionalByCenter: Record<string, Record<string, number>> = {};
  for (const dept of DEPARTMENTS) {
    spendMap[dept] = 0;
    provisionalMap[dept] = 0;
    spendByCenter[dept] = {};
    provisionalByCenter[dept] = {};
  }
  for (const mr of mrCommitted ?? []) {
    spendMap[mr.department] = (spendMap[mr.department] ?? 0) + Number(mr.total_estimated_amount ?? 0);
    const key = mr.location_id ?? "none";
    const byCenter = spendByCenter[mr.department];
    if (byCenter) byCenter[key] = (byCenter[key] ?? 0) + Number(mr.total_estimated_amount ?? 0);
  }
  for (const mr of mrProvisional ?? []) {
    provisionalMap[mr.department] = (provisionalMap[mr.department] ?? 0) + Number(mr.total_estimated_amount ?? 0);
    const key = mr.location_id ?? "none";
    const byCenter = provisionalByCenter[mr.department];
    if (byCenter) byCenter[key] = (byCenter[key] ?? 0) + Number(mr.total_estimated_amount ?? 0);
  }

  // ── Build operational department rows, each with a per-center breakdown ──
  const result = DEPARTMENTS.map((dept) => {
    const budget = (budgets ?? []).find(
      (b) => b.department === dept && b.location_id == null && (b.budget_period ?? "monthly") === "monthly"
    );
    const spent = spendMap[dept] ?? 0;
    const budgetAmount = budget?.monthly_budget ? Number(budget.monthly_budget) : null;
    const utilisation = budgetAmount ? Math.round((spent / budgetAmount) * 100) : null;

    const centerRows = centers.map((loc) => {
      const centerBudget = (budgets ?? []).find(
        (b) => b.department === dept && b.location_id === loc.id && (b.budget_period ?? "monthly") === "monthly"
      );
      const centerSpent = spendByCenter[dept]?.[loc.id] ?? 0;
      const centerBudgetAmount = centerBudget?.monthly_budget ? Number(centerBudget.monthly_budget) : null;
      const centerUtilisation = centerBudgetAmount ? Math.round((centerSpent / centerBudgetAmount) * 100) : null;
      return {
        location_id: loc.id,
        location_name: loc.name,
        monthly_budget: centerBudgetAmount,
        is_active: centerBudget?.is_active ?? false,
        id: centerBudget?.id ?? null,
        spent_this_month: centerSpent,
        provisional_this_month: provisionalByCenter[dept]?.[loc.id] ?? 0,
        utilisation_pct: centerUtilisation,
        is_over_budget: centerBudgetAmount != null && centerSpent > centerBudgetAmount,
      };
    });

    return {
      department: dept,
      monthly_budget: budgetAmount,
      is_active: budget?.is_active ?? false,
      notes: budget?.notes ?? null,
      id: budget?.id ?? null,
      spent_this_month: spent,
      provisional_this_month: provisionalMap[dept] ?? 0,
      amc_spent_this_month: 0, // AMC no longer rolled up per-dept — has its own budget
      utilisation_pct: utilisation,
      is_over_budget: budgetAmount != null && spent > budgetAmount,
      creator: budget?.creator ?? null,
      updater: budget?.updater ?? null,
      updated_at: budget?.updated_at ?? null,
      centers: centerRows,
      unattributed_spend_this_month: spendByCenter[dept]?.none ?? 0,
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
  const companyId = body.company_id as string | undefined;
  if (!companyId) {
    return NextResponse.json({ error: "company_id is required" }, { status: 400 });
  }

  // ── Save operational department budgets (global + optional per-center) ───
  if (Array.isArray(body.budgets)) {
    const { data: existing } = await supabase
      .from("department_budgets")
      .select("id, department, location_id")
      .eq("company_id", companyId)
      .eq("budget_period", "monthly");

    const existingByDept: Record<string, string> = {};
    // Keyed "department:location_id" for center rows.
    const existingByDeptCenter: Record<string, string> = {};
    for (const e of existing ?? []) {
      if (e.location_id == null) {
        if (!existingByDept[e.department]) existingByDept[e.department] = e.id;
      } else {
        existingByDeptCenter[`${e.department}:${e.location_id}`] = e.id;
      }
    }

    let lastError: string | null = null;

    for (const b of body.budgets as Array<{
      department: string;
      monthly_budget: number | null;
      is_active: boolean;
      notes?: string;
      centers?: Array<{ location_id: string; monthly_budget: number | null; is_active: boolean }>;
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
            company_id: companyId,
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

      for (const c of b.centers ?? []) {
        const existingCenterId = existingByDeptCenter[`${b.department}:${c.location_id}`];
        if (existingCenterId) {
          const { error } = await supabase
            .from("department_budgets")
            .update({
              monthly_budget: c.monthly_budget ?? 0,
              is_active: c.is_active,
              updated_by: dbUser.id,
            })
            .eq("id", existingCenterId);
          if (error) lastError = error.message;
        } else {
          const { error } = await supabase
            .from("department_budgets")
            .insert({
              company_id: companyId,
              department: b.department,
              location_id: c.location_id,
              monthly_budget: c.monthly_budget ?? 0,
              is_active: c.is_active,
              budget_period: "monthly",
              created_by: dbUser.id,
              updated_by: dbUser.id,
            });
          if (error) lastError = error.message;
        }
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
      .eq("company_id", companyId)
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
          company_id: companyId,
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
