import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";

/**
 * POST /api/booking-gst-tasks/[id]/void
 *
 * Excludes a booking's Tally Inbox worklist row from the open tab, without
 * touching the underlying booking/payment/GST-invoice data — for test or
 * bad-data rows that shouldn't be actioned. Mirrors billing_statements'
 * voided_at pattern (see .../billing-statements/[id]/void/route.ts), but
 * simpler: booking_gst_tasks has no draft/reissue lifecycle to unwind.
 *
 * Guards:
 *   • Admin only
 *   • Reason required
 *   • Already-voided task is a no-op error, not silently re-voided
 */
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
    .select("id, role")
    .eq("auth_id", user.id)
    .single();

  if (!dbUser || dbUser.role !== "admin") {
    return NextResponse.json({ error: "Only admin can void a booking Tally task" }, { status: 403 });
  }

  const body = await request.json().catch(() => ({})) as { void_reason?: string };
  const voidReason = body.void_reason?.trim();
  if (!voidReason) {
    return NextResponse.json({ error: "A reason for voiding is required" }, { status: 400 });
  }

  const { data: task, error: fetchErr } = await supabase
    .from("booking_gst_tasks")
    .select("id, voided_at, booking:bookings!booking_gst_tasks_booking_id_fkey(booking_number)")
    .eq("id", id)
    .single();

  if (fetchErr || !task) {
    return NextResponse.json({ error: "Booking task not found" }, { status: 404 });
  }
  if (task.voided_at) {
    return NextResponse.json({ error: "This booking task is already voided" }, { status: 409 });
  }

  const { error: voidErr } = await supabase
    .from("booking_gst_tasks")
    .update({ voided_at: new Date().toISOString(), voided_by: dbUser.id, void_reason: voidReason })
    .eq("id", id);

  if (voidErr) {
    return NextResponse.json({ error: voidErr.message }, { status: 500 });
  }

  logAudit(supabase, {
    entityType: "booking",
    entityId: id,
    action: "update",
    performedBy: dbUser.id,
    changes: { booking_gst_task_voided: { old: null, new: voidReason } },
  });

  return NextResponse.json({ ok: true });
}
