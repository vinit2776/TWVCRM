import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { buildBillingReconciliationReport } from "@/lib/billing-reconciliation";

/**
 * GET /api/accounting/billing-reconciliation
 *
 * Data feed for the Billing Reconciliation report — 12 months (default)
 * forward from the current month, grouped by center, one row per currently
 * billable (or recently-lapsed-but-still-owed) contract.
 */
export async function GET(_req: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser || !["admin", "manager", "accounts"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const report = await buildBillingReconciliationReport(supabase);
  return NextResponse.json(report);
}
