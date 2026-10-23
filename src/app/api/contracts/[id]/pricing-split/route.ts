import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { lineItemSchema } from "@/lib/validations";
import { computePricingTotals, adjustDepositShortfall } from "@/lib/contract-pricing-split";

const bodySchema = z.object({
  // total is recomputed server-side, so callers only send the price inputs
  items: z.array(lineItemSchema.omit({ total: true })).min(1, "At least one line item is required"),
  reason: z.string().trim().min(10, "A reason of at least 10 characters is required"),
});

/**
 * POST /api/contracts/[id]/pricing-split
 *
 * Admin-only correction of an ACTIVE contract's line items, used to split a
 * single rate into rent (escalates) and maintenance (fixed), or to fix a rate
 * that was escalated wrongly. Rewrites items, subtotal, tax, total and the
 * deposit shortfall, and logs the old and new values.
 *
 * Deliberately does NOT touch billing statements: an already-issued statement
 * is a financial document (and may sit in accounts' Tally Inbox), so it is
 * voided and reissued through its own flow. The response lists the open
 * statements so the caller knows which ones still carry the old rate.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 401 });
  if (dbUser.role !== "admin") {
    return NextResponse.json({ error: "Only admin can change a contract's pricing split" }, { status: 403 });
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message || "Invalid request" }, { status: 400 });
  }
  const { items: newLines, reason } = parsed.data;

  const admin = createAdminClient();
  const { data: contract } = await admin
    .from("contracts")
    .select("id, contract_number, status, items, subtotal, total_amount, tax_percentage, discount_percentage, security_deposit_months, deposit_shortfall")
    .eq("id", id)
    .single();
  if (!contract) return NextResponse.json({ error: "Contract not found" }, { status: 404 });
  if (contract.status !== "active") {
    return NextResponse.json({ error: "Only an active contract's pricing can be changed here" }, { status: 400 });
  }

  // Phased rates override the flat items for billing, so editing the items
  // would not change what is billed and would only mislead.
  const { count: phaseCount } = await admin
    .from("contract_rate_phases")
    .select("id", { count: "exact", head: true })
    .eq("contract_id", id);
  if ((phaseCount ?? 0) > 0) {
    return NextResponse.json({ error: "This contract has rate phases. Edit the phases instead." }, { status: 409 });
  }

  const totals = computePricingTotals(
    newLines,
    Number(contract.tax_percentage || 18),
    Number(contract.discount_percentage || 0)
  );
  const oldSubtotal = Number(contract.subtotal);
  const newShortfall = adjustDepositShortfall(
    Number(contract.deposit_shortfall || 0),
    oldSubtotal,
    totals.subtotal,
    Number(contract.security_deposit_months || 0)
  );

  const { error: updateErr } = await admin
    .from("contracts")
    .update({
      items: totals.items,
      subtotal: totals.subtotal,
      discount_amount: totals.discountAmount,
      tax_amount: totals.taxAmount,
      total_amount: totals.totalAmount,
      deposit_shortfall: newShortfall,
    })
    .eq("id", id);
  if (updateErr) return NextResponse.json({ error: updateErr.message }, { status: 500 });

  logAudit(admin, {
    entityType: "contract",
    entityId: id,
    action: "update",
    performedBy: dbUser.id,
    changes: {
      edit_reason: { old: null, new: `pricing_split: ${reason}` },
      items: { old: contract.items, new: totals.items },
      subtotal: { old: oldSubtotal, new: totals.subtotal },
      total_amount: { old: Number(contract.total_amount), new: totals.totalAmount },
      deposit_shortfall: { old: Number(contract.deposit_shortfall || 0), new: newShortfall },
    },
  });

  const { data: openStatements } = await admin
    .from("billing_statements")
    .select("id, statement_number, period_start, period_end, total_amount, status, payment_status")
    .eq("contract_id", id)
    .in("status", ["draft", "finalized", "exported"])
    .neq("payment_status", "paid");

  return NextResponse.json({
    success: true,
    data: {
      subtotal: totals.subtotal,
      total_amount: totals.totalAmount,
      deposit_shortfall: newShortfall,
      open_statements_at_old_rate: openStatements ?? [],
    },
  });
}
