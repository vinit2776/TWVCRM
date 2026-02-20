import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

// GET — Returns pre-filled booking payload from existing booking for quick re-book
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: booking, error } = await supabase
    .from("bookings")
    .select("*, facilities:booking_facilities(facility_name)")
    .eq("id", id)
    .single();

  if (error || !booking) {
    return NextResponse.json({ error: "Booking not found" }, { status: 404 });
  }

  // Return pre-fill data for the new booking form
  return NextResponse.json({
    data: {
      space_id: booking.space_id,
      start_time: booking.start_time?.slice(0, 5),
      end_time: booking.end_time?.slice(0, 5),
      customer_type: booking.customer_type,
      contract_id: booking.contract_id,
      lead_id: booking.lead_id,
      booker_phone: booking.booker_phone,
      guest_name: booking.guest_name,
      guest_email: booking.guest_email,
      guest_phone: booking.guest_phone,
      guest_company: booking.guest_company,
      notes: booking.notes,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      facility_names: (booking.facilities || []).map((f: any) => f.facility_name),
    },
  });
}
