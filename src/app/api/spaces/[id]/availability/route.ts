import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

const DAYS_OF_WEEK = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

function timeToMinutes(time: string): number {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
}

function minutesToTime(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const date = searchParams.get("date");
  if (!date) {
    return NextResponse.json({ error: "date parameter is required (YYYY-MM-DD)" }, { status: 400 });
  }

  // Fetch space with operating hours
  const { data: space, error: spaceError } = await supabase
    .from("spaces")
    .select("id, name, operating_hours, min_booking_minutes, is_active")
    .eq("id", id)
    .single();

  if (spaceError || !space) {
    return NextResponse.json({ error: "Space not found" }, { status: 404 });
  }

  // Get day of week
  const dayOfWeek = DAYS_OF_WEEK[new Date(date + "T00:00:00").getDay()];
  const dayHours = space.operating_hours?.[dayOfWeek];

  if (!dayHours || !dayHours.is_open) {
    return NextResponse.json({
      data: {
        date,
        day: dayOfWeek,
        is_open: false,
        operating_hours: dayHours || null,
        booked_slots: [],
        available_slots: [],
      },
    });
  }

  // Fetch booked slots for this date
  const { data: bookings } = await supabase
    .from("bookings")
    .select("start_time, end_time, booking_number, status")
    .eq("space_id", id)
    .eq("booking_date", date)
    .in("status", ["confirmed", "checked_in"])
    .order("start_time");

  const bookedSlots = (bookings || []).map((b) => ({
    start_time: b.start_time.slice(0, 5),
    end_time: b.end_time.slice(0, 5),
    booking_number: b.booking_number,
    status: b.status,
  }));

  // Compute available slots (15-min increments)
  const openMin = timeToMinutes(dayHours.open);
  const closeMin = timeToMinutes(dayHours.close);
  const slotSize = 15; // minutes

  const available: { start_time: string; end_time: string }[] = [];
  let cursor = openMin;

  while (cursor + slotSize <= closeMin) {
    const slotStart = cursor;
    const slotEnd = cursor + slotSize;

    // Check if this slot overlaps with any booking
    const overlaps = bookedSlots.some((b) => {
      const bStart = timeToMinutes(b.start_time);
      const bEnd = timeToMinutes(b.end_time);
      return slotStart < bEnd && slotEnd > bStart;
    });

    if (!overlaps) {
      available.push({
        start_time: minutesToTime(slotStart),
        end_time: minutesToTime(slotEnd),
      });
    }

    cursor += slotSize;
  }

  return NextResponse.json({
    data: {
      date,
      day: dayOfWeek,
      is_open: true,
      operating_hours: dayHours,
      booked_slots: bookedSlots,
      available_slots: available,
      min_booking_minutes: space.min_booking_minutes,
    },
  });
}
