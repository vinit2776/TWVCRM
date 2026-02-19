import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data, error } = await supabase
    .from("booking_feedbacks")
    .select(`
      *,
      rater:users!booking_feedbacks_rated_by_fkey(id, full_name),
      booking:bookings!booking_feedbacks_booking_id_fkey(
        id, booking_number, booking_date, start_time, end_time,
        space:spaces!bookings_space_id_fkey(id, name)
      )
    `)
    .eq("lead_id", id)
    .order("created_at", { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ data: data ?? [] });
}
