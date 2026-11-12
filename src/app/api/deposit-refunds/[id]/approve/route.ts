import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { createNotificationsForUsers } from "@/lib/in-app-notifications";
import { requireRole } from "@/lib/exit-settlement-server";
import { DEPOSIT_REFUND_APPROVE_ROLES, DEPOSIT_REFUND_PAY_ROLES, depositRefundErrorMessage } from "@/lib/deposit-refund";

/** POST /api/deposit-refunds/[id]/approve — admin only, every refund. Moves it to accounts to pay. */
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const auth = await requireRole(DEPOSIT_REFUND_APPROVE_ROLES, "Only an admin can approve a refund.");
  if ("error" in auth) return auth.error;
  const admin = createAdminClient();
  const { data: res, error } = await admin.rpc("approve_deposit_refund", { p_refund_id: id, p_actor: auth.me.id });
  if (error) return NextResponse.json({ error: "Could not approve the refund" }, { status: 500 });
  if (!res?.success) return NextResponse.json({ error: depositRefundErrorMessage(res?.error), code: res?.error }, { status: 409 });
  void logAudit(admin, { entityType: "proposal", entityId: res.proposal_id, action: "update", performedBy: auth.me.id,
    changes: { deposit_refund_status: { old: "pending_approval", new: "approved" } } });
  const { data: acc } = await admin.from("users").select("id").eq("role", "accounts").eq("is_active", true);
  await createNotificationsForUsers((acc ?? []).map((u) => u.id as string), {
    type: "deposit_refund", title: "Deposit refund approved, ready to pay",
    body: `₹${Number(res.amount).toLocaleString("en-IN")} to pay by bank transfer (Acc Payables).`,
    url: "/accounting?tab=vendor-payments", entityType: "proposal", entityId: res.proposal_id,
  }).catch(() => {});
  return NextResponse.json({ ok: true });
}
