/**
 * Customer Value — the scoring run: load, snapshot, score, store.
 *
 * One entry point used by the nightly cron, the admin backfill and the
 * per-customer Recompute. Reads CRM records and writes only the two snapshot
 * tables (`customer_value_monthly`, `customer_value_scores`); it sends nothing
 * to any customer. Dry-run (`write: false`) is the default everywhere.
 *
 * Scoring ranks each customer against the others at their center, so whenever
 * scores are wanted every customer is loaded, even if only one is written.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchAllPages } from "@/lib/customer-value/query-helpers";
import { contractRan } from "@/lib/customer-value/journey";
import { monthStart } from "@/lib/customer-value/monthly-metrics";
import { loadMarginsByLead } from "@/lib/customer-value/margin-load";
import { loadCustomers } from "@/lib/customer-value/snapshot-load";
import { buildMonthlyRecords, upsertInChunks, type RefreshSummary } from "@/lib/customer-value/snapshot-refresh";
import {
  historyDates,
  scoreCustomersAt,
  toScoreRecord,
  type RunCustomer,
  type ScoreRecord,
} from "@/lib/customer-value/scoring-run";
import { SCORING_SETTINGS_KEY, loadSettings } from "@/lib/customer-value/scoring-settings-store";

export type ScoresMode = "none" | "latest" | "history";

export interface ScoresRefreshOptions {
  write: boolean;
  /** none = monthly figures only; latest = also today's score; history = also every month end. */
  scores: ScoresMode;
  /** Customers to write for. Null means everyone. Scoring always uses everyone as the comparison group. */
  writeLeadIds: string[] | null;
}

export interface ScoresRefreshResult {
  wrote: boolean;
  customers: number;
  monthlyRows: number;
  scoreRows: number;
  graded: number;
  notEnoughData: number;
  tiers: Record<string, number>;
  settingsVersion: string;
  warnings: string[];
  summaries: RefreshSummary[];
  /** The newest score per written customer, for callers that report it. */
  latest: Map<string, ScoreRecord>;
}

/** Every customer that has at least one contract, in a stable order. */
export async function listCustomerIds(supabase: SupabaseClient): Promise<string[]> {
  const rows = await fetchAllPages<{ id: string; lead_id: string }>("contracts", (from, to) =>
    supabase.from("contracts").select("id, lead_id").order("id").range(from, to).returns<Array<{ id: string; lead_id: string }>>()
  );
  return [...new Set(rows.map((r) => r.lead_id))].sort();
}

export async function refreshScores(
  supabase: SupabaseClient,
  today: string,
  options: ScoresRefreshOptions
): Promise<ScoresRefreshResult> {
  const computedAt = new Date().toISOString();
  const warnings: string[] = [];

  const { data: settingRow } = await supabase.from("app_settings").select("value").eq("key", SCORING_SETTINGS_KEY).maybeSingle();
  const { settings, version, warning } = loadSettings((settingRow as { value?: string } | null)?.value ?? null);
  if (warning) warnings.push(warning);

  const wantScores = options.scores !== "none";
  const allIds = wantScores || options.writeLeadIds === null ? await listCustomerIds(supabase) : [];
  const writeIds = options.writeLeadIds ?? allIds;
  const loadIds = wantScores ? allIds : writeIds;

  const assembled = await loadCustomers(supabase, loadIds);
  const { records: monthly, summaries } = buildMonthlyRecords(assembled, writeIds, today, computedAt);

  const scoreRecords: ScoreRecord[] = [];
  const latest = new Map<string, ScoreRecord>();
  const tiers: Record<string, number> = {};
  let graded = 0;
  let notEnoughData = 0;

  if (wantScores) {
    // Margin is only read when it is switched on: off, scoring makes no extra query and nothing changes.
    const margins = settings.margin.enabled ? await loadMarginsByLead(supabase) : null;
    const customers: RunCustomer[] = loadIds
      .map((id) => assembled.get(id))
      .filter((c): c is NonNullable<typeof c> => Boolean(c))
      .map((c) => ({ leadId: c.leadId, raw: c.raw, locationIds: c.locationIds, ticketLinkCoverage: c.ticketLinkCoverage, ...(margins ? { margins: margins.get(c.leadId) ?? [] } : {}) }));

    // Each customer's first month, so history does not create rows for months before they existed.
    const firstMonth = new Map<string, string>();
    for (const c of customers) {
      const starts = c.raw.contracts.filter(contractRan).map((x) => x.start_date).sort();
      if (starts[0]) firstMonth.set(c.leadId, monthStart(starts[0]));
    }
    const earliest = [...firstMonth.values()].sort()[0];
    const dates = options.scores === "history" && earliest ? historyDates(earliest, today) : [today];

    const scored = scoreCustomersAt(customers, dates, settings);
    const writeSet = new Set(writeIds);
    for (const [leadId, list] of scored) {
      if (!writeSet.has(leadId)) continue;
      const first = firstMonth.get(leadId);
      for (const s of list) {
        if (first && monthStart(s.asOf) < first) continue; // before the customer existed
        const rec = toScoreRecord(s, version, computedAt);
        scoreRecords.push(rec);
        if (s.asOf === today) {
          latest.set(leadId, rec);
          if (rec.status === "graded") {
            graded += 1;
            tiers[rec.tier as string] = (tiers[rec.tier as string] ?? 0) + 1;
          } else notEnoughData += 1;
        }
      }
    }
  }

  if (options.write) {
    await upsertInChunks(supabase, "customer_value_monthly", monthly, "lead_id,month");
    await upsertInChunks(supabase, "customer_value_scores", scoreRecords, "lead_id,as_of");
  }

  return {
    wrote: options.write,
    customers: writeIds.length,
    monthlyRows: monthly.length,
    scoreRows: scoreRecords.length,
    graded,
    notEnoughData,
    tiers,
    settingsVersion: version,
    warnings,
    summaries,
    latest,
  };
}
