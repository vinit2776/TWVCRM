/**
 * POST /api/billing-statements/[id]/add-charge
 *
 * Adds an ad-hoc usage charge to a **draft** billing statement.
 * Finance uses this inside the View Statement dialog to append charges
 * (e.g. overtime, damages, cafeteria) before finalizing + sending.
 *
 * The endpoint:
 * 1. Validates the statement exists and is still `draft`
 * 2. Checks the caller has an allowed role (admin | manager | accounts)
 * 3. Creates a `usage_charge` row linked to the statement (+ contract/lead)
 *    with `status = 'billed'` (already on the statement)
 * 4. Recomputes the statement's `usage_amount`, `subtotal`, `tax_amount`,
 *    and `total_amount` from all linked usage charges
 * 5. Logs an audit trail for both the charge and the statement update
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";

export const maxDuration = 30;

const ALLOWED_ROLES = ["admin", "manager", "accounts"];

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: statementId } = await params;
  const supabase = await createClient();

  // ── Auth ────────────────────────────────────────────────────────────
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users")
    .select("id, role")
    .eq("auth_id", user.id)
    .single();

  if (!dbUser || !ALLOWED_ROLES.includes(dbUser.role)) {
    return NextResponse.json(
      { error: "Only admin, manager, or accounts can add charges to statements" },
      { status: 403 }
    );
  }

  // ── Fetch statement ─────────────────────────────────────────────────
  const { data: statement, error: stmtErr } = await supabase
    .from("billing_statements")
    .select("id, status, contract_id, lead_id, tax_percentage, fixed_amount, usage_amount, service_usage_amount, booking_usage_amount, subtotal, tax_amount, total_amount")
    .eq("id", statementId)
    .single();

  if (stmtErr || !statement) {
    return NextResponse.json({ error: "Statement not found" }, { status: 404 });
  }
  if (statement.status !== "draft") {
    return NextResponse.json(
      { error: "Charges can only be added to draft statements" },
      { status: 400 }
    );
  }

  // ── Parse body ──────────────────────────────────────────────────────
  const body = await request.json();
  const description = (body.description || "").trim();
  const quantity = Number(body.quantity);
  const unitPrice = Number(body.unit_price);
  // Force the charge GST rate to match the statement's tax_percentage
  // so every line item on the invoice uses the same rate. Ignores any
  // client-supplied gst_rate to prevent mismatched totals.
  const gstRate = Number(statement.tax_percentage || 18);
  const chargeDate = body.charge_date || new Date().toISOString().split("T")[0];
  const notes = (body.notes || "").trim();

  if (!description) {
    return NextResponse.json({ error: "Description is required" }, { status: 400 });
  }
  if (!quantity || quantity <= 0) {
    return NextResponse.json({ error: "Quantity must be positive" }, { status: 400 });
  }
  if (unitPrice < 0) {
    return NextResponse.json({ error: "Unit price cannot be negative" }, { status: 400 });
  }

  // ── Atomic charge insert + totals recompute (single transaction) ──
  // Uses the add_statement_charge_atomic RPC to prevent the race where
  // concurrent add-charge requests each read stale totals, causing the
  // last writer to overwrite the other's total (losing a charge amount).
  const { data: rpcResult, error: rpcErr } = await supabase.rpc("add_statement_charge_atomic", {
    p_statement_id: statementId,
    p_contract_id: statement.contract_id || null,
    p_lead_id: statement.lead_id || null,
    p_description: description,
    p_quantity: quantity,
    p_unit_price: unitPrice,
    p_gst_rate: gstRate,
    p_charge_date: chargeDate,
    p_notes: notes || null,
    p_created_by: dbUser.id,
  });

  if (rpcErr) {
    return NextResponse.json({ error: rpcErr.message }, { status: 500 });
  }

  if (rpcResult?.error) {
    return NextResponse.json({ error: rpcResult.error }, { status: 400 });
  }

  const charge = rpcResult.charge;
  const newUsageAmount = rpcResult.usage_amount;
  const newSubtotal = rpcResult.subtotal;
  const newTaxAmount = rpcResult.tax_amount;
  const newTotal = rpcResult.total_amount;

  // ── Audit ───────────────────────────────────────────────────────────
  logAudit(supabase, {
    entityType: "usage_charge",
    entityId: charge.id,
    action: "create",
    performedBy: dbUser.id,
    changes: { record: { old: null, new: charge } },
  });

  logAudit(supabase, {
    entityType: "billing_statement",
    entityId: statementId,
    action: "update",
    performedBy: dbUser.id,
    changes: {
      usage_amount: { old: statement.usage_amount, new: newUsageAmount },
      subtotal: { old: statement.subtotal, new: newSubtotal },
      tax_amount: { old: statement.tax_amount, new: newTaxAmount },
      total_amount: { old: statement.total_amount, new: newTotal },
    },
  });

  return NextResponse.json({ data: charge }, { status: 201 });
}
