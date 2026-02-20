import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

// GET — Revenue reports
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const dateFrom = searchParams.get("date_from") || new Date(Date.now() - 180 * 86400000).toISOString().split("T")[0];
  const dateTo = searchParams.get("date_to") || new Date().toISOString().split("T")[0];
  const locationId = searchParams.get("location_id");

  // Fetch bookings in range
  let query = supabase
    .from("bookings")
    .select("id, booking_date, status, customer_type, total_amount, payment_status, space_id, space:spaces!bookings_space_id_fkey(name)")
    .gte("booking_date", dateFrom)
    .lte("booking_date", dateTo);

  if (locationId) query = query.eq("location_id", locationId);
  const { data: bookings } = await query;

  // Fetch verified payments
  const bookingIds = (bookings || []).map(b => b.id);
  let payments: { booking_id: string; amount: number; payment_mode: string }[] = [];
  if (bookingIds.length > 0) {
    const { data: paymentData } = await supabase
      .from("booking_payments")
      .select("booking_id, amount, payment_mode")
      .in("booking_id", bookingIds)
      .eq("status", "verified");
    payments = paymentData || [];
  }

  const allBookings = bookings || [];
  const totalBookings = allBookings.length;
  const cancelledCount = allBookings.filter(b => b.status === "cancelled").length;
  const noShowCount = allBookings.filter(b => b.status === "no_show").length;
  const totalRevenue = allBookings
    .filter(b => !["cancelled"].includes(b.status))
    .reduce((s, b) => s + Number(b.total_amount), 0);

  // By payment mode
  const byPaymentMode: Record<string, number> = {};
  payments.forEach(p => {
    byPaymentMode[p.payment_mode] = (byPaymentMode[p.payment_mode] || 0) + Number(p.amount);
  });

  // By customer type
  const byCustomerType: Record<string, { amount: number; count: number }> = {};
  allBookings.filter(b => b.status !== "cancelled").forEach(b => {
    if (!byCustomerType[b.customer_type]) byCustomerType[b.customer_type] = { amount: 0, count: 0 };
    byCustomerType[b.customer_type].amount += Number(b.total_amount);
    byCustomerType[b.customer_type].count++;
  });

  // By space
  const bySpace: Record<string, { amount: number; count: number; name: string }> = {};
  allBookings.filter(b => b.status !== "cancelled").forEach(b => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const spaceName = (b.space as any)?.name || "Unknown";
    if (!bySpace[b.space_id]) bySpace[b.space_id] = { amount: 0, count: 0, name: spaceName };
    bySpace[b.space_id].amount += Number(b.total_amount);
    bySpace[b.space_id].count++;
  });

  // 6-month trend
  const trend: { month: string; revenue: number; bookings: number }[] = [];
  const trendMap: Record<string, { revenue: number; bookings: number }> = {};
  allBookings.filter(b => b.status !== "cancelled").forEach(b => {
    const month = b.booking_date.substring(0, 7);
    if (!trendMap[month]) trendMap[month] = { revenue: 0, bookings: 0 };
    trendMap[month].revenue += Number(b.total_amount);
    trendMap[month].bookings++;
  });
  Object.entries(trendMap).sort((a, b) => a[0].localeCompare(b[0])).forEach(([month, data]) => {
    trend.push({ month, ...data });
  });

  return NextResponse.json({
    data: {
      period: { from: dateFrom, to: dateTo },
      total_revenue: Math.round(totalRevenue),
      total_bookings: totalBookings,
      cancellation_rate: totalBookings > 0 ? Math.round((cancelledCount / totalBookings) * 1000) / 10 : 0,
      no_show_rate: totalBookings > 0 ? Math.round((noShowCount / totalBookings) * 1000) / 10 : 0,
      by_payment_mode: Object.entries(byPaymentMode).map(([mode, amount]) => ({ mode, amount: Math.round(amount) })),
      by_customer_type: Object.entries(byCustomerType).map(([type, data]) => ({ type, amount: Math.round(data.amount), count: data.count })),
      by_space: Object.values(bySpace).map(s => ({ space_name: s.name, amount: Math.round(s.amount), count: s.count })),
      trend,
    },
  });
}
