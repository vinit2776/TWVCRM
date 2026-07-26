/**
 * GET /api/ruijie/requests?location_id=<uuid>&status=pending
 *
 * Returns ruijie_adhoc_voucher approval requests for a given location.
 * Used to drive the pending-requests queue in the Ruijie Live tab.
 */
import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const locationId = searchParams.get("location_id");
  const status     = searchParams.get("status") || "pending";

  const admin = createAdminClient();
  let query = admin
    .from("approval_requests")
    .select(
      "*, requester:users!approval_requests_requested_by_fkey(id, full_name, email, role)"
    )
    .eq("entity_type", "ruijie_adhoc_voucher")
    .order("created_at", { ascending: false });

  if (locationId) query = query.eq("entity_id", locationId);
  if (status !== "all") query = query.eq("status", status);

  const { data, error } = await query.limit(50);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ data: data || [] });
}
