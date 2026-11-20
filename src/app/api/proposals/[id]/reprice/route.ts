import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { voProposalColumnsPresent, VO_PROPOSAL_NOT_READY } from "@/lib/vo-proposal-server";
import { priceVoQuote, buildDirectSnapshot, requestFloorApproval, isMissingColumn } from "@/lib/vo-pricing-server";
import { VO_RATE_PURPOSES } from "@/lib/constants";
import { VO_ALLOWED_TERMS, voRepriceBlockedReason, voRepricedTotals } from "@/lib/vo-proposal";

const ROLES = ["admin", "manager", "sales_rep"];

const bodySchema = z.object({
  /** Omit to keep the proposal's term. */
  term_months: z.number().int().refine((m) => (VO_ALLOWED_TERMS as readonly number[]).includes(m), {
    message: `Term must be one of ${VO_ALLOWED_TERMS.join(", ")} months`,
  }).optional(),
  /** The rate: the term fee up to 12 months, the ANNUAL rate above. Omit to quote the current card guide. */
  quoted_price: z.number().positive().optional(),
  /** Rate card purpose; taken from the existing price snapshot when omitted. */
  purpose: z.enum(VO_RATE_PURPOSES).optional(),
  /** Required when the new price is below the floor. */
  below_floor_reason: z.string().trim().min(5, "Say why this quote is below the floor").max(500).optional(),
});

/**
 * POST /api/proposals/[id]/reprice  (Virtual Office DRAFT proposals only)
 *
 * Re-prices the draft in place against the current rate card (term fee = annual rate x months / 12
 * above 12 months). Blocked once the proposal is sent or later: those use Reissue. Sends nothing
 * to the customer and touches no contract or billing.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { data: actor } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!actor || !ROLES.includes(actor.role)) {
    return NextResponse.json({ error: "You don't have permission to re-price a proposal." }, { status: 403 });
  }
  if (!(await voProposalColumnsPresent())) return NextResponse.json({ error: VO_PROPOSAL_NOT_READY }, { status: 503 });

  const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });

  const admin = createAdminClient();
  const { data: old } = await admin.from("proposals").select("*").eq("id", id).single();
  if (!old) return NextResponse.json({ error: "Proposal not found" }, { status: 404 });

  const blocked = voRepriceBlockedReason(old);
  if (blocked) return NextResponse.json({ error: blocked }, { status: 409 });

  const term: number | null = parsed.data.term_months ?? old.vo_term_months ?? null;
  const purpose = parsed.data.purpose ?? (old.vo_price_snapshot?.purpose as string | undefined);
  if (!term) return NextResponse.json({ error: "Choose a term (12, 24, 36 or 48 months) first." }, { status: 400 });
  if (!purpose) return NextResponse.json({ error: "Choose the purpose (GST new or GST existing) so the rate card price can be looked up." }, { status: 400 });

  // First price against the card to learn the guide, then re-price at the requested rate (default: the guide).
  const probe = await priceVoQuote(admin, { purpose, locationId: old.location_id ?? null, termMonths: term, quotedRate: null });
  if (!probe.setUp) return NextResponse.json({ error: "Rate cards are not set up yet." }, { status: 503 });
  if (!probe.result.ok) return NextResponse.json({ error: probe.result.message }, { status: 422 });
  const rate = parsed.data.quoted_price ?? probe.result.guide;
  const priced = await priceVoQuote(admin, { purpose, locationId: old.location_id ?? null, termMonths: term, quotedRate: rate });
  if (!priced.setUp || !priced.result.ok) return NextResponse.json({ error: "Could not price this quote." }, { status: 422 });
  if (priced.result.quote?.requiresApproval && !parsed.data.below_floor_reason) {
    return NextResponse.json({ error: "This quote is below the floor price. Add a reason so a manager can approve it." }, { status: 400 });
  }

  const snapshot = buildDirectSnapshot(priced.result);
  const t = voRepricedTotals(rate, term, Number(old.tax_percentage ?? 0), Number(old.discount_percentage ?? 0));
  const update = {
    items: t.items,
    subtotal: t.subtotal,
    tax_amount: t.taxAmount,
    discount_amount: t.discountAmount,
    total_amount: t.total,
    vo_term_months: term,
    vo_quoted_price: rate,
    vo_guide_price: priced.result.guide,
  };
  // Compare-and-set on draft so a send that lands meanwhile wins.
  let { data: saved, error } = await admin
    .from("proposals")
    .update({ ...update, vo_price_snapshot: snapshot })
    .eq("id", id)
    .eq("status", "draft")
    .select("id")
    .maybeSingle();
  // Deployed before migration 00688: save without the snapshot column rather than fail.
  if (error && isMissingColumn(error)) {
    ({ data: saved, error } = await admin.from("proposals").update(update).eq("id", id).eq("status", "draft").select("id").maybeSingle());
  }
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!saved) return NextResponse.json({ error: "This proposal changed while you were re-pricing it. Refresh and check before trying again." }, { status: 409 });

  if (snapshot.requires_approval) {
    const approval = await requestFloorApproval(admin, {
      proposalId: id,
      proposalNumber: old.proposal_number,
      requestedBy: actor.id,
      reason: parsed.data.below_floor_reason ?? "",
      snapshot,
      locationId: old.location_id ?? null,
    });
    if ("error" in approval) console.error("[vo-reprice] could not raise below-floor approval:", approval.error);
    else {
      logAudit(supabase, {
        entityType: "proposal",
        entityId: id,
        action: "update",
        performedBy: actor.id,
        changes: { vo_floor_approval_requested: { old: null, new: approval.id } },
      });
    }
  }

  logAudit(supabase, {
    entityType: "proposal",
    entityId: id,
    action: "update",
    performedBy: actor.id,
    changes: {
      action: { old: null, new: "vo_repriced" },
      vo_quoted_price: { old: old.vo_quoted_price, new: rate },
      vo_term_months: { old: old.vo_term_months, new: term },
      vo_guide_price: { old: old.vo_guide_price, new: priced.result.guide },
      total_amount: { old: old.total_amount, new: t.total },
    },
  });

  return NextResponse.json({ data: { id, quoted_price: rate, term_months: term, total_amount: t.total, requires_approval: snapshot.requires_approval } });
}
