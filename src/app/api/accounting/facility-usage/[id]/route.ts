import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { CHARGE_HOLD_ALLOWED_ROLES } from "@/lib/constants";

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Fetch record + check period lock
  const { data: record, error: fetchError } = await supabase
    .from("facility_usage_records")
    .select("*, accounting_period:accounting_periods!facility_usage_records_accounting_period_id_fkey(status)")
    .eq("id", id)
    .single();

  if (fetchError || !record) {
    return NextResponse.json({ error: "Usage record not found" }, { status: 404 });
  }

  if (record.accounting_period?.status === "locked") {
    return NextResponse.json({ error: "Cannot modify usage records in a locked period" }, { status: 403 });
  }

  const body = await request.json();

  // Waive — the only mutation a "stuck" facility overage needs when its
  // covering statement already went out and no future billing sweep will
  // ever revisit it. See 00559_service_facility_charge_waive.sql.
  if (body.waive === true) {
    if (record.waived_at) return NextResponse.json({ error: "Already waived" }, { status: 400 });
    const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
    if (!dbUser || !["admin", "manager"].includes(dbUser.role)) {
      return NextResponse.json({ error: "Only admin and managers can waive charges" }, { status: 403 });
    }
    const waiveReason = (body.waive_reason as string | undefined)?.trim();
    if (!waiveReason) return NextResponse.json({ error: "A reason is required when waiving a charge" }, { status: 400 });

    const { data: updated, error: updateError } = await supabase
      .from("facility_usage_records")
      .update({ waived_at: new Date().toISOString(), waived_by: dbUser.id, waive_reason: waiveReason })
      .eq("id", id)
      .select("*, contract_facility:contract_facilities!facility_usage_records_contract_facility_id_fkey(*)")
      .single();
    if (updateError) return NextResponse.json({ error: updateError.message }, { status: 500 });

    logAudit(supabase, {
      entityType: "facility_usage_record",
      entityId: id,
      action: "update",
      performedBy: dbUser.id,
      changes: { waived_at: { old: null, new: updated.waived_at }, waive_reason: { old: null, new: waiveReason } },
    });

    return NextResponse.json({ data: updated });
  }

  // Partial waiver — override the billed amount directly rather than
  // recomputing from quantity (that's the default path below). Same "why"
  // accountability as usage_charges'/print's reduce path.
  if (body.total_charge !== undefined && Number(body.total_charge) < Number(record.total_charge ?? 0)) {
    if (Number(body.total_charge) < 0) return NextResponse.json({ error: "Amount cannot be negative" }, { status: 400 });
    const reductionReason = (body.reduction_reason as string | undefined)?.trim();
    if (!reductionReason) return NextResponse.json({ error: "A reason is required when reducing a charge's amount" }, { status: 400 });
    const { data: dbUser } = await supabase.from("users").select("id").eq("auth_id", user.id).single();
    const newTotal = Number(body.total_charge);
    const noteLine = `Reduced from ₹${record.total_charge} to ₹${newTotal} — ${reductionReason}`;

    const { data: updated, error: updateError } = await supabase
      .from("facility_usage_records")
      .update({ total_charge: newTotal, notes: record.notes ? `${record.notes}\n${noteLine}` : noteLine })
      .eq("id", id)
      .select("*, contract_facility:contract_facilities!facility_usage_records_contract_facility_id_fkey(*)")
      .single();
    if (updateError) return NextResponse.json({ error: updateError.message }, { status: 500 });

    if (dbUser?.id) {
      logAudit(supabase, {
        entityType: "facility_usage_record", entityId: id, action: "update", performedBy: dbUser.id,
        changes: { total_charge: { old: record.total_charge, new: newTotal } },
      });
    }
    return NextResponse.json({ data: updated });
  }

  // Hold / release — pauses (or resumes) this row's eligibility for the
  // next Generate & Send sweep. See 00563_usage_billing_engine.sql.
  if (body.hold === true || body.hold === false) {
    const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
    if (!dbUser || !CHARGE_HOLD_ALLOWED_ROLES.includes(dbUser.role)) {
      return NextResponse.json({ error: `Only admin and managers can ${body.hold ? "hold" : "release"} charges` }, { status: 403 });
    }
    let allowedFields: Record<string, unknown>;
    if (body.hold === true) {
      if (record.held_at) return NextResponse.json({ error: "Already on hold" }, { status: 400 });
      const holdReason = (body.hold_reason as string | undefined)?.trim();
      if (!holdReason) return NextResponse.json({ error: "A reason is required when placing a hold" }, { status: 400 });
      allowedFields = { held_at: new Date().toISOString(), held_by: dbUser.id, hold_reason: holdReason };
    } else {
      allowedFields = { held_at: null, held_by: null, hold_reason: null };
    }
    const { data: updated, error: updateError } = await supabase
      .from("facility_usage_records")
      .update(allowedFields)
      .eq("id", id)
      .select("*, contract_facility:contract_facilities!facility_usage_records_contract_facility_id_fkey(*)")
      .single();
    if (updateError) return NextResponse.json({ error: updateError.message }, { status: 500 });

    logAudit(supabase, {
      entityType: "facility_usage_record", entityId: id, action: "update", performedBy: dbUser.id,
      changes: Object.fromEntries(Object.entries(allowedFields).map(([k, v]) => [k, { old: null, new: v }])),
    });
    return NextResponse.json({ data: updated });
  }

  // "Bill anyway" for a stale row (see USAGE_CHARGE_REVIEW_REQUIRED_AFTER_DAYS).
  if (body.review === true) {
    const { data: dbUser } = await supabase.from("users").select("id").eq("auth_id", user.id).single();
    const { data: updated, error: updateError } = await supabase
      .from("facility_usage_records")
      .update({ reviewed_at: new Date().toISOString(), reviewed_by: dbUser?.id ?? null })
      .eq("id", id)
      .select("*, contract_facility:contract_facilities!facility_usage_records_contract_facility_id_fkey(*)")
      .single();
    if (updateError) return NextResponse.json({ error: updateError.message }, { status: 500 });
    return NextResponse.json({ data: updated });
  }

  const quantityUsed = body.quantity_used;

  if (quantityUsed === undefined || quantityUsed < 0) {
    return NextResponse.json({ error: "quantity_used must be non-negative" }, { status: 400 });
  }

  // Fetch facility for recalculation
  const { data: facility } = await supabase
    .from("contract_facilities")
    .select("free_quota, cost_per_unit")
    .eq("id", record.contract_facility_id)
    .single();

  if (!facility) {
    return NextResponse.json({ error: "Facility not found" }, { status: 404 });
  }

  const freeQuotaApplied = Math.min(quantityUsed, facility.free_quota);
  const billableQuantity = Math.max(0, quantityUsed - freeQuotaApplied);
  const unitPrice = facility.cost_per_unit;
  const totalCharge = billableQuantity * unitPrice;

  const { data: dbUser } = await supabase.from("users").select("id").eq("auth_id", user.id).single();

  const { data: updated, error: updateError } = await supabase
    .from("facility_usage_records")
    .update({
      quantity_used: quantityUsed,
      free_quota_applied: freeQuotaApplied,
      billable_quantity: billableQuantity,
      unit_price: unitPrice,
      total_charge: totalCharge,
      notes: body.notes !== undefined ? body.notes : record.notes,
    })
    .eq("id", id)
    .select("*, contract_facility:contract_facilities!facility_usage_records_contract_facility_id_fkey(*)")
    .single();

  if (updateError) return NextResponse.json({ error: updateError.message }, { status: 500 });

  if (dbUser?.id) {
    logAudit(supabase, {
      entityType: "facility_usage_record",
      entityId: id,
      action: "update",
      performedBy: dbUser.id,
      changes: { quantity_used: { old: record.quantity_used, new: quantityUsed } },
    });
  }

  return NextResponse.json({ data: updated });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Fetch record + check period lock
  const { data: record, error: fetchError } = await supabase
    .from("facility_usage_records")
    .select("*, accounting_period:accounting_periods!facility_usage_records_accounting_period_id_fkey(status)")
    .eq("id", id)
    .single();

  if (fetchError || !record) {
    return NextResponse.json({ error: "Usage record not found" }, { status: 404 });
  }

  if (record.accounting_period?.status === "locked") {
    return NextResponse.json({ error: "Cannot delete usage records in a locked period" }, { status: 403 });
  }

  const { data: dbUser } = await supabase.from("users").select("id").eq("auth_id", user.id).single();

  const { error: deleteError } = await supabase
    .from("facility_usage_records")
    .delete()
    .eq("id", id);

  if (deleteError) return NextResponse.json({ error: deleteError.message }, { status: 500 });

  if (dbUser?.id) {
    logAudit(supabase, {
      entityType: "facility_usage_record",
      entityId: id,
      action: "delete",
      performedBy: dbUser.id,
    });
  }

  return NextResponse.json({ message: "Usage record deleted" });
}
