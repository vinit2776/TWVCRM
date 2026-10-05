import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * Active recurring-bill rules across all vendors — feeds the "pre-approved
 * vendors" shortcuts on the dashboard, Vendor Bills page and New Request screen.
 * Read-only; any signed-in user may see it (the table's RLS already allows
 * authenticated reads, and these shortcuts exist to steer requesters too).
 */
export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data, error } = await supabase
    .from("procurement_recurring_bill_rules")
    .select(
      "id, vendor_id, billing_cycle, expected_amount, tolerance_percent, max_auto_approve_amount, first_bill_id, procurement_vendors(id, name)"
    )
    .eq("status", "active")
    .order("created_at", { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ data });
}
