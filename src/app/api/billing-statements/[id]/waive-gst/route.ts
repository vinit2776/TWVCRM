import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { canRecordPayments } from "@/lib/constants";
import { bucketFor } from "@/lib/tally-handoff";

/**
 * POST /api/billing-statements/[id]/waive-gst
 *
 * Recategorizes an ad-hoc-invoice-sourced billing statement that was
 * mis-tagged as taxable revenue but actually collected a refundable
 * security deposit — closes it out of the Tally Inbox GST worklist without
 * a Tally GST invoice, and credits the amount to the customer's real,
 * usable deposit balance via the same manual-topup mechanism used
 * elsewhere (record_deposit_topup_manual).
 *
 * This is a correction for money already collected the wrong way — it does
 * NOT send a "payment received" customer email (nothing new arrived today).
 * Traceability lives in the audit trail and the Closed-tab badge instead.
 *
 * Guards:
 *   • accounts/admin only
 *   • statement must be sourced from an ad-hoc invoice (invoice_id set)
 *   • statement must currently be in the "GST to issue" bucket
 *   • not already voided or already waived
 *   • target contract must belong to the invoice's lead and be active
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: actor } = await supabase
    .from("users")
    .select("id, role")
    .eq("auth_id", user.id)
    .single();

  if (!actor || !canRecordPayments(actor.role)) {
    return NextResponse.json(
      { error: "Only admin or accounts can recategorize a statement this way" },
      { status: 403 }
    );
  }

  const body = await request.json().catch(() => ({})) as { reason?: string; contract_id?: string };
  const reason = body.reason?.trim();
  if (!reason || reason.length < 10) {
    return NextResponse.json({ error: "A reason is required (at least 10 characters)" }, { status: 400 });
  }

  const { data: statement, error: fetchErr } = await supabase
    .from("billing_statements")
    .select("id, statement_number, invoice_id, handoff_state, voided_at, gst_waived_at, total_amount")
    .eq("id", id)
    .single();

  if (fetchErr || !statement) {
    return NextResponse.json({ error: "Statement not found" }, { status: 404 });
  }
  if (!statement.invoice_id) {
    return NextResponse.json(
      { error: "Only ad-hoc invoice statements can be recategorized this way" },
      { status: 400 }
    );
  }
  if (statement.voided_at) {
    return NextResponse.json({ error: "This statement has been voided" }, { status: 400 });
  }
  if (statement.gst_waived_at) {
    return NextResponse.json({ error: "Already recategorized as a deposit" }, { status: 400 });
  }
  if (bucketFor(statement.handoff_state) !== "gst_to_issue") {
    return NextResponse.json(
      { error: "This statement isn't in the GST to issue bucket" },
      { status: 400 }
    );
  }

  const { data: invoice, error: invoiceErr } = await supabase
    .from("proforma_invoices")
    .select("id, invoice_number, lead_id")
    .eq("id", statement.invoice_id)
    .single();

  if (invoiceErr || !invoice || !invoice.lead_id) {
    return NextResponse.json({ error: "Could not resolve the source ad-hoc invoice's customer" }, { status: 404 });
  }

  // Resolve which contract's deposit balance to credit — the customer's
  // single active contract, unless the caller already picked one (surfaced
  // by the frontend when a lead has more than one active contract).
  let contractId = body.contract_id?.trim() || null;

  if (contractId) {
    const { data: chosen } = await supabase
      .from("contracts")
      .select("id, lead_id, status")
      .eq("id", contractId)
      .single();
    if (!chosen || chosen.lead_id !== invoice.lead_id || chosen.status !== "active") {
      return NextResponse.json({ error: "Selected contract does not belong to this customer" }, { status: 400 });
    }
  } else {
    const { data: activeContracts } = await supabase
      .from("contracts")
      .select("id, contract_number")
      .eq("lead_id", invoice.lead_id)
      .eq("status", "active");

    if (!activeContracts || activeContracts.length === 0) {
      return NextResponse.json(
        { error: "No active contract found for this customer — can't credit a deposit." },
        { status: 400 }
      );
    }
    if (activeContracts.length > 1) {
      return NextResponse.json(
        {
          error: "This customer has more than one active contract — pick which one to credit.",
          needs_contract_selection: true,
          contracts: activeContracts,
        },
        { status: 409 }
      );
    }
    contractId = activeContracts[0].id;
  }

  const admin = createAdminClient();
  const categoryNote = `Recategorized from ad-hoc invoice ${invoice.invoice_number} (${statement.statement_number}) — originally booked as revenue, actually a security deposit. ${reason}`;

  const { data: rpcResult, error: rpcError } = await admin.rpc("record_deposit_topup_manual", {
    p_contract_id: contractId,
    p_amount: Number(statement.total_amount),
    p_category: "other",
    p_category_note: categoryNote,
    p_payment_mode: "reclassified",
    p_payment_reference: statement.statement_number,
    p_proof_path: null,
    p_applies_to_shortfall: false,
    p_created_by: actor.id,
  });

  if (rpcError) return NextResponse.json({ error: rpcError.message }, { status: 500 });

  const result = rpcResult?.[0];
  if (!result?.success) {
    return NextResponse.json({ error: result?.error || "Could not credit the deposit" }, { status: 422 });
  }

  const now = new Date().toISOString();

  const { error: updateErr } = await supabase
    .from("billing_statements")
    .update({
      primary_head: "security_deposit",
      gst_waived_at: now,
      gst_waived_by: actor.id,
      gst_waived_reason: reason,
      gst_waived_deposit_topup_id: result.topup_id,
      handoff_state: "complete",
    })
    .eq("id", id);

  if (updateErr) return NextResponse.json({ error: updateErr.message }, { status: 500 });

  await supabase
    .from("proforma_invoices")
    .update({ primary_head: "security_deposit" })
    .eq("id", invoice.id);

  logAudit(supabase, {
    entityType: "deposit_topup",
    entityId: result.topup_id,
    action: "deposit_topup_recorded",
    performedBy: actor.id,
    changes: {
      amount: { old: null, new: Number(statement.total_amount) },
      category: { old: null, new: "other" },
      contract_id: { old: null, new: contractId },
    },
  });

  logAudit(supabase, {
    entityType: "billing_statement",
    entityId: id,
    action: "update",
    performedBy: actor.id,
    changes: {
      handoff_state: { old: statement.handoff_state, new: "complete" },
      primary_head: { old: null, new: "security_deposit" },
      gst_waived_reason: { old: null, new: reason },
    },
  });

  logAudit(supabase, {
    entityType: "invoice",
    entityId: invoice.id,
    action: "update",
    performedBy: actor.id,
    changes: {
      primary_head: { old: null, new: "security_deposit" },
    },
  });

  return NextResponse.json({
    message: "Recategorized as a security deposit and closed — no GST invoice required.",
    deposit_topup_id: result.topup_id,
    contract_id: contractId,
  });
}
