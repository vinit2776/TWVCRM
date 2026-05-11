import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getNagStatus, recordShown } from "@/lib/finance-intelligence";

/**
 * GET /api/finance-intelligence/vendor-email-nag/status?vendor_id=<uuid>
 *
 * Returns { should_show, level, dismissals_in_window, snoozed_until, ... }
 * for the given vendor + current user. The banner uses this to decide
 * whether to render itself and how aggressive to be.
 *
 * Side-effect: logs a 'shown' event if should_show=true. We track shows
 * separately from dismissals so we can compute "shown → fixed" conversion.
 */
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users").select("id").eq("auth_id", user.id).single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 403 });

  const vendorId = new URL(request.url).searchParams.get("vendor_id");
  if (!vendorId) return NextResponse.json({ error: "vendor_id required" }, { status: 400 });

  // Verify the vendor actually lacks an email — caller might be stale
  const { data: vendor } = await supabase
    .from("procurement_vendors")
    .select("id, contact_email")
    .eq("id", vendorId)
    .single();
  if (!vendor) return NextResponse.json({ error: "Vendor not found" }, { status: 404 });
  if (vendor.contact_email && vendor.contact_email.trim() !== "") {
    return NextResponse.json({
      should_show: false,
      level: "normal" as const,
      dismissals_in_window: 0,
      snoozed_until: null,
      escalate_after: 0,
      escalate_window_days: 0,
      has_email: true,
    });
  }

  const status = await getNagStatus(supabase, vendorId, dbUser.id);

  // Best-effort log of 'shown' event (only when we'd render the banner)
  if (status.should_show) {
    recordShown(supabase, vendorId, dbUser.id).catch(() => {});
  }

  return NextResponse.json({ ...status, has_email: false });
}
