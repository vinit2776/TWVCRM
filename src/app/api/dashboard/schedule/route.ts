import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** "HH:mm" in IST for a stored UTC timestamp — this route runs on a UTC
 * server, so plain Date getHours()/getMinutes() would return the UTC hour,
 * not the IST wall-clock hour actually meant. */
function toIstHHmm(iso: string): string {
  const shifted = new Date(new Date(iso).getTime() + IST_OFFSET_MS);
  return `${String(shifted.getUTCHours()).padStart(2, "0")}:${String(shifted.getUTCMinutes()).padStart(2, "0")}`;
}

/**
 * GET /api/dashboard/schedule?location_id=<uuid>
 * Returns a unified ordered timeline for today: bookings (with start time),
 * scheduled meetings/tours from activities (with meeting_start_at), and
 * follow-ups due today. For sales_rep / floor_manager, scoped to own leads.
 *
 * Each item: { time, title, subtitle, kind, href }
 * where kind is 'booking' | 'meeting' | 'tour' | 'follow_up'.
 */
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const adminSupabase = await createAdminClient();
  const { data: dbUser } = await adminSupabase
    .from("users")
    .select("id, role")
    .eq("auth_id", user.id)
    .single();

  if (!dbUser) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const locationId = request.nextUrl.searchParams.get("location_id");

  // "Today" means the IST calendar day, not the UTC one — this route runs on
  // a UTC server, so a plain new Date().toISOString() would roll over to
  // tomorrow's date 5:30 early (at 6:30pm IST) and, worse, still show
  // yesterday's date for the first 5.5 hours of the actual IST day.
  const istNow = new Date(Date.now() + IST_OFFSET_MS);
  const todayStr = istNow.toISOString().split("T")[0];
  const startOfDay = new Date(`${todayStr}T00:00:00.000+05:30`).toISOString();
  const endOfDay = new Date(`${todayStr}T23:59:59.999+05:30`).toISOString();

  // Bookings today
  let bookingsQ = adminSupabase
    .from("bookings")
    .select(
      "id, start_time, end_time, guest_name, guest_company, status, location_id, lead:leads(first_name, last_name)"
    )
    .eq("booking_date", todayStr)
    .neq("status", "cancelled")
    .order("start_time", { ascending: true });
  if (locationId) bookingsQ = bookingsQ.eq("location_id", locationId);

  // Activities (meeting / tour) starting today
  const actsQ = adminSupabase
    .from("activities")
    .select(
      "id, type, subject, meeting_start_at, meeting_location, lead_id, lead:leads(id, first_name, last_name, location_id, assigned_to)"
    )
    .in("type", ["meeting", "tour"])
    .gte("meeting_start_at", startOfDay)
    .lte("meeting_start_at", endOfDay)
    .order("meeting_start_at", { ascending: true });

  // Follow-ups due today (not done)
  const followsQ = adminSupabase
    .from("activities")
    .select(
      "id, follow_up_date, follow_up_notes, type, subject, lead_id, lead:leads(id, first_name, last_name, location_id, assigned_to)"
    )
    .eq("is_follow_up_done", false)
    .gte("follow_up_date", startOfDay)
    .lte("follow_up_date", endOfDay)
    .order("follow_up_date", { ascending: true });

  const [
    { data: bookings },
    { data: activities },
    { data: followups },
  ] = await Promise.all([bookingsQ, actsQ, followsQ]);

  type Lead = { id?: string; first_name: string; last_name: string; location_id?: string; assigned_to?: string };
  type Act = { id: string; type: string; subject: string | null; meeting_start_at: string; meeting_location: string | null; lead: Lead | null };
  type Fu = { id: string; follow_up_date: string; follow_up_notes: string | null; type: string; subject: string | null; lead: Lead | null };
  type Booking = { id: string; start_time: string; end_time: string; guest_name: string | null; guest_company: string | null; status: string; lead: Lead | null };

  // Filter by ownership for non-managers
  const ownsOnly = dbUser.role === "sales_rep" || dbUser.role === "floor_manager";
  const myId = dbUser.id;

  const filtAct = (rows: Act[] | null) =>
    !ownsOnly ? (rows ?? []) : (rows ?? []).filter((r) => r.lead?.assigned_to === myId);
  const filtFu = (rows: Fu[] | null) =>
    !ownsOnly ? (rows ?? []) : (rows ?? []).filter((r) => r.lead?.assigned_to === myId);
  const filtBy = (rows: Act[] | Fu[] | null) =>
    !locationId ? (rows ?? []) : (rows ?? []).filter((r) => r.lead?.location_id === locationId);

  type Item = { time: string; title: string; subtitle: string; kind: string; href: string; iso: string };

  const items: Item[] = [];

  for (const b of (bookings ?? []) as unknown as Booking[]) {
    const customer =
      b.lead ? `${b.lead.first_name} ${b.lead.last_name}` : b.guest_name ?? "Walk-in";
    items.push({
      iso: `${todayStr}T${b.start_time}`,
      time: b.start_time.slice(0, 5),
      title: customer,
      subtitle: `${b.guest_company ? b.guest_company + " · " : ""}Booking · ${b.status}`,
      kind: "booking",
      href: `/bookings/${b.id}`,
    });
  }

  for (const a of filtBy(filtAct(activities as unknown as Act[])) as Act[]) {
    const lead = a.lead ? `${a.lead.first_name} ${a.lead.last_name}` : "—";
    items.push({
      iso: a.meeting_start_at,
      time: toIstHHmm(a.meeting_start_at),
      title: lead,
      subtitle: `${a.type === "tour" ? "Tour" : "Meeting"}${a.subject ? " · " + a.subject : ""}`,
      kind: a.type,
      href: a.lead?.id ? `/leads/${a.lead.id}` : `/activities`,
    });
  }

  for (const f of filtBy(filtFu(followups as unknown as Fu[])) as Fu[]) {
    const lead = f.lead ? `${f.lead.first_name} ${f.lead.last_name}` : "—";
    items.push({
      iso: f.follow_up_date,
      time: toIstHHmm(f.follow_up_date),
      title: lead,
      subtitle: `Follow-up${f.follow_up_notes ? " · " + f.follow_up_notes.slice(0, 60) : ""}`,
      kind: "follow_up",
      href: f.lead?.id ? `/leads/${f.lead.id}` : `/activities`,
    });
  }

  items.sort((a, b) => a.iso.localeCompare(b.iso));

  return NextResponse.json({
    data: {
      total: items.length,
      items: items.slice(0, 12).map(({ iso: _iso, ...rest }) => {
        void _iso;
        return rest;
      }),
    },
  });
}
