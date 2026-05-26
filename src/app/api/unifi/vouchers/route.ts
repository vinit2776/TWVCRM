/**
 * GET /api/unifi/vouchers?location_id=<uuid>&status=<VALID_ONE|VALID_MULTI|USED_ONE|USED_MULTIPLE|EXPIRED>
 *
 * Proxies to the UniFi device for the given location and returns live voucher data.
 * Only available for locations that have unifi_site_id set.
 * Requires admin | manager | sales_rep role.
 */
import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { unifiRequest } from "@/lib/unifi";
import type { UnifiVoucher } from "@/lib/unifi";

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 401 });

  const allowed = ["admin", "manager", "sales_rep", "floor_manager", "office_admin", "it_manager"];
  if (!allowed.includes(dbUser.role)) {
    return NextResponse.json({ error: "Insufficient permissions" }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const locationId = searchParams.get("location_id");
  const statusFilter = searchParams.get("status"); // optional

  if (!locationId) {
    return NextResponse.json({ error: "location_id is required" }, { status: 400 });
  }

  // Verify this location has unifi_site_id
  const admin = createAdminClient();
  const { data: location } = await admin
    .from("locations")
    .select("id, name, code, unifi_site_id")
    .eq("id", locationId)
    .single();

  if (!location?.unifi_site_id) {
    return NextResponse.json({ error: "This location is not managed via the UniFi API" }, { status: 400 });
  }

  try {
    const vouchers = await unifiRequest<UnifiVoucher[]>("/stat/voucher");

    // Filter by status if requested
    const filtered = statusFilter
      ? vouchers.filter((v) => v.status === statusFilter)
      : vouchers;

    // Sort: most recently created first
    filtered.sort((a, b) => b.create_time - a.create_time);

    // Compute summary stats
    const stats = {
      total: vouchers.length,
      valid: vouchers.filter((v) => v.status.startsWith("VALID")).length,
      used: vouchers.filter((v) => v.status.startsWith("USED")).length,
      expired: vouchers.filter((v) => v.status === "EXPIRED").length,
    };

    return NextResponse.json({ data: filtered, stats, location });
  } catch (err) {
    console.error("[api/unifi/vouchers] fetch failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to reach UniFi device" },
      { status: 502 }
    );
  }
}
