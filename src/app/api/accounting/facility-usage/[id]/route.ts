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
