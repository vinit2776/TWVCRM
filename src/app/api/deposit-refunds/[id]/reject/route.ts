import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { createNotificationsForUsers } from "@/lib/in-app-notifications";
import { requireRole } from "@/lib/exit-settlement-server";
import { DEPOSIT_REFUND_APPROVE_ROLES, DEPOSIT_REFUND_PAY_ROLES, depositRefundErrorMessage } from "@/lib/deposit-refund";

const schema = z.object({ reason: z.string().trim().min(10, "Give a reason (at least 10 characters)") });

/** POST /api/deposit-refunds/[id]/reject — admin only. The request is closed; the proposal is untouched. */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const auth = await requireRole(DEPOSIT_REFUND_APPROVE_ROLES, "Only an admin can reject a refund.");
  if ("error" in auth) return auth.error;
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message || "Invalid request" }, { status: 400 });
  const admin = createAdminClient();
  const { data: res, error } = await admin.rpc("reject_deposit_refund", { p_refund_id: id, p_actor: auth.me.id, p_reason: parsed.data.reason });
  if (error) return NextResponse.json({ error: "Could not reject the refund" }, { status: 500 });
  if (!res?.success) return NextResponse.json({ error: depositRefundErrorMessage(res?.error), code: res?.error }, { status: 409 });
  void logAudit(admin, { entityType: "proposal", entityId: res.proposal_id, action: "update", performedBy: auth.me.id,
    changes: { deposit_refund_status: { old: "pending_approval", new: "rejected" }, reason: { old: null, new: parsed.data.reason } } });
  return NextResponse.json({ ok: true });
}
