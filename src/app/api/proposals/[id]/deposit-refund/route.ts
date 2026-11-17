import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { createNotificationsForUsers } from "@/lib/in-app-notifications";
import { canRequestDepositRefund, depositRefundErrorMessage } from "@/lib/deposit-refund";

const schema = z.object({
  reason: z.string().trim().min(10, "Give a reason (at least 10 characters)"),
  bank_account_name: z.string().trim().max(120).optional(),
  bank_account_number: z.string().trim().max(40).optional(),
  bank_ifsc: z.string().trim().max(20).optional(),
});

/** GET — the live (or latest) refund on this proposal. POST — request a walk-away refund of what was paid in parts. */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { data } = await supabase
    .from("proposal_deposit_refunds").select("*").eq("proposal_id", id)
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  return NextResponse.json({ data: data ?? null });
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { data: actor } = await supabase.from("users").select("id, role").eq("auth_id", user.id).maybeSingle();
  if (!actor || !canRequestDepositRefund(actor.role)) {
    return NextResponse.json({ error: "Only an admin, manager or sales rep can request a refund" }, { status: 403 });
  }
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message || "Invalid request" }, { status: 400 });

  const admin = createAdminClient();
  const { data: res, error } = await admin.rpc("request_deposit_refund", {
    p_proposal_id: id, p_actor: actor.id, p_reason: parsed.data.reason,
    p_bank_name: parsed.data.bank_account_name ?? null,
    p_bank_number: parsed.data.bank_account_number ?? null,
    p_bank_ifsc: parsed.data.bank_ifsc ?? null,
  });
  if (error) {
    console.error("[deposit-refund] request failed:", error.message);
    return NextResponse.json({ error: "Could not record the refund request" }, { status: 500 });
  }
  if (!res?.success) return NextResponse.json({ error: depositRefundErrorMessage(res?.error), code: res?.error }, { status: 409 });

  void logAudit(admin, {
    entityType: "proposal", entityId: id, action: "update", performedBy: actor.id,
    changes: { deposit_refund_requested: { old: null, new: { refund_id: res.refund_id, amount: res.amount } }, reason: { old: null, new: parsed.data.reason } },
  });
  // Every refund needs an admin's approval — tell them.
  const { data: admins } = await admin.from("users").select("id").eq("role", "admin").eq("is_active", true);
  await createNotificationsForUsers((admins ?? []).map((a) => a.id as string), {
    type: "deposit_refund", title: "Deposit refund needs approval",
    body: `₹${Number(res.amount).toLocaleString("en-IN")} to refund after the customer withdrew.`,
    url: `/proposals/${id}`, entityType: "proposal", entityId: id,
  }).catch(() => {});
  return NextResponse.json({ data: { refund_id: res.refund_id, amount: res.amount } });
}
