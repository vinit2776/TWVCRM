/**
 * POST /api/bookings/[id]/reopen
 *
 * Reverses a Mark Closed within a 24-hour window — for the "I forgot
 * to add the coffee charge" moment. Floor manager+ only, audit-logged.
 * After 24 hours, hard-locked: any change that requires touching a
 * closed booking has to go through a refund / new-booking workflow.
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";

const STAFF_ROLES = new Set(["admin", "manager", "floor_manager"]);
const REOPEN_WINDOW_MS = 24 * 60 * 60 * 1000;

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser || !STAFF_ROLES.has(dbUser.role)) {
    return NextResponse.json(
      { error: "Floor manager / manager / admin access required to reopen" },
      { status: 403 }
    );
  }

  const { data: booking, error: bErr } = await supabase
    .from("bookings")
    .select("id, status, closed_at")
    .eq("id", id)
    .single();
  if (bErr || !booking) return NextResponse.json({ error: "Booking not found" }, { status: 404 });

  if (booking.status !== "closed" || !booking.closed_at) {
    return NextResponse.json({ error: "Booking is not closed" }, { status: 400 });
  }

  // 24-hour window check. Past that, the transaction is considered
  // historical — any correction goes through the refund flow.
  const closedMs = new Date(booking.closed_at).getTime();
  const ageMs = Date.now() - closedMs;
  if (ageMs > REOPEN_WINDOW_MS) {
    return NextResponse.json(
      { error: `Reopen window expired (closed ${Math.round(ageMs / 3_600_000)}h ago, limit 24h)` },
      { status: 400 }
    );
  }

  // Reopen restores to checked_out — that's the state Wrap Up was
  // launched from. Cancelled / no_show closures shouldn't go through
  // this path; the close-from-terminal route is informational.
  const { data: updated, error: updateErr } = await supabase
    .from("bookings")
    .update({
      status: "checked_out",
      closed_at: null,
      closed_by: null,
    })
    .eq("id", id)
    .select("*")
    .single();

  if (updateErr || !updated) {
    return NextResponse.json(
      { error: "Failed to reopen: " + (updateErr?.message ?? "unknown") },
      { status: 500 }
    );
  }

  logAudit(supabase, {
    entityType: "booking",
    entityId: id,
    action: "update",
    performedBy: dbUser.id,
    changes: {
      status: { old: "closed", new: "checked_out" },
      closed_at: { old: booking.closed_at, new: null },
      reason: { old: null, new: "Reopened within 24h window" },
    },
  });

  return NextResponse.json({ data: updated });
}
