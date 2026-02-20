import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

// GET — Calendar view: all bookings for all rooms in a date range
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const dateFrom = searchParams.get("date_from");
  const dateTo = searchParams.get("date_to");
  const locationId = searchParams.get("location_id");

  if (!dateFrom || !dateTo) {
    return NextResponse.json({ error: "date_from and date_to are required" }, { status: 400 });
  }

  // Fetch all spaces for the location
  let spacesQuery = supabase
    .from("spaces")
    .select("id, name, capacity, hourly_rate, operating_hours, location_id, no_show_grace_minutes")
    .eq("is_active", true)
    .order("name");

  if (locationId) {
    spacesQuery = spacesQuery.eq("location_id", locationId);
  }

  const { data: spaces, error: spacesError } = await spacesQuery;
  if (spacesError) return NextResponse.json({ error: spacesError.message }, { status: 500 });

  // Fetch all bookings in the date range
  let bookingsQuery = supabase
    .from("bookings")
    .select("id, booking_number, space_id, location_id, booking_date, start_time, end_time, duration_hours, customer_type, status, total_amount, payment_status, guest_name, lead:leads!bookings_lead_id_fkey(id, first_name, last_name, company), contract:contracts!bookings_contract_id_fkey(id, contract_number)")
    .gte("booking_date", dateFrom)
    .lte("booking_date", dateTo)
    .not("status", "eq", "cancelled");

  if (locationId) {
    bookingsQuery = bookingsQuery.eq("location_id", locationId);
  }

  const { data: bookings, error: bookingsError } = await bookingsQuery;
  if (bookingsError) return NextResponse.json({ error: bookingsError.message }, { status: 500 });

  // Group bookings by space
  const calendarData = (spaces || []).map(space => ({
    space,
    bookings: (bookings || []).filter(b => b.space_id === space.id),
  }));

  return NextResponse.json({ data: calendarData });
}
