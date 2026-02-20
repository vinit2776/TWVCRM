import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

// POST — Detect confirmed bookings past grace period and mark as no_show
export async function POST() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users")
    .select("id, role")
    .eq("auth_id", user.id)
    .single();

  if (!dbUser || !["admin", "manager", "floor_manager"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Insufficient permissions" }, { status: 403 });
  }

  const today = new Date().toISOString().split("T")[0];
  const now = new Date();

  // Fetch today's confirmed bookings
  const { data: bookings } = await supabase
    .from("bookings")
    .select("id, booking_number, start_time, space_id")
    .eq("booking_date", today)
    .eq("status", "confirmed");

  if (!bookings || bookings.length === 0) {
    return NextResponse.json({ message: "No confirmed bookings for today", detected: 0 });
  }

  // Fetch spaces for grace period info
  const spaceIds = [...new Set(bookings.map(b => b.space_id))];
  const { data: spaces } = await supabase
    .from("spaces")
    .select("id, no_show_grace_minutes")
    .in("id", spaceIds);

  const spaceGraceMap: Record<string, number> = {};
  (spaces || []).forEach(s => {
    spaceGraceMap[s.id] = s.no_show_grace_minutes || 15;
  });

  const detected: string[] = [];

  for (const booking of bookings) {
    const [h, m] = booking.start_time.split(":").map(Number);
    const startTime = new Date(now);
    startTime.setHours(h, m, 0, 0);

    const graceMinutes = spaceGraceMap[booking.space_id] || 15;
    const graceDeadline = new Date(startTime.getTime() + graceMinutes * 60 * 1000);

    if (now > graceDeadline) {
      await supabase
        .from("bookings")
        .update({
          status: "no_show",
          no_show_detected_at: now.toISOString(),
        })
        .eq("id", booking.id);

      detected.push(booking.booking_number);
    }
  }

  return NextResponse.json({
    message: `Detected ${detected.length} no-show(s)`,
    detected: detected.length,
    booking_numbers: detected,
  });
}
