import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";

// GET — Single series detail with all bookings
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: series, error } = await supabase
    .from("recurring_booking_series")
    .select("*, space:spaces!recurring_booking_series_space_id_fkey(id, name), contract:contracts!recurring_booking_series_contract_id_fkey(id, contract_number), lead:leads!recurring_booking_series_lead_id_fkey(id, first_name, last_name, company)")
    .eq("id", id)
    .single();

  if (error) return NextResponse.json({ error: "Series not found" }, { status: 404 });

  // Fetch all bookings in the series
  const { data: bookings } = await supabase
    .from("bookings")
    .select("id, booking_number, booking_date, start_time, end_time, status, total_amount, payment_status")
    .eq("series_id", id)
    .order("booking_date", { ascending: true });

  return NextResponse.json({ data: { ...series, bookings: bookings || [] } });
}

// PATCH — Cancel series + all future confirmed bookings
export async function PATCH(
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

  const body = await request.json();

  if (body.is_active === false) {
    // Cancel the series
    await supabase
      .from("recurring_booking_series")
      .update({ is_active: false })
      .eq("id", id);

    // Cancel all future confirmed bookings in this series
    const today = new Date().toISOString().split("T")[0];
    const { data: futureBookings } = await supabase
      .from("bookings")
      .select("id")
      .eq("series_id", id)
      .eq("status", "confirmed")
      .gte("booking_date", today);

    let cancelledCount = 0;
    if (futureBookings) {
      for (const b of futureBookings) {
        await supabase.from("bookings").update({ status: "cancelled" }).eq("id", b.id);
        cancelledCount++;
      }
    }

    logAudit(supabase, {
      entityType: "booking",
      entityId: id,
      action: "update",
      performedBy: dbUser.id,
      changes: { series_cancelled: { old: true, new: false }, bookings_cancelled: { old: 0, new: cancelledCount } },
    });

    return NextResponse.json({ message: `Series cancelled. ${cancelledCount} future booking(s) cancelled.` });
  }

  return NextResponse.json({ error: "No valid updates" }, { status: 400 });
}
