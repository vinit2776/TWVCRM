/**
 * POST /api/bookings/[id]/close
 *
 * Marks a checked_out booking as fully wrapped — payment + addons
 * settled, internal rating + customer feedback handled (or explicitly
 * skipped). Sets status='closed' + closed_at + closed_by.
 *
 * Wrap-Up failure semantics (locked with product owner):
 *   • Payment must be settled (paid / waived / posted_to_bill / prepaid).
 *     This is the one HARD requirement — closing with an unpaid balance
 *     would be lying about the transaction state.
 *   • Internal rating + feedback are recommended but skippable. The UI
 *     records skips in the audit trail so management can see how often
 *     they're skipped.
 *   • The "Mark Closed" action is the staff member's affirmation. It
 *     does not auto-derive from any combination of fields.
 *
 * Body:
 *   {
 *     skipped_steps?: string[]   // e.g. ["rating", "feedback"]
 *     notes?: string
 *   }
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";

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
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 401 });

  const body = await _request.json().catch(() => ({}));
  const skippedSteps: string[] = Array.isArray(body.skipped_steps) ? body.skipped_steps : [];
  const notes = (body.notes as string | undefined)?.trim() || null;

  // Load + state-machine guard. Closing only makes sense from a true
  // terminal in-physical-leg state.
  const { data: booking, error: bErr } = await supabase
    .from("bookings")
    .select("id, status, payment_status, total_amount_with_gst, total_amount, closed_at")
    .eq("id", id)
    .single();
  if (bErr || !booking) return NextResponse.json({ error: "Booking not found" }, { status: 404 });

  if (booking.status === "closed") {
    return NextResponse.json({ error: "Booking is already closed" }, { status: 400 });
  }
  if (!["checked_out", "cancelled", "no_show"].includes(booking.status)) {
    return NextResponse.json(
      { error: `Can only close a checked_out / cancelled / no_show booking (current: ${booking.status})` },
      { status: 400 }
    );
  }

  // Hard requirement: money must be accounted for. The four "settled"
  // values cover every legitimate payment outcome:
  //   paid           — collected
  //   waived         — within free-quota allowance
  //   posted_to_bill — settled via the contract's monthly invoice
  //   prepaid        — paid upfront via prepaid pack
  // Cancelled / no_show bookings can close regardless (the refund or
  // forfeiture decision is captured separately).
  const SETTLED = new Set(["paid", "waived", "posted_to_bill", "prepaid"]);
  if (booking.status === "checked_out" && !SETTLED.has(booking.payment_status)) {
    // Defence in depth — also check verified payments cover the total.
    const { data: payments } = await supabase
      .from("booking_payments")
      .select("amount")
      .eq("booking_id", id)
      .eq("status", "verified");
    const paidSoFar = (payments || []).reduce((s, p) => s + Number(p.amount), 0);
    const grandTotal = Number(booking.total_amount_with_gst || booking.total_amount);
    if (paidSoFar + 0.01 < grandTotal) {
      return NextResponse.json(
        { error: `Cannot close — ₹${(grandTotal - paidSoFar).toFixed(2)} still due` },
        { status: 400 }
      );
    }
  }

  const { data: updated, error: updateErr } = await supabase
    .from("bookings")
    .update({
      status: "closed",
      closed_at: new Date().toISOString(),
      closed_by: dbUser.id,
    })
    .eq("id", id)
    .select("*")
    .single();

  if (updateErr || !updated) {
    return NextResponse.json(
      { error: "Failed to close booking: " + (updateErr?.message ?? "unknown") },
      { status: 500 }
    );
  }

  logAudit(supabase, {
    entityType: "booking",
    entityId: id,
    action: "update",
    performedBy: dbUser.id,
    changes: {
      status: { old: booking.status, new: "closed" },
      closed_at: { old: null, new: updated.closed_at },
      skipped_steps: { old: null, new: skippedSteps },
      notes: { old: null, new: notes },
    },
  });

  return NextResponse.json({ data: updated });
}
