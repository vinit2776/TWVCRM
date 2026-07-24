/**
 * GET /api/ruijie/vouchers?location_id=<uuid>&status=<filter>&page=1&per_page=20
 *
 * Proxies to Ruijie Cloud for the given location and returns paginated voucher data.
 * Only available for locations with wifi_voucher_mode = 'ruijie_api'.
 * Requires admin | manager | sales_rep | floor_manager | office_admin | it_manager role.
 *
 * Response: { data, stats, location, pagination: { page, per_page, total, total_pages } }
 */
import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { listRuijieVouchers } from "@/lib/ruijie";
import { maskVoucherCode } from "@/lib/utils";

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
  const statusFilter = searchParams.get("status"); // "1" | "2" | "3"

  const pageParam = parseInt(searchParams.get("page") ?? "1", 10);
  const perPageParam = parseInt(searchParams.get("per_page") ?? "20", 10);
  const page = Math.max(isNaN(pageParam) ? 1 : pageParam, 1);
  const perPage = Math.min(Math.max(isNaN(perPageParam) ? 20 : perPageParam, 1), 100);

  if (!locationId) {
    return NextResponse.json({ error: "location_id is required" }, { status: 400 });
  }

  const admin = createAdminClient();
  const { data: location } = await admin
    .from("locations")
    .select("id, name, code, ruijie_group_id")
    .eq("id", locationId)
    .single();

  if (!location?.ruijie_group_id) {
    return NextResponse.json({ error: "This location is not managed via the Ruijie API" }, { status: 400 });
  }

  try {
    const vouchers = await listRuijieVouchers(location.ruijie_group_id);

    const stats = {
      total: vouchers.length,
      unused: vouchers.filter((v) => v.status === "1").length,
      inUse: vouchers.filter((v) => v.status === "2").length,
      expired: vouchers.filter((v) => v.status === "3").length,
    };

    const filtered = statusFilter ? vouchers.filter((v) => v.status === statusFilter) : vouchers;
    filtered.sort((a, b) => b.createTime - a.createTime);

    const total = filtered.length;
    const totalPages = Math.ceil(total / perPage) || 1;
    const offset = (page - 1) * perPage;
    const pageSlice = filtered.slice(offset, offset + perPage);

    const maskedPage = pageSlice.map((v) => ({ ...v, code: maskVoucherCode(v.code) }));

    return NextResponse.json({
      data: maskedPage,
      stats,
      location,
      pagination: { page, per_page: perPage, total, total_pages: totalPages },
    });
  } catch (err) {
    console.error("[api/ruijie/vouchers] fetch failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to reach Ruijie Cloud" },
      { status: 502 }
    );
  }
}
