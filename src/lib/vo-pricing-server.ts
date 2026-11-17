import type { SupabaseClient } from "@supabase/supabase-js";
import { isMissingTable } from "@/lib/vo-rates-db";
import { computeTrend, type DirectRateRow, type QuoteOutcome, type Trend } from "@/lib/vo-rates";
import { computeVoPricing, buildDirectSnapshot, type VoPricingResult } from "@/lib/vo-pricing";
import type { AggregatorRateRow } from "@/lib/vo-aggregator-rates";

export const VO_FLOOR_APPROVAL_TYPE = "vo_below_floor";
const TREND_WINDOW_DAYS = 180;

/** Postgres 42703 (unknown column) or PostgREST's schema cache miss: the migration is not applied yet. */
export function isMissingColumn(error: { code?: string; message?: string } | null | undefined): boolean {
  if (!error) return false;
  return error.code === "42703" || error.code === "PGRST204" || /column .* does not exist|could not find the .* column/i.test(error.message ?? "");
}

/** Current direct-card rows. `setUp: false` while the rate card migrations are not applied. */
export async function loadDirectRates(admin: SupabaseClient): Promise<{ setUp: boolean; rows: DirectRateRow[] }> {
  const { data, error } = await admin
    .from("vo_direct_rates")
    .select("id, purpose, location_id, guide_fee, floor_fee, default_term_months, version")
    .eq("is_current", true);
  if (isMissingTable(error)) return { setUp: false, rows: [] };
  if (error) throw new Error(error.message);
  return { setUp: true, rows: (data ?? []) as DirectRateRow[] };
}

/** Current rows of one aggregator's card; `hasCard` is false when the aggregator has none (or no table yet). */
export async function loadAggregatorRates(admin: SupabaseClient, aggregatorId: string): Promise<{ hasCard: boolean; rows: AggregatorRateRow[] }> {
  const { data, error } = await admin
    .from("vo_aggregator_rates")
    .select("id, aggregator_id, purpose, location_id, pricing_type, share_percent, min_customer_price, fixed_rate, version")
    .eq("aggregator_id", aggregatorId)
    .eq("is_current", true);
  if (isMissingTable(error)) return { hasCard: false, rows: [] };
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as AggregatorRateRow[];
  return { hasCard: rows.length > 0, rows };
}

/**
 * Win/loss hint from recent VO quotes at the same location. Proposals carry no purpose, so this
 * mixes both purposes; the UI labels it that way. Never throws: a hint must not block quoting.
 */
export async function loadWinTrend(admin: SupabaseClient, locationId: string | null, now: Date = new Date()): Promise<Trend | null> {
  try {
    let q = admin
      .from("proposals")
      .select("vo_quoted_price, status, created_at")
      .eq("kind", "virtual_office")
      .in("status", ["accepted", "declined", "expired"])
      .not("vo_quoted_price", "is", null)
      .gte("created_at", new Date(now.getTime() - TREND_WINDOW_DAYS * 86_400_000).toISOString());
    if (locationId) q = q.eq("location_id", locationId);
    const { data, error } = await q.limit(500);
    if (error || !data) return null;
    const outcomes: QuoteOutcome[] = data.map((p) => ({
      price: Number(p.vo_quoted_price),
      outcome: p.status === "accepted" ? "won" : p.status === "declined" ? "lost" : "expired",
      at: p.created_at as string,
    }));
    return outcomes.length ? computeTrend(outcomes, TREND_WINDOW_DAYS, now) : null;
  } catch {
    return null;
  }
}

export type VoPriceOutcome = { setUp: false } | { setUp: true; result: VoPricingResult };

/** Load the card and price one VO quote. `setUp: false` means the rate card tables are not migrated yet. */
export async function priceVoQuote(
  admin: SupabaseClient,
  input: { purpose: string; locationId: string | null; termMonths: number; quotedRate: number | null },
): Promise<VoPriceOutcome> {
  const { setUp, rows } = await loadDirectRates(admin);
  if (!setUp) return { setUp: false };
  const trend = await loadWinTrend(admin, input.locationId);
  return { setUp: true, result: computeVoPricing({ ...input, rows, trend }) };
}

