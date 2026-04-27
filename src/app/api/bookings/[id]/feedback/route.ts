import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { FEEDBACK_DIMENSIONS } from "@/lib/constants";

const DIMENSION_KEYS = FEEDBACK_DIMENSIONS.map((d) => d.key);

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
    .select("*, rater:users!booking_feedbacks_rated_by_fkey(id, full_name)")
    .eq("booking_id", id)
    .maybeSingle();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ data });
}

export async function POST(
  request: NextRequest,
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

  // Verify booking exists and is checked_out
  const { data: booking } = await supabase
    .from("bookings")
    .select("id, lead_id, status, booking_number")
    .eq("id", id)
    .single();

  if (!booking) return NextResponse.json({ error: "Booking not found" }, { status: 404 });
  if (booking.status !== "checked_out") {
    return NextResponse.json({ error: "Feedback can only be submitted for checked-out bookings" }, { status: 400 });
  }
  // lead_id is optional — walk-in / guest bookings may not have one

  // Check if staff feedback already exists for this booking
  const { data: existing } = await supabase
    .from("booking_feedbacks")
    .select("id")
    .eq("booking_id", id)
    .eq("source", "staff")
    .maybeSingle();

  if (existing) {
    return NextResponse.json({ error: "Staff feedback already submitted for this booking" }, { status: 409 });
  }

  const body = await request.json();

  // Extract and validate dimension ratings
  const ratings: Record<string, number | null> = {};
  let ratedCount = 0;
  let ratingSum = 0;

  for (const key of DIMENSION_KEYS) {
    const val = body[key];
    if (val != null) {
      const num = Number(val);
      if (!Number.isInteger(num) || num < 1 || num > 5) {
        return NextResponse.json({ error: `${key} must be between 1 and 5` }, { status: 400 });
      }
      ratings[key] = num;
      ratedCount++;
      ratingSum += num;
    } else {
      ratings[key] = null;
    }
  }

  if (ratedCount === 0) {
    return NextResponse.json({ error: "At least one dimension must be rated" }, { status: 400 });
  }

  // Compute overall rating as average of non-null dimensions
  const overallRating = parseFloat((ratingSum / ratedCount).toFixed(2));

  const row: Record<string, unknown> = {
    booking_id: id,
    source: "staff",
    ...ratings,
    overall_rating: overallRating,
    notes: body.notes?.trim() || null,
    rated_by: dbUser.id,
  };
  if (booking.lead_id) row.lead_id = booking.lead_id;

  const { data: feedback, error } = await supabase
    .from("booking_feedbacks")
    .insert(row)
    .select("*, rater:users!booking_feedbacks_rated_by_fkey(id, full_name)")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Log activity on lead timeline (only if booking has a linked lead)
  if (booking.lead_id) {
    await supabase.from("activities").insert({
      lead_id: booking.lead_id,
      type: "note",
      subject: `Customer Feedback — ${booking.booking_number}`,
      description: `Rated ${overallRating.toFixed(1)}/5 overall after booking #${booking.booking_number}. ${ratedCount} dimension(s) rated.${body.notes?.trim() ? ` Note: ${body.notes.trim()}` : ""}`,
      created_by: dbUser.id,
    });
  }

  return NextResponse.json({ data: feedback }, { status: 201 });
}
