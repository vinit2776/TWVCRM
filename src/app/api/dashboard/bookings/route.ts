import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { getDashboardAuth } from "@/lib/dashboard-auth";

/**
 * GET /api/dashboard/bookings?location_id=<uuid>
 * Returns today's booking summary for the Booking Summary widget.
 * Access: admin, manager, floor_manager (not sales_rep).
 */
export async function GET(request: NextRequest) {
  const { user, dbUser } = await getDashboardAuth();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const adminSupabase = await createAdminClient();

  if (!dbUser || dbUser.role === "sales_rep") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const locationId = request.nextUrl.searchParams.get("location_id");
  const today = new Date().toISOString().split("T")[0]; // YYYY-MM-DD

  let query = adminSupabase
    .from("bookings")
    .select("id, status, total_amount, booking_payments(amount, status)")
    .eq("booking_date", today);

  if (locationId) {
    query = query.eq("location_id", locationId);
  }

  const { data: bookings, error } = await query;

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const all = bookings ?? [];
  const confirmed = all.filter((b) => b.status === "confirmed").length;
  const completed = all.filter((b) => b.status === "completed").length;
  const noShow = all.filter((b) => b.status === "no_show").length;
  const cancelled = all.filter((b) => b.status === "cancelled").length;

  // Revenue: sum of verified payments for today's bookings
  const revenue = all.reduce((sum, b) => {
    const payments = Array.isArray(b.booking_payments) ? b.booking_payments : [];
    const paid = payments
      .filter((p: { status: string; amount: number }) => p.status === "verified")
      .reduce((s: number, p: { amount: number }) => s + (p.amount ?? 0), 0);
    return sum + paid;
  }, 0);

  return NextResponse.json({
    data: {
      total: all.length,
      confirmed,
      completed,
      no_show: noShow,
      cancelled,
      revenue: Math.round(revenue * 100) / 100,
    },
  });
}
