import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { computeGstAndRounding } from "@/lib/gst-math";

export const maxDuration = 30;

/**
 * POST /api/billing-statements/[id]/waive-charge
 *
 * Waive or un-waive a single usage charge on a DRAFT billing statement.
 * Recalculates statement totals (usage_amount, subtotal, tax_amount, total_amount)
 * after the change.
 *
 * Body:
 *   { charge_id: string, waive: boolean, reason?: string }
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

  // Auth + role check
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

  if (!charge_id) {
    return NextResponse.json({ error: "charge_id is required" }, { status: 400 });
  }
  if (typeof waive !== "boolean") {
    return NextResponse.json({ error: "waive must be a boolean" }, { status: 400 });
  }
  if (waive && (!reason || !reason.trim())) {
    return NextResponse.json({ error: "A reason is required when waiving a charge" }, { status: 400 });
  }

  // Verify statement exists and is in draft
  const { data: statement } = await supabase
    .from("billing_statements")
    .select("id, status, fixed_amount, service_usage_amount, booking_usage_amount, tax_percentage")
    .eq("id", statementId)
    .single();

  if (!statement) {
    return NextResponse.json({ error: "Billing statement not found" }, { status: 404 });
  }
  if (statement.status !== "draft") {
    return NextResponse.json(
      { error: "Charges can only be waived on draft statements" },
      { status: 400 }
    );
  }

  // Verify the charge belongs to this statement
  const { data: charge } = await supabase
    .from("usage_charges")
    .select("id, total, is_waived, description")
    .eq("id", charge_id)
    .eq("billing_statement_id", statementId)
    .single();

  if (!charge) {
    return NextResponse.json({ error: "Charge not found on this statement" }, { status: 404 });
  }

  // Apply waiver / remove waiver
  const waiveUpdate = waive
    ? {
        is_waived: true,
        waived_by: dbUser.id,
        waived_at: new Date().toISOString(),
        waive_reason: reason!.trim(),
      }
    : {
        is_waived: false,
        waived_by: null,
        waived_at: null,
        waive_reason: null,
      };

  const { error: chargeErr } = await supabase
    .from("usage_charges")
    .update(waiveUpdate)
    .eq("id", charge_id);

  if (chargeErr) {
    return NextResponse.json({ error: chargeErr.message }, { status: 500 });
  }

  // Recalculate statement totals using all non-waived charges for this statement
  const { data: activeCharges, error: sumErr } = await supabase
    .from("usage_charges")
    .select("total")
    .eq("billing_statement_id", statementId)
    .eq("is_waived", false);

  if (sumErr) {
    return NextResponse.json({ error: sumErr.message }, { status: 500 });
  }

  const usageAmount = (activeCharges || []).reduce(
    (sum, c) => sum + Number(c.total || 0),
    0
  );
  const fixedAmount = Number(statement.fixed_amount || 0);
  const serviceUsageAmount = Number(statement.service_usage_amount || 0);
  const bookingUsageAmount = Number(statement.booking_usage_amount || 0);
  const subtotal = fixedAmount + usageAmount + serviceUsageAmount + bookingUsageAmount;
  const taxPercentage = Number(statement.tax_percentage || 0);
  const { cgst, sgst, igst, taxAmount, totalAmount } = computeGstAndRounding(subtotal, taxPercentage);

  const { data: updated, error: updateErr } = await supabase
    .from("billing_statements")
    .update({
      usage_amount: usageAmount,
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

  if (updateErr) {
    return NextResponse.json({ error: updateErr.message }, { status: 500 });
  }

  logAudit(supabase, {
    entityType: "billing_statement",
    entityId: statementId,
    action: "update",
    performedBy: dbUser.id,
    changes: {
      waiver: {
        old: { charge_id, is_waived: charge.is_waived },
        new: { charge_id, is_waived: waive, reason: waive ? reason : null, by: dbUser.full_name },
      },
      total_amount: { old: null, new: totalAmount },
    },
  });

  return NextResponse.json({ data: updated });
}
