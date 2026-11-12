import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { priceVoQuote, latestFloorApproval, requestFloorApproval, voSendBlockedReason } from "@/lib/vo-pricing-server";

const ROLES = ["admin", "manager", "sales_rep"];

async function load(id: string) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) } as const;
  const { data: me } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!me || !ROLES.includes(me.role)) return { error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) } as const;
  const admin = createAdminClient();
  const { data: proposal } = await admin
    .from("proposals")
    .select("id, kind, proposal_number, location_id, vo_term_months, vo_quoted_price, vo_price_snapshot")
    .eq("id", id)
    .maybeSingle();
  if (!proposal || proposal.kind !== "virtual_office") {
    return { error: NextResponse.json({ error: "Virtual Office proposal not found" }, { status: 404 }) } as const;
  }
  return { supabase, me, admin, proposal } as const;
}

/**
 * GET /api/proposals/[id]/vo-pricing
 * Live guide, floor and win trend for this VO proposal's purpose, location and term, plus the
 * below-floor approval state. Read-only for every role that can see proposals.
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await load(id);
  if ("error" in ctx) return ctx.error;
  const { admin, proposal } = ctx;

  const snapshot = proposal.vo_price_snapshot ?? null;
  const approval = await latestFloorApproval(admin, id);
  const blockedReason = await voSendBlockedReason(admin, proposal);
  const base = { snapshot, approval, blocked_reason: blockedReason };

  if (!snapshot?.purpose || !proposal.vo_term_months) return NextResponse.json({ data: { ...base, setUp: true, pricing: null } });
  const priced = await priceVoQuote(admin, {
    purpose: snapshot.purpose,
    locationId: proposal.location_id ?? null,
    termMonths: proposal.vo_term_months,
    quotedRate: proposal.vo_quoted_price != null ? Number(proposal.vo_quoted_price) : null,
  });
  if (!priced.setUp) return NextResponse.json({ data: { ...base, setUp: false, pricing: null } });
  return NextResponse.json({ data: { ...base, setUp: true, pricing: priced.result } });
}

const requestSchema = z.object({ reason: z.string().trim().min(5, "Say why this quote is below the floor").max(500) });

/** POST /api/proposals/[id]/vo-pricing: (re)request manager approval for a below-floor quote. */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await load(id);
  if ("error" in ctx) return ctx.error;
  const { supabase, me, admin, proposal } = ctx;

  const parsed = requestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });

  const snap = proposal.vo_price_snapshot;
  if (!snap?.requires_approval) return NextResponse.json({ error: "This quote is not below the floor, so it needs no approval." }, { status: 409 });
  const current = await latestFloorApproval(admin, id);
  const sameQuote = current && Number(current.metadata?.quoted_rate) === Number(snap.quoted_rate) && Number(current.metadata?.term_months) === Number(snap.term_months);
  if (sameQuote && ["pending", "approved"].includes(current.status)) {
    return NextResponse.json({ error: current.status === "pending" ? "An approval request is already waiting." : "This price is already approved." }, { status: 409 });
  }

  const approval = await requestFloorApproval(admin, {
    proposalId: id,
    proposalNumber: proposal.proposal_number,
    requestedBy: me.id,
    reason: parsed.data.reason,
    snapshot: snap,
    locationId: proposal.location_id ?? null,
  });
  if ("error" in approval) return NextResponse.json({ error: approval.error }, { status: 500 });

  logAudit(supabase, {
    entityType: "proposal",
    entityId: id,
    action: "update",
    performedBy: me.id,
    changes: { vo_floor_approval_requested: { old: null, new: approval.id } },
  });
  return NextResponse.json({ data: { id: approval.id } }, { status: 201 });
}
