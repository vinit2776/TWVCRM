import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { revisionProposalNumber } from "@/lib/proposal-revision";
import { voProposalColumnsPresent, VO_PROPOSAL_NOT_READY, proposalPiPaymentBlock, retireProposalPayments } from "@/lib/vo-proposal-server";
import { VO_REISSUABLE, VO_ALLOWED_TERMS, termFee, voReissueBlockedReason } from "@/lib/vo-proposal";

const ROLES = ["admin", "manager", "sales_rep"];

const bodySchema = z.object({
  term_months: z.number().int().refine((m) => (VO_ALLOWED_TERMS as readonly number[]).includes(m), {
    message: `Term must be one of ${VO_ALLOWED_TERMS.join(", ")} months`,
  }).optional(),
  /** The rate: the term fee up to 12 months, the ANNUAL rate above 12. */
  quoted_price: z.number().positive().optional(),
  note: z.string().trim().max(500).optional(),
});

/**
 * POST /api/proposals/[id]/reissue  (Virtual Office proposals only)
 *
 * Creates the next version (PROP-0231 -> PROP-0231-R2) as a DRAFT with zero
 * deposit, and marks the old one `superseded`, using the same revision columns
 * as POST /api/proposals/[id]/revise. The old customer link stops working and
 * its payment demands are cancelled. Staff send the new draft the usual way;
 * that send starts its fresh 7-day validity and fresh payment links.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { data: actor } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!actor || !ROLES.includes(actor.role)) {
    return NextResponse.json({ error: "You don't have permission to reissue a proposal." }, { status: 403 });
  }
  if (!(await voProposalColumnsPresent())) return NextResponse.json({ error: VO_PROPOSAL_NOT_READY }, { status: 503 });

  const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });

  const admin = createAdminClient();
  const { data: old } = await admin.from("proposals").select("*").eq("id", id).single();
  if (!old) return NextResponse.json({ error: "Proposal not found" }, { status: 404 });

  const blocked = voReissueBlockedReason(old);
  if (blocked) return NextResponse.json({ error: blocked }, { status: 409 });
  const piBlock = await proposalPiPaymentBlock(admin, id);
  if (piBlock) return NextResponse.json({ error: piBlock }, { status: 409 });

  const term = parsed.data.term_months ?? old.vo_term_months ?? null;
  const rate = parsed.data.quoted_price ?? (old.vo_quoted_price != null ? Number(old.vo_quoted_price) : null);
  const repriced = parsed.data.term_months !== undefined || parsed.data.quoted_price !== undefined;

  // Re-price the single VO line only when staff changed the term or the rate;
  // otherwise the old content carries over untouched.
  let items = old.items;
  let subtotal = Number(old.subtotal);
  if (repriced && term && rate != null) {
    const fee = termFee(rate, term);
    items = [{ description: `Virtual Office, ${term} months`, quantity: 1, unit: "term", unit_price: fee, total: fee }];
    subtotal = fee;
  }
  const taxAmount = subtotal * (Number(old.tax_percentage) / 100);
  const discountAmount = subtotal * (Number(old.discount_percentage || 0) / 100);

  const nextRevision = Number(old.revision_number ?? 1) + 1;
  const newNumber = revisionProposalNumber(old.proposal_number, Number(old.revision_number ?? 1));

  const { data: revision, error: insertErr } = await admin
    .from("proposals")
    .insert({
      lead_id: old.lead_id,
      location_id: old.location_id,
      title: old.title,
      description: old.description,
      items,
      subtotal,
      tax_percentage: old.tax_percentage,
      tax_amount: taxAmount,
      discount_percentage: old.discount_percentage,
      discount_amount: discountAmount,
      total_amount: subtotal + taxAmount - discountAmount,
      terms_and_conditions: old.terms_and_conditions,
      notes: parsed.data.note ?? old.notes,
      complimentary_items: old.complimentary_items,
      // VO proposals carry no security deposit and need no OTP waiver.
      security_deposit_months: 0,
      security_deposit_amount: 0,
      deposit_payment_status: "not_required",
      tenure_months: old.tenure_months,
      lock_in_months: old.lock_in_months,
      notice_period_months: old.notice_period_months,
      kind: "virtual_office",
      vo_term_months: term,
      vo_guide_price: old.vo_guide_price,
      vo_quoted_price: rate,
      proposal_number: newNumber,
      status: "draft",
      revision_of: old.id,
      revision_number: nextRevision,
      created_by: actor.id,
    })
    .select("*")
    .single();
  if (insertErr || !revision) {
    if (insertErr?.code === "23505") {
      return NextResponse.json({ error: "This proposal has already been reissued. Refresh to see the latest version." }, { status: 409 });
    }
    return NextResponse.json({ error: insertErr?.message ?? "Failed to create the new version" }, { status: 500 });
  }

  const now = new Date().toISOString();
  const { data: superseded } = await admin
    .from("proposals")
    .update({ status: "superseded", superseded_by: revision.id, superseded_at: now })
    .eq("id", id)
    .in("status", [...VO_REISSUABLE])
    .select("id")
    .maybeSingle();
  if (!superseded) {
    await admin.from("proposals").delete().eq("id", revision.id);
    return NextResponse.json({ error: "This proposal changed while you were reissuing it. Refresh and check before trying again." }, { status: 409 });
  }

  await retireProposalPayments(admin, old, actor.id, `Proposal reissued as ${newNumber}`);

  logAudit(supabase, {
    entityType: "proposal",
    entityId: id,
    action: "update",
    performedBy: actor.id,
    changes: {
      action: { old: null, new: "superseded_by_reissue" },
      status: { old: old.status, new: "superseded" },
      superseded_by: { old: null, new: revision.id },
    },
  });
  logAudit(supabase, {
    entityType: "proposal",
    entityId: revision.id,
    action: "create",
    performedBy: actor.id,
    changes: { record: { old: null, new: revision }, revision_of: { old: null, new: id } },
  });

  return NextResponse.json({ data: revision }, { status: 201 });
}
