import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

// PATCH — Cancel or update waitlist entry
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();

  if (body.status === "cancelled") {
    const { data, error } = await supabase
      .from("booking_waitlist")
      .update({ status: "cancelled" })
      .eq("id", id)
      .select()
      .single();

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ data });
  }

  return NextResponse.json({ error: "Invalid update" }, { status: 400 });
}

// POST — Convert waitlist entry to booking
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users")
    .select("id")
    .eq("auth_id", user.id)
    .single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 401 });

  // Fetch waitlist entry
  const { data: entry, error: fetchError } = await supabase
    .from("booking_waitlist")
    .select("*")
    .eq("id", id)
    .single();

  if (fetchError || !entry) return NextResponse.json({ error: "Waitlist entry not found" }, { status: 404 });
  if (entry.status !== "waiting" && entry.status !== "offered") {
    return NextResponse.json({ error: "Entry is not in waiting/offered status" }, { status: 400 });
  }

  // Check if slot is still available
  const { data: conflicts } = await supabase
    .from("bookings")
    .select("id")
    .eq("space_id", entry.space_id)
    .eq("booking_date", entry.booking_date)
    .not("status", "in", "(cancelled,no_show)")
    .lt("start_time", entry.end_time)
    .gt("end_time", entry.start_time);

  if (conflicts && conflicts.length > 0) {
    return NextResponse.json({ error: "Slot is no longer available" }, { status: 409 });
  }

  // Fetch space for rate
  const { data: space } = await supabase
    .from("spaces")
    .select("hourly_rate")
    .eq("id", entry.space_id)
    .single();

  const [sh, sm] = entry.start_time.split(":").map(Number);
  const [eh, em] = entry.end_time.split(":").map(Number);
  const durationHours = (eh * 60 + em - sh * 60 - sm) / 60;
  const hourlyRate = space?.hourly_rate || 0;
  const totalAmount = hourlyRate * durationHours;

  // Create booking
  const { data: booking, error: bookingError } = await supabase
    .from("bookings")
    .insert({
      space_id: entry.space_id,
      location_id: entry.location_id,
      booking_date: entry.booking_date,
      start_time: entry.start_time,
      end_time: entry.end_time,
      duration_hours: durationHours,
      customer_type: entry.customer_type,
      contract_id: entry.contract_id || null,
      lead_id: entry.lead_id || null,
      guest_name: entry.guest_name || null,
      guest_phone: entry.guest_phone || null,
      booker_phone: entry.booker_phone,
      hourly_rate: hourlyRate,
      total_amount: totalAmount,
      payment_status: entry.customer_type === "contract_holder" ? "posted_to_bill" : "pending",
      status: "confirmed",
      notes: entry.notes || null,
      created_by: dbUser.id,
    })
    .select("id, booking_number")
    .single();

  if (bookingError) return NextResponse.json({ error: bookingError.message }, { status: 500 });

  // Mark waitlist entry as booked
  await supabase
    .from("booking_waitlist")
    .update({ status: "booked" })
    .eq("id", id);

  return NextResponse.json({ data: booking, message: "Booking created from waitlist" });
}
