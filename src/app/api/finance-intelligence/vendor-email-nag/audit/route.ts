import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { listVendorsMissingEmail } from "@/lib/finance-intelligence";

/**
 * GET /api/finance-intelligence/vendor-email-nag/audit
 *
 * Returns every vendor without an email, sorted by impact (pending bills
 * first, then dismissals, then most recent). Drives the bulk-fix page
 * at /accounting/vendor-email-audit and the accounts dashboard widget.
 *
 * Roles: admin, manager, accounts (anyone who can see payables).
 */
export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 403 });
  if (!["admin", "manager", "accounts", "office_admin"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Access denied" }, { status: 403 });
  }

  const gaps = await listVendorsMissingEmail(supabase);
  return NextResponse.json({
    count: gaps.length,
    vendors: gaps,
    high_priority_count: gaps.filter((g) => g.pending_bills_count > 0).length,
    total_pending_value: gaps.reduce((s, g) => s + g.total_billed_last_90d, 0),
  });
}
