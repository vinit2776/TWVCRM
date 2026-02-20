import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

// GET — Room utilization analytics
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const dateFrom = searchParams.get("date_from") || new Date(Date.now() - 30 * 86400000).toISOString().split("T")[0];
  const dateTo = searchParams.get("date_to") || new Date().toISOString().split("T")[0];
  const locationId = searchParams.get("location_id");

  // Fetch spaces
  let spacesQuery = supabase.from("spaces").select("id, name, operating_hours, location_id, location:locations!spaces_location_id_fkey(name)").eq("is_active", true);
  if (locationId) spacesQuery = spacesQuery.eq("location_id", locationId);
  const { data: spaces } = await spacesQuery;

  // Fetch bookings in range (exclude cancelled)
  let bookingsQuery = supabase
    .from("bookings")
    .select("space_id, booking_date, start_time, end_time, duration_hours, total_amount, status")
    .gte("booking_date", dateFrom)
    .lte("booking_date", dateTo)
    .not("status", "in", "(cancelled)");

  if (locationId) bookingsQuery = bookingsQuery.eq("location_id", locationId);
  const { data: bookings } = await bookingsQuery;

  // Calculate utilization per space
  const startD = new Date(dateFrom + "T00:00:00");
  const endD = new Date(dateTo + "T00:00:00");
  const totalDays = Math.ceil((endD.getTime() - startD.getTime()) / 86400000) + 1;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const utilization = (spaces || []).map((space: any) => {
    const spaceBookings = (bookings || []).filter(b => b.space_id === space.id);

    // Calculate available hours from operating hours
    const opHours = space.operating_hours || {};
    let totalAvailableHours = 0;
    const current = new Date(startD);
    while (current <= endD) {
      const dayNames = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
      const dayName = dayNames[current.getDay()];
      const dayConfig = opHours[dayName];
      if (dayConfig?.is_open) {
        const [oh, om] = (dayConfig.open || "09:00").split(":").map(Number);
        const [ch, cm] = (dayConfig.close || "18:00").split(":").map(Number);
        totalAvailableHours += (ch * 60 + cm - oh * 60 - om) / 60;
      }
      current.setDate(current.getDate() + 1);
    }

    const bookedHours = spaceBookings.reduce((s, b) => s + Number(b.duration_hours), 0);
    const revenue = spaceBookings.filter(b => b.status !== "no_show").reduce((s, b) => s + Number(b.total_amount), 0);
    const utilizationPct = totalAvailableHours > 0 ? (bookedHours / totalAvailableHours) * 100 : 0;

    // Peak hours heatmap
    const hourCounts: Record<number, number> = {};
    spaceBookings.forEach(b => {
      const startHour = parseInt(b.start_time.split(":")[0]);
      const endHour = parseInt(b.end_time.split(":")[0]);
      for (let h = startHour; h < endHour; h++) {
        hourCounts[h] = (hourCounts[h] || 0) + 1;
      }
    });
    const peakHours = Object.entries(hourCounts)
      .map(([hour, count]) => ({ hour: parseInt(hour), count }))
      .sort((a, b) => b.count - a.count);

    return {
      space_id: space.id,
      space_name: space.name,
      location_name: space.location?.name || "",
      available_hours: Math.round(totalAvailableHours * 10) / 10,
      booked_hours: Math.round(bookedHours * 10) / 10,
      utilization_pct: Math.round(utilizationPct * 10) / 10,
      revenue: Math.round(revenue),
      total_bookings: spaceBookings.length,
      peak_hours: peakHours.slice(0, 5),
    };
  });

  return NextResponse.json({
    data: utilization,
    period: { from: dateFrom, to: dateTo, total_days: totalDays },
  });
}
