import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { createNotificationsForUsers } from "@/lib/in-app-notifications";
import { requireRole } from "@/lib/exit-settlement-server";
import { DEPOSIT_REFUND_APPROVE_ROLES, DEPOSIT_REFUND_PAY_ROLES, depositRefundErrorMessage } from "@/lib/deposit-refund";

const schema = z.object({
  payment_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Enter the payment date"),
  payment_reference: z.string().trim().min(3, "Enter the bank UTR or reference"),
  paid_from_account: z.string().trim().min(1, "Enter the account it was paid from"),
  payment_notes: z.string().trim().optional(),
});

/** POST /api/deposit-refunds/[id]/pay — accounts records the bank transfer; this closes the proposal as "Customer withdrew". */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const auth = await requireRole(DEPOSIT_REFUND_PAY_ROLES, "Only accounts or an admin can record the payment.");
  if ("error" in auth) return auth.error;
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message || "Invalid request" }, { status: 400 });
  const admin = createAdminClient();
  const { data: res, error } = await admin.rpc("pay_deposit_refund", {
    p_refund_id: id, p_actor: auth.me.id, p_payment_date: parsed.data.payment_date,
    p_reference: parsed.data.payment_reference, p_from_account: parsed.data.paid_from_account, p_notes: parsed.data.payment_notes ?? null,
  });
  if (error) return NextResponse.json({ error: "Could not record the payment" }, { status: 500 });
  if (!res?.success) return NextResponse.json({ error: depositRefundErrorMessage(res?.error), code: res?.error }, { status: 409 });
  void logAudit(admin, { entityType: "proposal", entityId: res.proposal_id, action: "update", performedBy: auth.me.id,
    changes: {
      deposit_refund_status: { old: "approved", new: "paid" },
      deposit_refund_paid: { old: null, new: { amount: res.amount, payment_reference: parsed.data.payment_reference, payment_date: parsed.data.payment_date } },
      status: { old: null, new: "rejected (customer withdrew)" },
    } });
  return NextResponse.json({ ok: true });
}
