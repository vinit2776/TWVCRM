/**
 * GET /api/unifi/vouchers?location_id=<uuid>&status=<filter>&page=1&per_page=20
 *
 * Proxies to the UniFi device for the given location and returns paginated voucher data.
 * Only available for locations that have unifi_site_id set.
 * Requires admin | manager | sales_rep | floor_manager | office_admin | it_manager role.
 *
 * Response: { data, stats, location, pagination: { page, per_page, total, total_pages } }
 */
import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { cachedUnifiRequest } from "@/lib/unifi";
import type { UnifiVoucher } from "@/lib/unifi";

/**
 * Mask a voucher code so only the last 5 chars are visible.
 * E.g. "9295670854" → "•••••70854". Codes ≤5 chars are returned as-is.
 */
function maskVoucherCode(code: string): string {
  if (code.length <= 5) return code;
  return "•".repeat(code.length - 5) + code.slice(-5);
}

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

  // Pagination params
  const pageParam = parseInt(searchParams.get("page") ?? "1", 10);
  const perPageParam = parseInt(searchParams.get("per_page") ?? "20", 10);
  const page = Math.max(isNaN(pageParam) ? 1 : pageParam, 1);
  const perPage = Math.min(Math.max(isNaN(perPageParam) ? 20 : perPageParam, 1), 100);

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
    // Use cached full list (60s TTL) — avoids re-fetching 19 MB on every request.
    // Cache key is stable since we always fetch the full list and filter server-side.
    const vouchers = await cachedUnifiRequest<UnifiVoucher[]>("/stat/voucher", {}, 60);

    // Compute summary stats from full list
    const stats = {
      total: vouchers.length,
      valid: vouchers.filter((v) => v.status.startsWith("VALID")).length,
      used: vouchers.filter((v) => v.status.startsWith("USED")).length,
      expired: vouchers.filter((v) => v.status === "EXPIRED").length,
    };

    // Filter by status if requested
    const filtered = statusFilter
      ? vouchers.filter((v) => v.status === statusFilter)
      : vouchers;

    // Sort: most recently created first
    filtered.sort((a, b) => b.create_time - a.create_time);

    // Server-side pagination
    const total = filtered.length;
    const totalPages = Math.ceil(total / perPage);
    const offset = (page - 1) * perPage;
    const pageSlice = filtered.slice(offset, offset + perPage);

    // Mask voucher codes — full code is only accessible via /api/unifi/vouchers/reveal
    const maskedPage = pageSlice.map((v) => ({
      ...v,
      code: maskVoucherCode(v.code),
    }));

    return NextResponse.json({
      data: maskedPage,
      stats,
      location,
      pagination: {
        page,
        per_page: perPage,
        total,
        total_pages: totalPages,
      },
    });
  } catch (err) {
    console.error("[api/unifi/vouchers] fetch failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to reach UniFi device" },
      { status: 502 }
    );
  }
}
