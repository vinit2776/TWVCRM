import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

// GET — Customer booking history summary
// ?phone=X or ?lead_id=X
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const phone = searchParams.get("phone");
  const leadId = searchParams.get("lead_id");

  if (!phone && !leadId) {
    return NextResponse.json({ error: "phone or lead_id is required" }, { status: 400 });
  }

  // Find lead(s)
  let leadIds: string[] = [];

  if (leadId) {
    leadIds = [leadId];
  } else if (phone) {
    const { data: leads } = await supabase
      .from("leads")
      .select("id")
      .or(`phone.eq.${phone},mobile.eq.${phone}`);
    leadIds = (leads || []).map(l => l.id);

    if (leadIds.length === 0) {
      // Check by booker_phone in bookings
      const { data: bookings } = await supabase
        .from("bookings")
        .select("id, booking_number, booking_date, start_time, end_time, space_id, status, total_amount, customer_type, guest_name")
        .eq("booker_phone", phone)
        .order("booking_date", { ascending: false });

      const totalBookings = bookings?.length || 0;
      const totalSpent = (bookings || []).reduce((s, b) => s + Number(b.total_amount), 0);
      const lastVisit = bookings?.[0]?.booking_date || null;

      return NextResponse.json({
        data: {
          name: bookings?.[0]?.guest_name || "Unknown",
          phone,
          lead_id: null,
          total_bookings: totalBookings,
          last_visit: lastVisit,
          preferred_room: null,
          total_spent: totalSpent,
          avg_spent: totalBookings > 0 ? totalSpent / totalBookings : 0,
          avg_feedback: null,
          segment: totalBookings >= 5 ? "frequent" : totalBookings === 0 ? "new" : "regular",
          recent_bookings: (bookings || []).slice(0, 5),
        },
      });
    }
  }

  // Fetch bookings for lead
  const { data: bookings } = await supabase
    .from("bookings")
    .select("id, booking_number, booking_date, start_time, end_time, space_id, status, total_amount, customer_type, space:spaces!bookings_space_id_fkey(id, name)")
    .in("lead_id", leadIds)
    .order("booking_date", { ascending: false });

  // Fetch feedback
  const { data: feedbacks } = await supabase
    .from("booking_feedbacks")
    .select("overall_rating")
    .in("lead_id", leadIds)
    .not("overall_rating", "is", null);

  // Fetch lead info
  const { data: lead } = await supabase
    .from("leads")
    .select("id, first_name, last_name, company, phone, email")
    .eq("id", leadIds[0])
    .single();

  const totalBookings = bookings?.length || 0;
  const totalSpent = (bookings || []).reduce((s, b) => s + Number(b.total_amount), 0);
  const lastVisit = bookings?.[0]?.booking_date || null;
  const avgFeedback = feedbacks && feedbacks.length > 0
    ? feedbacks.reduce((s, f) => s + (f.overall_rating || 0), 0) / feedbacks.length
    : null;

  // Find preferred room
  const roomCount: Record<string, { name: string; count: number }> = {};
  (bookings || []).forEach(b => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const spaceName = (b.space as any)?.name || b.space_id;
    if (!roomCount[b.space_id]) roomCount[b.space_id] = { name: spaceName, count: 0 };
    roomCount[b.space_id].count++;
  });
  const preferredRoom = Object.values(roomCount).sort((a, b) => b.count - a.count)[0]?.name || null;

  // Determine segment
  let segment = "regular";
  const ninetyDaysAgo = new Date();
  ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);
  const recentBookings = (bookings || []).filter(b => new Date(b.booking_date) >= ninetyDaysAgo);
  if (recentBookings.length >= 5) segment = "frequent";
  else if (lastVisit && new Date(lastVisit) < new Date(Date.now() - 60 * 86400000)) segment = "lapsed";
  if (avgFeedback !== null && avgFeedback < 2.5) segment = "low_feedback";

  return NextResponse.json({
    data: {
      name: lead ? `${lead.first_name} ${lead.last_name}` : "Unknown",
      company: lead?.company || null,
      phone: lead?.phone || phone,
      email: lead?.email || null,
      lead_id: lead?.id || null,
      total_bookings: totalBookings,
      last_visit: lastVisit,
      preferred_room: preferredRoom,
      total_spent: totalSpent,
      avg_spent: totalBookings > 0 ? totalSpent / totalBookings : 0,
      avg_feedback: avgFeedback,
      segment,
      recent_bookings: (bookings || []).slice(0, 5),
    },
  });
}