export { buildDirectSnapshot };

interface FloorApprovalRow {
  id: string;
  status: string;
  rejection_reason: string | null;
  metadata: { quoted_rate?: number; term_months?: number } | null;
}

export async function latestFloorApproval(admin: SupabaseClient, proposalId: string): Promise<FloorApprovalRow | null> {
  const { data, error } = await admin
    .from("approval_requests")
    .select("id, status, rejection_reason, metadata")
    .eq("entity_type", "proposal")
    .eq("entity_id", proposalId)
    .eq("approval_type", VO_FLOOR_APPROVAL_TYPE)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) return null;
  return (data as FloorApprovalRow | null) ?? null;
}

interface SnapshotShape {
  requires_approval?: boolean;
  quoted_rate?: number | null;
  term_months?: number;
  guide_rate?: number;
  floor_rate?: number | null;
}

/**
 * Why a VO proposal may not be sent yet, or null. Only a quote below the floor is gated, and only
 * an approval for exactly this rate and term clears it. Pre-migration proposals have no snapshot
 * and are never blocked.
 */
export async function voSendBlockedReason(
  admin: SupabaseClient,
  proposal: { id: string; kind?: string | null; vo_price_snapshot?: SnapshotShape | null },
): Promise<string | null> {
  if (proposal.kind !== "virtual_office") return null;
  const snap = proposal.vo_price_snapshot;
  if (!snap?.requires_approval) return null;
  const approval = await latestFloorApproval(admin, proposal.id);
  const matches = approval && Number(approval.metadata?.quoted_rate) === Number(snap.quoted_rate) && Number(approval.metadata?.term_months) === Number(snap.term_months);
  if (!approval || !matches) return "This quote is below the floor price. Request manager approval before sending it.";
  if (approval.status === "pending") return "This quote is below the floor price and is waiting for manager or admin approval.";
  if (approval.status === "rejected") return `The below-floor price was rejected${approval.rejection_reason ? `: ${approval.rejection_reason}` : ""}. Change the price or reissue the proposal.`;
  if (approval.status !== "approved") return "The below-floor approval has expired. Request it again before sending.";
  return null;
}

/**
 * Raise (or re-raise) the below-floor approval through the existing approval_requests flow.
 * Any older pending request for the proposal is expired so only the current price is decided.
 */
export async function requestFloorApproval(
  admin: SupabaseClient,
  input: {
    proposalId: string;
    proposalNumber: string | null;
    requestedBy: string;
    reason: string;
    snapshot: SnapshotShape & { guide_rate: number; floor_rate: number | null; quoted_rate: number | null };
    locationId: string | null;
  },
): Promise<{ id: string } | { error: string }> {
  await admin
    .from("approval_requests")
    .update({ status: "expired" })
    .eq("entity_type", "proposal")
    .eq("entity_id", input.proposalId)
    .eq("approval_type", VO_FLOOR_APPROVAL_TYPE)
    .eq("status", "pending");
  const { data, error } = await admin
    .from("approval_requests")
    .insert({
      approval_type: VO_FLOOR_APPROVAL_TYPE,
      entity_type: "proposal",
      entity_id: input.proposalId,
      entity_reference: input.proposalNumber,
      requested_by: input.requestedBy,
      reason: input.reason,
      metadata: {
        quoted_rate: input.snapshot.quoted_rate,
        term_months: input.snapshot.term_months,
        guide_rate: input.snapshot.guide_rate,
        floor_rate: input.snapshot.floor_rate,
        location_id: input.locationId,
      },
    })
    .select("id")
    .single();
  if (error || !data) return { error: error?.message ?? "Could not create the approval request" };
  return { id: data.id as string };
}
