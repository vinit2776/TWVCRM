import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createFacilityUsageSchema } from "@/lib/validations";
import { logAudit } from "@/lib/audit";

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const accountingPeriodId = searchParams.get("accounting_period_id");
  const contractId = searchParams.get("contract_id");

  if (!accountingPeriodId || !contractId) {
    return NextResponse.json({ error: "accounting_period_id and contract_id are required" }, { status: 400 });
  }

  // Fetch existing usage records
  const { data: usageRecords, error } = await supabase
    .from("facility_usage_records")
    .select("*, contract_facility:contract_facilities!facility_usage_records_contract_facility_id_fkey(*)")
    .eq("accounting_period_id", accountingPeriodId)
    .eq("contract_id", contractId)
    .order("created_at", { ascending: true });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // If no records exist, check previous month for template auto-population
  if (!usageRecords || usageRecords.length === 0) {
    // Get the period to determine previous month
    const { data: period } = await supabase
      .from("accounting_periods")
      .select("year, month")
      .eq("id", accountingPeriodId)
      .single();

    if (period) {
      const prevMonth = period.month === 1 ? 12 : period.month - 1;
      const prevYear = period.month === 1 ? period.year - 1 : period.year;

      // Find previous period
      const { data: prevPeriod } = await supabase
        .from("accounting_periods")
        .select("id")
        .eq("year", prevYear)
        .eq("month", prevMonth)
        .single();

      if (prevPeriod) {
        // Fetch previous month's usage records as templates
        const { data: prevRecords } = await supabase
          .from("facility_usage_records")
          .select("*, contract_facility:contract_facilities!facility_usage_records_contract_facility_id_fkey(*)")
          .eq("accounting_period_id", prevPeriod.id)
          .eq("contract_id", contractId);

        if (prevRecords && prevRecords.length > 0) {
          // Return as templates (not saved yet) with quantity_used = 0
          const templates = prevRecords
            .filter((r) => r.contract_facility?.is_active)
            .map((r) => ({
              ...r,
              id: `template-${r.contract_facility_id}`,
              accounting_period_id: accountingPeriodId,
              quantity_used: 0,
              free_quota_applied: 0,
              billable_quantity: 0,
              total_charge: 0,
              is_template: true,
            }));
          return NextResponse.json({ data: templates });
        }
      }
    }
  }

  return NextResponse.json({ data: usageRecords || [] });
}

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();
  const result = createFacilityUsageSchema.safeParse(body);
  if (!result.success) {
    return NextResponse.json({ error: "Validation failed", details: result.error.issues }, { status: 400 });
  }

  // Check if period is locked
  const { data: period } = await supabase
    .from("accounting_periods")
    .select("status")
    .eq("id", result.data.accounting_period_id)
    .single();

  if (period?.status === "locked") {
    return NextResponse.json({ error: "Cannot modify usage records in a locked period" }, { status: 403 });
  }

  // Fetch the facility to get free_quota and cost_per_unit
  const { data: facility, error: facilityError } = await supabase
    .from("contract_facilities")
    .select("free_quota, cost_per_unit")
    .eq("id", result.data.contract_facility_id)
    .single();

  if (facilityError || !facility) {
    return NextResponse.json({ error: "Facility not found" }, { status: 404 });
  }

  // Compute free quota logic
  const quantityUsed = result.data.quantity_used;
  const freeQuotaApplied = Math.min(quantityUsed, facility.free_quota);
  const billableQuantity = Math.max(0, quantityUsed - freeQuotaApplied);
  const unitPrice = facility.cost_per_unit;
  const totalCharge = billableQuantity * unitPrice;

  const { data: dbUser } = await supabase.from("users").select("id").eq("auth_id", user.id).single();

  // Upsert: insert or update if unique constraint hit
  const { data: existing } = await supabase
    .from("facility_usage_records")
    .select("id")
    .eq("accounting_period_id", result.data.accounting_period_id)
    .eq("contract_id", result.data.contract_id)
    .eq("contract_facility_id", result.data.contract_facility_id)
    .single();

  if (existing) {
    // Update existing
    const { data: updated, error: updateError } = await supabase
      .from("facility_usage_records")
      .update({
        quantity_used: quantityUsed,
        free_quota_applied: freeQuotaApplied,
        billable_quantity: billableQuantity,
        unit_price: unitPrice,
        total_charge: totalCharge,
        notes: result.data.notes,
      })
      .eq("id", existing.id)
      .select("*, contract_facility:contract_facilities!facility_usage_records_contract_facility_id_fkey(*)")
      .single();

    if (updateError) return NextResponse.json({ error: updateError.message }, { status: 500 });

    if (dbUser?.id) {
      logAudit(supabase, {
        entityType: "facility_usage_record",
        entityId: existing.id,
        action: "update",
        performedBy: dbUser.id,
        changes: { quantity_used: { old: null, new: quantityUsed } },
      });
    }

    return NextResponse.json({ data: updated });
  }

  // Insert new
  const { data: record, error: insertError } = await supabase
    .from("facility_usage_records")
    .insert({
      accounting_period_id: result.data.accounting_period_id,
      contract_id: result.data.contract_id,
      contract_facility_id: result.data.contract_facility_id,
      quantity_used: quantityUsed,
      free_quota_applied: freeQuotaApplied,
      billable_quantity: billableQuantity,
      unit_price: unitPrice,
      total_charge: totalCharge,
      notes: result.data.notes,
      created_by: dbUser?.id,
    })
    .select("*, contract_facility:contract_facilities!facility_usage_records_contract_facility_id_fkey(*)")
    .single();

  if (insertError) return NextResponse.json({ error: insertError.message }, { status: 500 });

  if (record && dbUser?.id) {
    logAudit(supabase, {
      entityType: "facility_usage_record",
      entityId: record.id,
      action: "create",
      performedBy: dbUser.id,
      changes: { record: { old: null, new: record } },
    });
  }

  return NextResponse.json({ data: record }, { status: 201 });
}
