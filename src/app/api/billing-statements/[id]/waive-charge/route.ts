import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { computeGstAndRounding } from "@/lib/gst-math";

export const maxDuration = 30;

/**
 * POST /api/billing-statements/[id]/waive-charge
 *
 * Waive or un-waive a single charge on a DRAFT billing statement — any of
 * the three sources (manual usage_charges, print/service_usage_records,
 * facility_usage_records), not just manual. Print/facility waiving used to
 * be impossible from within a generated draft (they had no waived_at column
 * until the usage-billing-engine PR, and this endpoint only ever touched
 * usage_charges) — that's why UsageCurrentCycleCard rendered them read-only
 * even though its own guide text already promised "waive anything." This
 * closes that gap.
 *
 * Body:
 *   { charge_id: string, source?: "manual" | "print" | "facility", waive: boolean, reason?: string }
 *
 * Requires: admin or manager role.
 * Statement must be in "draft" status.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: statementId } = await params;
  const supabase = await createClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users")
    .select("id, role, full_name")
    .eq("auth_id", user.id)
    .single();

  if (!dbUser || !["admin", "manager"].includes(dbUser.role)) {
    return NextResponse.json(
      { error: "Only admin or manager can waive usage charges" },
      { status: 403 }
    );
  }

  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  const { charge_id, waive, reason } = body as { charge_id?: string; waive?: boolean; reason?: string };
  const source = (body.source as string | undefined) ?? "manual";

  if (!charge_id) return NextResponse.json({ error: "charge_id is required" }, { status: 400 });
  if (typeof waive !== "boolean") return NextResponse.json({ error: "waive must be a boolean" }, { status: 400 });
  if (waive && (!reason || !reason.trim())) {
    return NextResponse.json({ error: "A reason is required when waiving a charge" }, { status: 400 });
  }
  if (!["manual", "print", "facility"].includes(source)) {
    return NextResponse.json({ error: "source must be manual, print, or facility" }, { status: 400 });
  }

  const { data: statement } = await supabase
    .from("billing_statements")
    .select("id, status, fixed_amount, booking_usage_amount, tax_percentage")
    .eq("id", statementId)
    .single();

  if (!statement) return NextResponse.json({ error: "Billing statement not found" }, { status: 404 });
  if (statement.status !== "draft") {
    return NextResponse.json({ error: "Charges can only be waived on draft statements" }, { status: 400 });
  }

  const table = source === "manual" ? "usage_charges" : source === "print" ? "service_usage_records" : "facility_usage_records";
  const amountField = source === "manual" ? "total" : source === "print" ? "amount" : "total_charge";

  const { data: charge } = await supabase
    .from(table)
    .select(`id, ${amountField}, waive_reason` + (source === "manual" ? ", is_waived" : ", waived_at"))
    .eq("id", charge_id)
    .eq("billing_statement_id", statementId)
    .single();

  if (!charge) return NextResponse.json({ error: "Charge not found on this statement" }, { status: 404 });

  const wasWaived = source === "manual" ? !!(charge as { is_waived?: boolean }).is_waived : !!(charge as { waived_at?: string | null }).waived_at;

  const waiveUpdate = source === "manual"
    ? (waive
        ? { is_waived: true, waived_by: dbUser.id, waived_at: new Date().toISOString(), waive_reason: reason!.trim() }
        : { is_waived: false, waived_by: null, waived_at: null, waive_reason: null })
    : (waive
        ? { waived_by: dbUser.id, waived_at: new Date().toISOString(), waive_reason: reason!.trim() }
        : { waived_by: null, waived_at: null, waive_reason: null });

  const { error: chargeErr } = await supabase.from(table).update(waiveUpdate).eq("id", charge_id);
  if (chargeErr) return NextResponse.json({ error: chargeErr.message }, { status: 500 });

  // Recalculate statement totals from every still-linked, non-waived row —
  // usage_amount blends manual + facility (see generateUsageStatements'
  // `usage_amount: adHocSubtotal + facilitySubtotal`), service_usage_amount
  // is print/service alone.
  const [manualRes, facilityRes, serviceRes] = await Promise.all([
    supabase.from("usage_charges").select("total").eq("billing_statement_id", statementId).eq("is_waived", false),
    supabase.from("facility_usage_records").select("total_charge").eq("billing_statement_id", statementId).is("waived_at", null),
    supabase.from("service_usage_records").select("amount").eq("billing_statement_id", statementId).is("waived_at", null),
  ]);
  if (manualRes.error) return NextResponse.json({ error: manualRes.error.message }, { status: 500 });
  if (facilityRes.error) return NextResponse.json({ error: facilityRes.error.message }, { status: 500 });
  if (serviceRes.error) return NextResponse.json({ error: serviceRes.error.message }, { status: 500 });

  const manualTotal = (manualRes.data ?? []).reduce((s, c) => s + Number(c.total || 0), 0);
  const facilityTotal = (facilityRes.data ?? []).reduce((s, f) => s + Number(f.total_charge || 0), 0);
  const usageAmount = manualTotal + facilityTotal;
  const serviceUsageAmount = (serviceRes.data ?? []).reduce((s, r) => s + Number(r.amount || 0), 0);

  const fixedAmount = Number(statement.fixed_amount || 0);
  const bookingUsageAmount = Number(statement.booking_usage_amount || 0);
  const subtotal = fixedAmount + usageAmount + serviceUsageAmount + bookingUsageAmount;
  const taxPercentage = Number(statement.tax_percentage || 0);
  const { cgst, sgst, igst, taxAmount, totalAmount } = computeGstAndRounding(subtotal, taxPercentage);

  const { data: updated, error: updateErr } = await supabase
    .from("billing_statements")
    .update({
      usage_amount: usageAmount,
      service_usage_amount: serviceUsageAmount,
      subtotal,
      tax_amount: taxAmount,
      total_amount: totalAmount,
      cgst_amount: cgst,
      sgst_amount: sgst,
      igst_amount: igst,
    })
    .eq("id", statementId)
    .select("*")
    .single();

  if (updateErr) return NextResponse.json({ error: updateErr.message }, { status: 500 });

  logAudit(supabase, {
    entityType: "billing_statement",
    entityId: statementId,
    action: "update",
    performedBy: dbUser.id,
    changes: {
      waiver: {
        old: { charge_id, source, waived: wasWaived },
        new: { charge_id, source, waived: waive, reason: waive ? reason : null, by: dbUser.full_name },
      },
      total_amount: { old: null, new: totalAmount },
    },
  });

  return NextResponse.json({ data: updated });
}
