import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { loadExitView } from "@/lib/contract-exit-server";
import { clearanceBlockers, computeClearance, SETTLEMENT_CLEAR_ROLES, validateBankDetails } from "@/lib/exit-settlement";
import { customerLabel, getLiveSettlement, notifyRoles } from "@/lib/exit-settlement-server";

const schema = z.object({
  bank_account_name: z.string().trim().optional(),
  bank_account_number: z.string().trim().optional(),
  bank_ifsc: z.string().trim().optional(),
});

/**
 * POST /api/contracts/[id]/exit/settlement — send the exit for admin approval.
 *
 * Fixes the settlement from fresh figures (never from the client), locks the
 * charges, and tells the admins. Moves no money: the deposit leaves the pool
 * only when the admin approves. Never contacts the customer.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { data: me } = await supabase.from("users").select("id, role, full_name").eq("auth_id", user.id).single();
  if (!me || !(SETTLEMENT_CLEAR_ROLES as readonly string[]).includes(me.role)) {
    return NextResponse.json({ error: "Only admins, managers and sales reps can send an exit for approval." }, { status: 403 });
  }
  const parsed = schema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });

  const admin = createAdminClient();
  const view = await loadExitView(admin, id);
  if (!view) return NextResponse.json({ error: "No exit in progress for this contract." }, { status: 404 });

  const live = await getLiveSettlement(admin, view.exit.id);
  const blockers = clearanceBlockers({
    exitStatus: view.exit.status,
    inspectionDone: !!view.exit.inspection_done_at,
    unpaidInvoices: view.settlement.unpaidInvoices,
    unbilledUsage: view.settlement.unbilledUsage,
    hasLiveSettlement: !!live,
  });
  if (blockers.length > 0) return NextResponse.json({ error: blockers[0], blockers }, { status: 409 });

  const clr = computeClearance(view.depositAvailable, view.settlement.charges);
  let bank: { bank_account_name: string | null; bank_account_number: string | null; bank_ifsc: string | null } = {
    bank_account_name: null, bank_account_number: null, bank_ifsc: null,
  };
  if (clr.refund > 0) {
    const bad = validateBankDetails(parsed.data);
    if (bad) return NextResponse.json({ error: bad }, { status: 400 });
    bank = {
      bank_account_name: parsed.data.bank_account_name!.trim(),
      bank_account_number: parsed.data.bank_account_number!.trim(),
      bank_ifsc: parsed.data.bank_ifsc!.trim().toUpperCase(),
    };
  }

  const { data: contract } = await admin
    .from("contracts")
    .select("contract_number, lead_id, lead:leads!contracts_lead_id_fkey(first_name, last_name, company)")
    .eq("id", id).single();
  if (!contract) return NextResponse.json({ error: "Contract not found" }, { status: 404 });

  const { data: row, error } = await admin
    .from("exit_settlements")
    .insert({
      exit_id: view.exit.id, contract_id: id, lead_id: contract.lead_id,
      outcome: clr.outcome, deposit_amount: view.depositAvailable, charges_total: view.settlement.charges,
      retained_amount: clr.retained, refund_amount: clr.refund, owed_amount: clr.owed,
      snapshot: { charges: view.charges.map((c) => ({ charge_type: c.charge_type, description: c.description, amount: c.amount, added_by_name: c.added_by_name ?? null, edited_after_add: c.edited_after_add })) },
      ...bank, cleared_by: me.id,
    })
    .select("id")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: error.code === "23505" ? 409 : 500 });

  logAudit(admin, {
    entityType: "contract", entityId: id, action: "exit_cleared", performedBy: me.id,
    changes: { outcome: { old: null, new: clr.outcome }, refund: { old: null, new: clr.refund }, retained: { old: null, new: clr.retained }, owed: { old: null, new: clr.owed } },
  });

  const customer = customerLabel(contract.lead as unknown as { first_name: string | null; last_name: string | null; company: string | null } | null);
  await notifyRoles(admin, ["admin"], [], {
    title: `Exit awaiting your approval: ${customer} (${contract.contract_number})`,
    body: clr.refund > 0 ? `Refund of ₹${clr.refund.toLocaleString("en-IN")} · sent by ${me.full_name ?? "staff"}` : `No refund · sent by ${me.full_name ?? "staff"}`,
    url: `/accounting/exit-settlements/${row.id}`, contractId: id,
  });

  return NextResponse.json({ data: { id: row.id } }, { status: 201 });
}
