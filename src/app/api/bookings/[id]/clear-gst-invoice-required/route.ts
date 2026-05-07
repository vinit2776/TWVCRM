/**
 * PATCH /api/bookings/[id]/clear-gst-invoice-required
 *
 * Finance ticks this off after issuing a GST invoice for the
 * retained payment on a cancelled booking. Sets
 * gst_invoice_required = false so the row drops out of the finance
 * "needs invoice" queue.
 *
 * Authorisation: admin / manager / accounts.
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";

const FINANCE_ROLES = new Set(["admin", "manager", "accounts"]);

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser || !FINANCE_ROLES.has(dbUser.role)) {
    return NextResponse.json(
      { error: "Admin / manager / accounts access required" },
      { status: 403 }
    );
  }

  const body = await request.json().catch(() => ({}));
  const invoiceNumber = (body.invoice_number as string | undefined)?.trim() || null;

  const { data: booking } = await supabase
    .from("bookings")
    .select("id, status, gst_invoice_required")
    .eq("id", id)
    .single();
  if (!booking) return NextResponse.json({ error: "Booking not found" }, { status: 404 });
  if (!booking.gst_invoice_required) {
    return NextResponse.json({ error: "Booking is not flagged for GST invoice" }, { status: 400 });
  }

  const { data: updated, error } = await supabase
    .from("bookings")
    .update({ gst_invoice_required: false })
    .eq("id", id)
    .select("*")
    .single();
  if (error || !updated) {
    return NextResponse.json({ error: error?.message ?? "Update failed" }, { status: 500 });
  }

  logAudit(supabase, {
    entityType: "booking",
    entityId: id,
    action: "update",
    performedBy: dbUser.id,
    changes: {
      gst_invoice_required: { old: true, new: false },
      reason: { old: null, new: invoiceNumber ? `GST invoice issued (${invoiceNumber})` : "GST invoice issued" },
    },
  });

  return NextResponse.json({ data: updated });
}
