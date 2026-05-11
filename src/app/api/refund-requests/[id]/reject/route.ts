/**
 * PATCH /api/refund-requests/[id]/reject
 *
 * Manager / admin rejects a refund request. Requires a rejected_reason
 * — staff who submitted it (and the customer they need to relay the
 * decision to) deserve an explanation.
 *
 * On reject: the booking's gst_invoice_required is set TRUE because
 * the payment is now retained — finance will need to issue a GST
 * invoice for the kept amount.
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";

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
  if (!dbUser || !["admin", "manager"].includes(dbUser.role)) {
    return NextResponse.json(
      { error: "Manager / admin access required to reject refunds" },
      { status: 403 }
    );
  }

  const body = await request.json();
  const reason = (body.rejected_reason as string | undefined)?.trim();
  if (!reason) {
    return NextResponse.json({ error: "rejected_reason is required" }, { status: 400 });
  }

  const { data: rr } = await supabase
    .from("refund_requests").select("*").eq("id", id).single();
  if (!rr) return NextResponse.json({ error: "Refund request not found" }, { status: 404 });

  if (rr.status !== "pending_approval" && rr.status !== "approved") {
    return NextResponse.json(
      { error: `Cannot reject a ${rr.status} request` },
      { status: 400 }
    );
  }

  // Atomic-ish: reject the request + flip the booking's gst_invoice_required
  // flag so finance picks up that the payment is retained and needs an invoice.
  const { data: updated, error } = await supabase
    .from("refund_requests")
    .update({
      status: "rejected",
      rejected_reason: reason,
      rejected_by: dbUser.id,
      rejected_at: new Date().toISOString(),
    })
    .eq("id", id)
    .select("*")
    .single();
  if (error || !updated) {
    return NextResponse.json({ error: error?.message ?? "Update failed" }, { status: 500 });
  }

  await supabase
    .from("bookings")
    .update({ gst_invoice_required: true })
    .eq("id", rr.booking_id);

  logAudit(supabase, {
    entityType: "refund_request",
    entityId: id,
    action: "update",
    performedBy: dbUser.id,
    changes: {
      status: { old: rr.status, new: "rejected" },
      rejected_reason: { old: null, new: reason },
    },
  });
  logAudit(supabase, {
    entityType: "booking",
    entityId: rr.booking_id,
    action: "update",
    performedBy: dbUser.id,
    changes: {
      gst_invoice_required: { old: false, new: true },
      reason: { old: null, new: `Refund request rejected (#${id})` },
    },
  });

  return NextResponse.json({ data: updated });
}
