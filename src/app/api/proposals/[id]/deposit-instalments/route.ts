import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import {
  canOverrideDepositFloor,
  canRequestDepositInstalment,
  depositPosition,
  instalmentErrorMessage,
  requiredDeposit,
} from "@/lib/deposit-instalments";
import {
  cancelRazorpayLink,
  createInstalmentPaymentLink,
  getInstalmentSettings,
  getRazorpayCreds,
} from "@/lib/deposit-instalment-server";

/**
 * GET  /api/proposals/[id]/deposit-instalments — the parts asked for so far, the
 *      five deposit figures and the settings that govern them.
 * POST /api/proposals/[id]/deposit-instalments — ask the customer for a part of
 *      the deposit: a fresh Razorpay link for exactly that amount.
 *
 * POST creates the link (when Razorpay is on) but does NOT message the customer (notify is off);
 * sending the request is a separate, deliberate step.
 */

const requestSchema = z.object({
  amount: z.number().positive().max(100_000_000),
  due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  internal_note: z.string().trim().min(10, "Add an internal note (at least 10 characters) so accounts know why this was asked"),
  customer_message: z.string().trim().max(500).optional(),
  floor_override_reason: z.string().trim().min(10, "Give a reason (at least 10 characters)").optional(),
});

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: proposal } = await supabase
    .from("proposals")
    .select("id, security_deposit_amount, deposit_exception_amount, deposit_credit_amount, deposit_payment_status")
    .eq("id", id)
    .maybeSingle();
  if (!proposal) return NextResponse.json({ error: "Proposal not found" }, { status: 404 });

  const { data: rows } = await supabase
    .from("proposal_deposit_instalments")
    .select("*")
    .eq("proposal_id", id)
    .order("seq", { ascending: true });

  const settings = await getInstalmentSettings(createAdminClient());
  const instalments = rows || [];
  return NextResponse.json({
    data: {
      instalments,
      position: depositPosition(requiredDeposit(proposal), instalments),
      has_open_ask: instalments.some((r) => r.status === "requested"),
      enabled: settings.enabled,
      min_first_part_percent: settings.minFirstPartPercent,
    },
  });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: actor } = await supabase
    .from("users").select("id, role").eq("auth_id", user.id).maybeSingle();
  if (!actor || !canRequestDepositInstalment(actor.role)) {
    return NextResponse.json({ error: "Only an admin, manager or sales rep can ask for a part of the deposit" }, { status: 403 });
  }

  const parsed = requestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message || "Invalid request" }, { status: 400 });
  }
  const body = parsed.data;

  const admin = createAdminClient();
  const settings = await getInstalmentSettings(admin);
  if (!settings.enabled) {
    return NextResponse.json({ error: "Part payment of the deposit is not switched on yet" }, { status: 403 });
  }

  // Without Razorpay the ask is still valid: the customer pays by bank transfer
  // and accounts records it against this part.
  const creds = await getRazorpayCreds(admin);

  const { data: proposal } = await admin
    .from("proposals")
    .select("id, proposal_number, deposit_razorpay_link_id, deposit_link_cancelled_at, lead:leads!proposals_lead_id_fkey(first_name, last_name, email, phone, mobile)")
    .eq("id", id)
    .maybeSingle();
  if (!proposal) return NextResponse.json({ error: "Proposal not found" }, { status: 404 });

  // Only a manager/admin can carry a below-minimum first part; a sales rep's
  // reason is ignored, so the refusal below tells them who to ask.
  const overrideBy = body.floor_override_reason && canOverrideDepositFloor(actor.role) ? actor.id : null;

  const { data: res, error: rpcErr } = await admin.rpc("request_deposit_instalment", {
    p_proposal_id: id,
    p_amount: body.amount,
    p_due_date: body.due_date ?? null,
    p_internal_note: body.internal_note,
    p_customer_message: body.customer_message ?? null,
    p_actor: actor.id,
    p_override_by: overrideBy,
    p_override_reason: overrideBy ? body.floor_override_reason : null,
  });
  if (rpcErr) {
    console.error("[deposit-instalments] request failed:", rpcErr.message);
    return NextResponse.json({ error: "Could not record the request" }, { status: 500 });
  }
  if (!res?.success) {
    return NextResponse.json(
      { error: instalmentErrorMessage(res?.error, { floor: res?.floor, percent: res?.percent, balance: res?.balance }), code: res?.error },
      { status: 409 },
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const lead = proposal.lead as any;
  const link = creds ? await createInstalmentPaymentLink(creds, {
    amount: body.amount,
    proposalId: id,
    proposalNumber: proposal.proposal_number,
    instalmentId: res.instalment_id,
    seq: res.seq,
    customer: {
      name: lead ? `${lead.first_name || ""} ${lead.last_name || ""}`.trim() || undefined : undefined,
      email: lead?.email,
      phone: lead?.phone || lead?.mobile,
    },
  }) : null;

  if (link && "error" in link) {
    // No link, no ask: withdraw the row so it doesn't block the next attempt.
    await admin.rpc("cancel_deposit_instalment", {
      p_instalment_id: res.instalment_id, p_actor: actor.id, p_reason: "Payment link could not be created",
    });
    return NextResponse.json({ error: link.error }, { status: 502 });
  }

  const { error: linkSaveErr } = link
    ? await admin
        .from("proposal_deposit_instalments")
        .update({ razorpay_link_id: link.id, razorpay_link_url: link.url, updated_at: new Date().toISOString() })
        .eq("id", res.instalment_id)
    : { error: null };
  if (linkSaveErr && link) {
    await cancelRazorpayLink(admin, link.id);
    await admin.rpc("cancel_deposit_instalment", {
      p_instalment_id: res.instalment_id, p_actor: actor.id, p_reason: "Payment link could not be saved",
    });
    return NextResponse.json({ error: "Could not save the payment link" }, { status: 500 });
  }

  // The proposal's original full-deposit link would let the customer pay the
  // whole amount alongside the part. Withdraw it (ids stay on the record so a
  // late payment is still recognised — see record_deposit_payment_for_link).
  if (proposal.deposit_razorpay_link_id && !proposal.deposit_link_cancelled_at) {
    const now = new Date().toISOString();
    await admin.from("proposals").update({
      deposit_link_cancelled_at: now,
      deposit_link_cancelled_by: actor.id,
      deposit_link_cancel_reason: "Deposit is being collected in parts",
    }).eq("id", id).is("deposit_link_cancelled_at", null);
    await cancelRazorpayLink(admin, proposal.deposit_razorpay_link_id);
  }

  void logAudit(admin, {
    entityType: "proposal",
    entityId: id,
    action: "update",
    performedBy: actor.id,
    changes: {
      deposit_part_requested: { old: null, new: { seq: res.seq, amount: body.amount, instalment_id: res.instalment_id } },
      ...(body.floor_override_reason && overrideBy ? { deposit_floor_override_reason: { old: null, new: body.floor_override_reason } } : {}),
    },
  });

  return NextResponse.json({
    data: { instalment_id: res.instalment_id, seq: res.seq, amount: body.amount, razorpay_link_url: link?.url ?? null },
  });
}
