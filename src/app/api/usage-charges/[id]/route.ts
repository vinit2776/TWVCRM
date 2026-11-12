import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit, diffChanges } from "@/lib/audit";
import { CHARGE_ALLOWED_ROLES, CHARGE_HOLD_ALLOWED_ROLES } from "@/lib/constants";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data, error } = await supabase
    .from("usage_charges")
    .select(
      "*, contract:contracts!usage_charges_contract_id_fkey(id, contract_number), lead:leads!usage_charges_lead_id_fkey(id, first_name, last_name, company)"
    )
    .eq("id", id)
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: "Usage charge not found" }, { status: 404 });

  return NextResponse.json({ data });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Fetch old charge for diff and status check
  const { data: oldCharge } = await supabase
    .from("usage_charges")
    .select("*")
    .eq("id", id)
    .single();

  if (!oldCharge) return NextResponse.json({ error: "Usage charge not found" }, { status: 404 });
  if (oldCharge.status !== "pending") {
    return NextResponse.json({ error: "Only pending charges can be updated" }, { status: 400 });
  }

  const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();

  if (!dbUser || !CHARGE_ALLOWED_ROLES.includes(dbUser.role)) {
    return NextResponse.json(
      { error: "You do not have permission to edit usage charges" },
      { status: 403 }
    );
  }

  const body = await request.json();
  const allowedFields: Record<string, unknown> = {};

  if (body.description !== undefined) allowedFields.description = body.description;
  if (body.quantity !== undefined) allowedFields.quantity = body.quantity;
  if (body.unit_price !== undefined) allowedFields.unit_price = body.unit_price;
  if (body.total !== undefined) allowedFields.total = body.total;
  if (body.gst_rate !== undefined) allowedFields.gst_rate = body.gst_rate;
  if (body.charge_date !== undefined) allowedFields.charge_date = body.charge_date;
  if (body.notes !== undefined) allowedFields.notes = body.notes;
  if (body.proof_path !== undefined) allowedFields.proof_path = body.proof_path;

  // Recompute the GST + grand total whenever total or gst_rate moves.
  // Server is the source of truth — clients can't drift these out of sync.
  if (allowedFields.total !== undefined || allowedFields.gst_rate !== undefined) {
    const newTotal = Number(allowedFields.total ?? oldCharge.total);
    const newGstRate = Number(allowedFields.gst_rate ?? oldCharge.gst_rate ?? 0);
    const newGstAmount = parseFloat((newTotal * newGstRate / 100).toFixed(2));
    allowedFields.gst_amount = newGstAmount;
    allowedFields.total_with_gst = parseFloat((newTotal + newGstAmount).toFixed(2));
  }

  // Partial waiver: a pending charge's amount reduced (not zeroed — that's
  // the full-waive path above) rather than left at its original value.
  // Needs the same "why" accountability as a full waive, so it's required
  // and recorded both in notes (visible on the row) and the audit trail —
  // there's no dedicated reduced_reason column, keeping this change free of
  // a new migration.
  let reductionReason: string | undefined;
  if (allowedFields.total !== undefined && Number(allowedFields.total) < Number(oldCharge.total ?? 0)) {
    reductionReason = (body.reduction_reason as string | undefined)?.trim();
    if (!reductionReason) {
      return NextResponse.json({ error: "A reason is required when reducing a charge's amount" }, { status: 400 });
    }
    const noteLine = `Reduced from ₹${oldCharge.total} to ₹${allowedFields.total} — ${reductionReason}`;
    const existingNotes = allowedFields.notes !== undefined ? String(allowedFields.notes) : (oldCharge.notes ?? "");
    allowedFields.notes = existingNotes ? `${existingNotes}\n${noteLine}` : noteLine;
  }

  // Waive: only admin/manager can waive
  if (body.status === "waived") {
    if (!dbUser || !["admin", "manager"].includes(dbUser.role)) {
      return NextResponse.json({ error: "Only admin and managers can waive charges" }, { status: 403 });
    }
    allowedFields.status = "waived";
    allowedFields.waived_by = dbUser.id;
    allowedFields.waived_at = new Date().toISOString();
    allowedFields.waive_reason = body.waive_reason || null;
    // Snapshot the amounts before zeroing so a breakdown can still show
    // "₹X — waived by Y" (the zeroing below is otherwise lossy).
    allowedFields.original_unit_price     = Number(oldCharge.unit_price ?? 0);
    allowedFields.original_total          = Number(oldCharge.total ?? 0);
    allowedFields.original_gst_amount     = Number(oldCharge.gst_amount ?? 0);
    allowedFields.original_total_with_gst = Number(oldCharge.total_with_gst ?? 0);
    // Every other writer of status:"waived" in this codebase (free-quota
    // bookings, free-quota facility charges, cancelled-booking waivers)
    // zeroes the amount fields — displays like the Billing page's Usage
    // Charges table read `total` directly without checking status, so a
    // non-zero total on a "waived" row reads as still being charged.
    allowedFields.unit_price = 0;
    allowedFields.total = 0;
    allowedFields.gst_amount = 0;
    allowedFields.total_with_gst = 0;
  } else if (body.status !== undefined) {
    allowedFields.status = body.status;
  }

  // Hold / release: pauses (or resumes) just this charge's eligibility for
  // the next Generate Drafts sweep — status stays "pending" throughout,
  // unlike waive above. See usage_charges.held_at's own doc comment
  // (00558_usage_charge_hold.sql) for how this differs from waiving.
  if (body.hold === true) {
    if (!dbUser || !CHARGE_HOLD_ALLOWED_ROLES.includes(dbUser.role)) {
      return NextResponse.json({ error: "Only admin and managers can hold charges" }, { status: 403 });
    }
    const holdReason = (body.hold_reason as string | undefined)?.trim();
    if (!holdReason) {
      return NextResponse.json({ error: "A reason is required when placing a hold" }, { status: 400 });
    }
    allowedFields.held_at = new Date().toISOString();
    allowedFields.held_by = dbUser.id;
    allowedFields.hold_reason = holdReason;
  } else if (body.hold === false) {
    if (!dbUser || !CHARGE_HOLD_ALLOWED_ROLES.includes(dbUser.role)) {
      return NextResponse.json({ error: "Only admin and managers can release a hold" }, { status: 403 });
    }
    allowedFields.held_at = null;
    allowedFields.held_by = null;
    allowedFields.hold_reason = null;
  }

  // "Bill anyway" — a stale charge (see USAGE_CHARGE_REVIEW_REQUIRED_AFTER_DAYS
  // in src/lib/constants.ts) is excluded from generateUsageStatements'
  // automatic sweep until someone explicitly acknowledges it should still be
  // charged. Any role that can edit charges may do this — it's a lighter
  // action than Hold/Waive, just "yes, I looked at this."
  if (body.review === true) {
    allowedFields.reviewed_at = new Date().toISOString();
    allowedFields.reviewed_by = dbUser?.id ?? null;
  }

  // Settle: mark as settled in a booking
  if (body.settled_in_booking_id) {
    allowedFields.settled_in_booking_id = body.settled_in_booking_id;
    allowedFields.settled_at = new Date().toISOString();
    allowedFields.status = "billed";
  }

  if (Object.keys(allowedFields).length === 0) {
    return NextResponse.json({ error: "No valid fields" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("usage_charges")
    .update(allowedFields)
    .eq("id", id)
    .select("*")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  if (dbUser?.id && oldCharge) {
    const changes = diffChanges(oldCharge as Record<string, unknown>, allowedFields);
    if (reductionReason) changes.reduction_reason = { old: null, new: reductionReason };
    logAudit(supabase, {
      entityType: "usage_charge",
      entityId: id,
      action: "update",
      performedBy: dbUser.id,
      changes,
    });
  }

  return NextResponse.json({ data });
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Only allow deletion if status is pending
  const { data: charge } = await supabase
    .from("usage_charges")
    .select("*")
    .eq("id", id)
    .single();

  if (!charge) return NextResponse.json({ error: "Usage charge not found" }, { status: 404 });
  if (charge.status !== "pending") {
    return NextResponse.json({ error: "Only pending charges can be deleted" }, { status: 400 });
  }

  const { error } = await supabase
    .from("usage_charges")
    .delete()
    .eq("id", id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const { data: dbUser } = await supabase.from("users").select("id").eq("auth_id", user.id).single();
  if (dbUser?.id) {
    logAudit(supabase, {
      entityType: "usage_charge",
      entityId: id,
      action: "delete",
      performedBy: dbUser.id,
      changes: { record: { old: charge, new: null } },
    });
  }

  return NextResponse.json({ message: "Usage charge deleted" });
}
