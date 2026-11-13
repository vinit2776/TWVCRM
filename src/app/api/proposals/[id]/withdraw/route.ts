import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { voProposalColumnsPresent, VO_PROPOSAL_NOT_READY, proposalPiPaymentBlock, retireProposalPayments } from "@/lib/vo-proposal-server";
import { VO_WITHDRAWABLE, voWithdrawBlockedReason } from "@/lib/vo-proposal";

const ROLES = ["admin", "manager", "sales_rep"];
const bodySchema = z.object({ reason: z.string().trim().min(3, "Give a short reason").max(500) });

/**
 * POST /api/proposals/[id]/withdraw  (Virtual Office proposals only)
 *
 * Staff pull a sent proposal back: status -> withdrawn, the customer link stops
 * accepting answers, and any payment demands are voided/cancelled. Refused when
 * money has been collected.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { data: actor } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!actor || !ROLES.includes(actor.role)) {
    return NextResponse.json({ error: "You don't have permission to withdraw a proposal." }, { status: 403 });
  }
  if (!(await voProposalColumnsPresent())) return NextResponse.json({ error: VO_PROPOSAL_NOT_READY }, { status: 503 });

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });

  const admin = createAdminClient();
  const { data: p } = await admin.from("proposals").select("*").eq("id", id).single();
  if (!p) return NextResponse.json({ error: "Proposal not found" }, { status: 404 });

  const blocked = voWithdrawBlockedReason(p);
  if (blocked) return NextResponse.json({ error: blocked }, { status: 409 });
  const piBlock = await proposalPiPaymentBlock(admin, id);
  if (piBlock) return NextResponse.json({ error: piBlock }, { status: 409 });

  const now = new Date().toISOString();
  const { data: updated } = await admin
    .from("proposals")
    .update({ status: "withdrawn", withdrawn_at: now, withdrawn_reason: parsed.data.reason })
    .eq("id", id)
    .in("status", [...VO_WITHDRAWABLE])
    .select("id")
    .maybeSingle();
  if (!updated) {
    return NextResponse.json({ error: "This proposal changed while you were withdrawing it. Refresh and check." }, { status: 409 });
  }

  await retireProposalPayments(admin, p, actor.id, "Proposal withdrawn");

  logAudit(supabase, {
    entityType: "proposal",
    entityId: id,
    action: "update",
    performedBy: actor.id,
    changes: {
      action: { old: null, new: "withdrawn" },
      status: { old: p.status, new: "withdrawn" },
      withdrawn_reason: { old: null, new: parsed.data.reason },
    },
  });

  return NextResponse.json({ success: true, status: "withdrawn" });
}
