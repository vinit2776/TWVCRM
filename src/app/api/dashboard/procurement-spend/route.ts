import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";

/**
 * GET /api/dashboard/procurement-spend?location_id=<uuid>
 * Per-department MTD spend (sum of vendor_bills.total_amount for bills with
 * invoice_date this month, joined via po -> pr.department) vs monthly budget.
 *
 * Access: admin, fms, accounts, office_admin.
 */
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const adminSupabase = await createAdminClient();
  const { data: dbUser } = await adminSupabase
    .from("users")
    .select("id, role")
    .eq("auth_id", user.id)
    .single();

  if (!dbUser || !["admin", "fms", "accounts", "office_admin"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const locationId = request.nextUrl.searchParams.get("location_id");

  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const fmt = (d: Date) => d.toISOString().split("T")[0];

  const billsQ = adminSupabase
    .from("vendor_bills")
    .select(
      "id, total_amount, invoice_date, po_id, po:purchase_orders(location_id, pr:purchase_requests(department))"
    )
    .gte("invoice_date", fmt(startOfMonth))
    .lte("invoice_date", fmt(now));

  let budgetsQ = adminSupabase
    .from("department_budgets")
    .select("department, location_id, monthly_budget, is_active")
    .eq("is_active", true);

  if (locationId) {
    budgetsQ = budgetsQ.or(`location_id.eq.${locationId},location_id.is.null`);
  }

  const [{ data: bills }, { data: budgets }] = await Promise.all([billsQ, budgetsQ]);

  type Bill = {
    total_amount: number | null;
    po: { location_id: string | null; pr: { department: string | null } | null } | null;
  };
  type Budget = { department: string; location_id: string | null; monthly_budget: number };

  // Aggregate spend by department
  const spendByDept = new Map<string, number>();
  for (const b of (bills ?? []) as unknown as Bill[]) {
    if (locationId && b.po?.location_id !== locationId) continue;
    const dept = b.po?.pr?.department ?? "unallocated";
    spendByDept.set(dept, (spendByDept.get(dept) ?? 0) + Number(b.total_amount ?? 0));
  }

  // Aggregate budget by department (sum across locations or filtered)
  const budgetByDept = new Map<string, number>();
  for (const b of (budgets ?? []) as Budget[]) {
    budgetByDept.set(
      b.department,
      (budgetByDept.get(b.department) ?? 0) + Number(b.monthly_budget ?? 0)
    );
  }

  const allDepts = new Set<string>([
    ...spendByDept.keys(),
    ...budgetByDept.keys(),
  ]);

  const rows = Array.from(allDepts)
    .map((dept) => {
      const spend = spendByDept.get(dept) ?? 0;
      const budget = budgetByDept.get(dept) ?? 0;
      const pct = budget > 0 ? Math.round((spend / budget) * 100) : null;
      return {
        department: dept,
        spend: Math.round(spend),
        budget: Math.round(budget),
        consumed_pct: pct,
      };
    })
    .sort((a, b) => b.spend - a.spend);

  const totalSpend = rows.reduce((s, r) => s + r.spend, 0);
  const totalBudget = rows.reduce((s, r) => s + r.budget, 0);

  return NextResponse.json({
    data: {
      total_spend_mtd: totalSpend,
      total_budget: totalBudget,
      total_consumed_pct: totalBudget > 0 ? Math.round((totalSpend / totalBudget) * 100) : null,
      departments: rows,
    },
  });
}
