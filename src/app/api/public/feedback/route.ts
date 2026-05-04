import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";

// GET — Fetch booking details by feedback token (no auth required)
// POST — Submit feedback by token (no auth required)
//
// These routes are accessed by unauthenticated customers. We use the admin
// (service-role) client so that RLS is bypassed for the token lookup.
// The token itself acts as the auth proof — it's a UUID only the booking
// confirmation email recipient would have.
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const token = searchParams.get("token");
  if (!token) return NextResponse.json({ error: "Token required" }, { status: 400 });

  const supabase = createAdminClient();

  const { data: booking, error } = await supabase
    .from("bookings")
    .select("id, booking_number, booking_date, start_time, end_time, space:spaces!bookings_space_id_fkey(name), lead:leads!bookings_lead_id_fkey(first_name, last_name), guest_name, status")
    .eq("feedback_token", token)
    .single();

  if (error || !booking) {
    return NextResponse.json({ error: "Invalid or expired feedback link" }, { status: 404 });
  }

  if (!["checked_out", "no_show"].includes(booking.status)) {
    return NextResponse.json({ error: "Feedback not available for this booking status" }, { status: 400 });
  }

  // Check if feedback already exists
  const { data: existing } = await supabase
    .from("booking_feedbacks")
    .select("id")
    .eq("booking_id", booking.id)
    .maybeSingle();

  return NextResponse.json({
    data: {
      booking_id: booking.id,
      booking_number: booking.booking_number,
      booking_date: booking.booking_date,
      start_time: booking.start_time,
      end_time: booking.end_time,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      space_name: (booking.space as any)?.name || "",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      customer_name: (booking.lead as any)?.first_name ? `${(booking.lead as any).first_name} ${(booking.lead as any).last_name}` : booking.guest_name || "Guest",
      already_submitted: !!existing,
    },
  });
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { token, space_etiquette, payment_discipline, community_behavior, guest_management, resource_usage, renewal_likelihood, notes } = body;

  if (!token) return NextResponse.json({ error: "Token required" }, { status: 400 });

  const supabase = createAdminClient();

  const { data: booking, error } = await supabase
    .from("bookings")
    .select("id, lead_id")
    .eq("feedback_token", token)
    .single();

  if (error || !booking) {
    return NextResponse.json({ error: "Invalid or expired feedback link" }, { status: 404 });
  }

  // Check if customer feedback already exists
  const { data: existing } = await supabase
    .from("booking_feedbacks")
    .select("id")
    .eq("booking_id", booking.id)
    .eq("source", "customer")
    .maybeSingle();

  if (existing) {
    return NextResponse.json({ error: "Feedback already submitted for this booking" }, { status: 409 });
  }

  const ratings = [space_etiquette, payment_discipline, community_behavior, guest_management, resource_usage, renewal_likelihood].filter(r => r != null);
  const overallRating = ratings.length > 0 ? ratings.reduce((s: number, r: number) => s + r, 0) / ratings.length : null;

  const { data: feedback, error: insertError } = await supabase
    .from("booking_feedbacks")
    .insert({
      booking_id: booking.id,
      lead_id: booking.lead_id,
      source: "customer",
      space_etiquette: space_etiquette ?? null,
      payment_discipline: payment_discipline ?? null,
      community_behavior: community_behavior ?? null,
      guest_management: guest_management ?? null,
      resource_usage: resource_usage ?? null,
      renewal_likelihood: renewal_likelihood ?? null,
      overall_rating: overallRating ? parseFloat((overallRating).toFixed(2)) : null,
      notes: notes || null,
    })
    .select()
    .single();

  if (insertError) return NextResponse.json({ error: insertError.message }, { status: 500 });

  // Recalculate lead score if lead exists
  if (booking.lead_id) {
    const { data: allFeedback } = await supabase
      .from("booking_feedbacks")
      .select("overall_rating")
      .eq("lead_id", booking.lead_id)
      .not("overall_rating", "is", null);

    if (allFeedback && allFeedback.length > 0) {
      const avgRating = allFeedback.reduce((s, f) => s + (f.overall_rating || 0), 0) / allFeedback.length;
      const newScore = Math.min(100, Math.round(avgRating * 20));
      await supabase.from("leads").update({ score: newScore }).eq("id", booking.lead_id);
    }
  }

  return NextResponse.json({ data: feedback, message: "Thank you for your feedback!" });
}
