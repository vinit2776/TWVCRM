import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";

/**
 * DELETE /api/bookings/[id]/addons/[addonId]
 * Removes an add-on and recomputes the booking's total_amount_with_gst.
 */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; addonId: string }> }
) {
  const { id, addonId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 401 });

  const { data: booking } = await supabase
    .from("bookings")
    .select("id, total_amount, gst_amount, total_amount_with_gst, status, payment_status")
    .eq("id", id).single();
  if (!booking) return NextResponse.json({ error: "Booking not found" }, { status: 404 });

  // Same lock as the POST: removing a charge after the customer paid
  // would lower the booking total below what was collected, leaving an
  // unaccounted surplus.
  if (["cancelled", "checked_out", "no_show"].includes(booking.status)) {
    return NextResponse.json(
      { error: `Cannot remove charges from a ${booking.status} booking` },
      { status: 400 }
    );
  }
  if (booking.payment_status === "paid") {
    return NextResponse.json(
      { error: "Cannot remove charges — payment has already been collected. Issue a refund or waive separately." },
      { status: 400 }
    );
  }
  const { data: paidPayments } = await supabase
    .from("booking_payments")
    .select("id")
    .eq("booking_id", id)
    .eq("status", "verified")
    .limit(1);
  if (paidPayments && paidPayments.length > 0) {
    return NextResponse.json(
      { error: "Cannot remove charges — verified payments exist for this booking" },
      { status: 400 }
    );
  }

  const { data: addon } = await supabase
    .from("booking_addons").select("*").eq("id", addonId).eq("booking_id", id).single();
  if (!addon) return NextResponse.json({ error: "Add-on not found" }, { status: 404 });

  const { error } = await supabase
    .from("booking_addons").delete().eq("id", addonId).eq("booking_id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Recompute total
  const { data: remaining } = await supabase
    .from("booking_addons")
    .select("total_with_gst")
    .eq("booking_id", id);
  const sum = (remaining || []).reduce(
    (a: number, r: { total_with_gst: number }) => a + Number(r.total_with_gst), 0
  );
  await supabase.from("bookings").update({
    total_amount_with_gst: parseFloat(
      (Number(booking.total_amount) + Number(booking.gst_amount) + sum).toFixed(2)
    ),
  }).eq("id", id);

  logAudit(supabase, {
    entityType: "booking_addon", entityId: addonId, action: "delete",
    performedBy: dbUser.id, changes: { record: { old: addon, new: null } },
  });

  return NextResponse.json({ success: true });
}
