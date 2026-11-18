import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { rateCardPurposeFor, computeVoPricing, computeAggregatorCasePricing, buildDirectSnapshot } from "@/lib/vo-pricing";
import { loadDirectRates, loadAggregatorRates, isMissingColumn } from "@/lib/vo-pricing-server";
import { voCaseRepriceBlockedReason } from "@/lib/vo-case-reprice";

const ROLES = ["admin", "manager", "sales_rep"];

const bodySchema = z.object({
  /** Same unit as the case rate: the term fee up to 12 months, the ANNUAL rate above. Omit to use the current card guide (direct) or keep the current rate (aggregator). */
  quoted_rate: z.number().positive().optional(),
});

/**
 * POST /api/cases/[id]/reprice  (Virtual Office cases, before invoicing)
 *
 * Re-prices the case against the current rate card: refreshes the frozen price snapshot and, for a
 * direct case, sets the rate (default: today's guide). Blocked once the case is invoiced, an invoice
 * exists, or the agreement has gone to the customer. Sends and invoices nothing.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { data: actor } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!actor || !ROLES.includes(actor.role)) {
    return NextResponse.json({ error: "You don't have permission to re-price a case." }, { status: 403 });
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });

  const admin = createAdminClient();
  const { data: c } = await admin
    .from("cases")
    .select("id, status, purpose, rate, tenure_months, location_id, aggregator_id")
    .eq("id", id)
    .maybeSingle();
  if (!c) return NextResponse.json({ error: "Case not found" }, { status: 404 });

  const [{ data: invoices }, { data: agreements }] = await Promise.all([
    admin.from("billing_statements").select("id").eq("case_id", id).eq("statement_type", "vo_case").is("voided_at", null).limit(1),
    admin.from("case_agreements").select("status").eq("case_id", id),
  ]);
  const cardPurpose = rateCardPurposeFor(c.purpose);
  const blocked = voCaseRepriceBlockedReason({
    status: c.status,
    hasLiveInvoice: (invoices ?? []).length > 0,
    agreementStatuses: (agreements ?? []).map((a) => a.status as string),
    cardPurpose,
  });
  if (blocked || !cardPurpose) return NextResponse.json({ error: blocked }, { status: 409 });

  const locationId = c.location_id ?? null;
  let snapshot: Record<string, unknown>;
  let rate: number | null = c.rate != null ? Number(c.rate) : null;

  if (c.aggregator_id) {
    const card = await loadAggregatorRates(admin, c.aggregator_id);
    if (!card.hasCard) return NextResponse.json({ error: "This aggregator has no rate card to re-price against." }, { status: 409 });
    rate = parsed.data.quoted_rate ?? rate;
    const priced = computeAggregatorCasePricing({ purpose: cardPurpose, locationId, termMonths: c.tenure_months, customerRate: rate, rows: card.rows });
    if (!priced.ok) return NextResponse.json({ error: priced.message }, { status: 422 });
    snapshot = priced.snapshot;
  } else {
    const card = await loadDirectRates(admin);
    if (!card.setUp) return NextResponse.json({ error: "Rate cards are not set up yet." }, { status: 503 });
    const probe = computeVoPricing({ purpose: cardPurpose, locationId, termMonths: c.tenure_months, rows: card.rows });
    if (!probe.ok) return NextResponse.json({ error: probe.message }, { status: 422 });
    rate = parsed.data.quoted_rate ?? probe.guide;
    const priced = computeVoPricing({ purpose: cardPurpose, locationId, termMonths: c.tenure_months, rows: card.rows, quotedRate: rate });
    if (!priced.ok) return NextResponse.json({ error: priced.message }, { status: 422 });
    snapshot = buildDirectSnapshot(priced);
  }

  // Compare-and-set on status so a case that moves on meanwhile is not re-priced under it.
  const { data: saved, error } = await admin
    .from("cases")
    .update({ rate, price_snapshot: snapshot })
    .eq("id", id)
    .eq("status", c.status)
    .select("id")
    .maybeSingle();
  if (error) {
    if (isMissingColumn(error)) return NextResponse.json({ error: "Rate card snapshots are not set up yet on this database." }, { status: 503 });
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!saved) return NextResponse.json({ error: "This case changed while you were re-pricing it. Refresh and try again." }, { status: 409 });

  logAudit(supabase, {
    entityType: "case",
    entityId: id,
    action: "update",
    performedBy: actor.id,
    changes: {
      action: { old: null, new: "vo_case_repriced" },
      rate: { old: c.rate, new: rate },
    },
  });

  return NextResponse.json({ data: { id, rate, requires_approval: snapshot.requires_approval ?? false, below_minimum: snapshot.below_minimum ?? false } });
}
