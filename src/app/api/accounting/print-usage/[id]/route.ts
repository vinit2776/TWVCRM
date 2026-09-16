import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { CHARGE_HOLD_ALLOWED_ROLES } from "@/lib/constants";

/**
 * PATCH /api/accounting/print-usage/[id]
 *
 * Mutations on a single service_usage_records row (print/service overage) —
 * the actions a print charge previously had no way to reach except through
 * the ordinary monthly billing sweep. A row whose covering statement already
 * went out ("supplemental needed") is never revisited by that sweep and had
 * no other exit. See 00559_service_facility_charge_waive.sql and
 * 00563_usage_billing_engine.sql.
 *
 * Body (exactly one of):
 *   { waive: true, waive_reason }              — full waive
 *   { amount, reduction_reason }                — partial waive (reduce)
 *   { hold: true, hold_reason } / { hold: false } — hold / release
 *   { review: true }                            — "Bill anyway" for a stale row
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: record, error: fetchError } = await supabase
    .from("service_usage_records")
    .select("id, is_billed, waived_at, held_at, overage_quantity, amount, gst_rate, notes")
    .eq("id", id)
    .single();
  if (fetchError || !record) return NextResponse.json({ error: "Usage record not found" }, { status: 404 });
  if (record.is_billed) return NextResponse.json({ error: "Already billed — cannot be modified" }, { status: 400 });
  if (record.waived_at) return NextResponse.json({ error: "Already waived" }, { status: 400 });

  const body = await request.json().catch(() => ({}));
  const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  const allowedFields: Record<string, unknown> = {};

  if (body.waive === true) {
    if (!dbUser || !["admin", "manager"].includes(dbUser.role)) {
      return NextResponse.json({ error: "Only admin and managers can waive charges" }, { status: 403 });
    }
    const waiveReason = (body.waive_reason as string | undefined)?.trim();
    if (!waiveReason) return NextResponse.json({ error: "A reason is required when waiving a charge" }, { status: 400 });
    allowedFields.waived_at = new Date().toISOString();
    allowedFields.waived_by = dbUser.id;
    allowedFields.waive_reason = waiveReason;
  } else if (body.amount !== undefined && Number(body.amount) < Number(record.amount ?? 0)) {
    // Partial waiver — same "why" accountability as usage_charges' reduce
    // path: required, recorded in notes (no dedicated column, no new migration).
    if (Number(body.amount) < 0) return NextResponse.json({ error: "Amount cannot be negative" }, { status: 400 });
    const reductionReason = (body.reduction_reason as string | undefined)?.trim();
    if (!reductionReason) return NextResponse.json({ error: "A reason is required when reducing a charge's amount" }, { status: 400 });
    const newAmount = Number(body.amount);
    const gstRate = Number(record.gst_rate ?? 0);
    const gstAmount = parseFloat((newAmount * gstRate / 100).toFixed(2));
    allowedFields.amount = newAmount;
    allowedFields.gst_amount = gstAmount;
    allowedFields.total_with_gst = parseFloat((newAmount + gstAmount).toFixed(2));
    const noteLine = `Reduced from ₹${record.amount} to ₹${newAmount} — ${reductionReason}`;
    allowedFields.notes = record.notes ? `${record.notes}\n${noteLine}` : noteLine;
  } else if (body.hold === true) {
    if (!dbUser || !CHARGE_HOLD_ALLOWED_ROLES.includes(dbUser.role)) {
      return NextResponse.json({ error: "Only admin and managers can hold charges" }, { status: 403 });
    }
    if (record.held_at) return NextResponse.json({ error: "Already on hold" }, { status: 400 });
    const holdReason = (body.hold_reason as string | undefined)?.trim();
    if (!holdReason) return NextResponse.json({ error: "A reason is required when placing a hold" }, { status: 400 });
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
  } else if (body.review === true) {
    allowedFields.reviewed_at = new Date().toISOString();
    allowedFields.reviewed_by = dbUser?.id ?? null;
  } else {
    return NextResponse.json({ error: "No valid fields" }, { status: 400 });
  }

  const { data: updated, error: updateError } = await supabase
    .from("service_usage_records")
    .update(allowedFields)
    .eq("id", id)
    .select()
    .single();
  if (updateError) return NextResponse.json({ error: updateError.message }, { status: 500 });

  if (dbUser?.id) {
    logAudit(supabase, {
      entityType: "service_usage_record",
      entityId: id,
      action: "update",
      performedBy: dbUser.id,
      changes: Object.fromEntries(Object.entries(allowedFields).map(([k, v]) => [k, { old: null, new: v }])),
    });
  }

  return NextResponse.json({ data: updated });
}
