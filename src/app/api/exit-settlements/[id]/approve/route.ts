import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { SETTLEMENT_APPROVE_ROLES } from "@/lib/exit-settlement";
import { loadSettlementForAction, notifyRoles, requireRole } from "@/lib/exit-settlement-server";

/**
 * POST /api/exit-settlements/[id]/approve — admin only.
 * Moves the deposit out of the customer's pool atomically (approve_exit_settlement),
 * then lets accounts pay a refund. Never contacts the customer.
 */
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const auth = await requireRole(SETTLEMENT_APPROVE_ROLES, "Only an admin can approve an exit settlement.");
  if ("error" in auth) return auth.error;
  const { me } = auth;

  const admin = createAdminClient();
  const loaded = await loadSettlementForAction(admin, id);
  if (!loaded) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const { data, error } = await admin.rpc("approve_exit_settlement", { p_settlement_id: id, p_approved_by: me.id });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const result = (data as Array<{ success: boolean; error: string | null; new_status: string | null }> | null)?.[0];
  if (!result?.success) return NextResponse.json({ error: result?.error || "Couldn't approve" }, { status: 422 });

  const { settlement, contractNumber, customer } = loaded;
  logAudit(admin, {
    entityType: "contract", entityId: settlement.contract_id, action: "exit_approved", performedBy: me.id,
    changes: {
      status: { old: "pending_approval", new: result.new_status },
      refund: { old: null, new: settlement.refund_amount },
      retained: { old: null, new: settlement.retained_amount },
      owed: { old: null, new: settlement.owed_amount },
      same_person_cleared_and_approved: { old: null, new: settlement.cleared_by === me.id },
    },
  });

  if (settlement.refund_amount > 0) {
    await notifyRoles(admin, ["accounts"], [settlement.cleared_by], {
      title: `Refund approved, ready to pay: ${customer} (${contractNumber})`,
      body: `₹${settlement.refund_amount.toLocaleString("en-IN")} to pay by bank transfer.`,
      url: `/accounting/exit-settlements/${id}`, contractId: settlement.contract_id,
    });
  } else if (settlement.owed_amount > 0) {
    await notifyRoles(admin, ["accounts"], [settlement.cleared_by], {
      title: `Customer owes exit charges: ${customer} (${contractNumber})`,
      body: `₹${settlement.owed_amount.toLocaleString("en-IN")} is owed after the deposit. Raise the invoice through Billing.`,
      url: `/accounting/exit-settlements/${id}`, contractId: settlement.contract_id,
    });
  }
  return NextResponse.json({ ok: true, status: result.new_status });
}
