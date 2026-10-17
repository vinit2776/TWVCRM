import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { SETTLEMENT_PAY_ROLES } from "@/lib/exit-settlement";
import { loadSettlementForAction, notifyRoles, requireRole } from "@/lib/exit-settlement-server";

const schema = z.object({
  payment_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Enter the payment date"),
  payment_reference: z.string().trim().min(3, "Enter the bank UTR or reference"),
  paid_from_account: z.string().trim().min(1, "Enter the account it was paid from"),
  payment_notes: z.string().trim().optional(),
});

/** POST /api/exit-settlements/[id]/pay — accounts records the manual bank transfer. */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const auth = await requireRole(SETTLEMENT_PAY_ROLES, "Only accounts or an admin can record the payment.");
  if ("error" in auth) return auth.error;
  const { me } = auth;
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message || "Invalid request" }, { status: 400 });

  const admin = createAdminClient();
  const loaded = await loadSettlementForAction(admin, id);
  if (!loaded) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const { settlement, contractNumber, customer } = loaded;
  if (settlement.refund_amount <= 0) return NextResponse.json({ error: "There is no refund to pay on this settlement." }, { status: 400 });

  const { data: updated, error } = await admin
    .from("exit_settlements")
    .update({
      status: "paid", paid_by: me.id, paid_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      payment_date: parsed.data.payment_date, payment_reference: parsed.data.payment_reference,
      paid_from_account: parsed.data.paid_from_account, payment_notes: parsed.data.payment_notes || null,
    })
    .eq("id", id).eq("status", "approved").select("id");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!updated || updated.length === 0) return NextResponse.json({ error: "Only an approved refund can be marked paid." }, { status: 409 });

  // The contract already carries EXIT-xxxx as the refund reference; replace it with the real bank reference.
  await admin.from("contracts").update({ deposit_refund_reference: parsed.data.payment_reference }).eq("id", settlement.contract_id);

  logAudit(admin, {
    entityType: "contract", entityId: settlement.contract_id, action: "exit_paid", performedBy: me.id,
    changes: {
      status: { old: "approved", new: "paid" }, amount: { old: null, new: settlement.refund_amount },
      payment_reference: { old: null, new: parsed.data.payment_reference }, payment_date: { old: null, new: parsed.data.payment_date },
    },
  });
  await notifyRoles(admin, ["admin"], [settlement.cleared_by], {
    title: `Refund paid: ${customer} (${contractNumber})`,
    body: `₹${settlement.refund_amount.toLocaleString("en-IN")} paid, UTR ${parsed.data.payment_reference}.`,
    url: `/accounting/exit-settlements/${id}`, contractId: settlement.contract_id,
  });
  return NextResponse.json({ ok: true });
}
