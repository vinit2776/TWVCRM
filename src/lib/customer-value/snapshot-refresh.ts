/**
 * Customer Value — computing and storing monthly snapshots.
 *
 * `refreshMonthlyRows` loads a batch of customers, builds their monthly figures
 * as known today, and (only when told to write) upserts them into
 * `customer_value_monthly`. Dry-run is the default at every level: nothing is
 * written unless the caller passes `write: true`. Reads and writes only
 * snapshot tables and their sources; it sends nothing to anyone.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { buildMonthlyRows } from "@/lib/customer-value/monthly-metrics";
import { loadCustomers } from "@/lib/customer-value/snapshot-load";
import { toMonthlyRecord, type AssembledCustomer, type MonthlyRecord } from "@/lib/customer-value/snapshot-assemble";

const UPSERT_CHUNK = 500;

export interface RefreshSummary {
  leadId: string;
  months: number;
  firstMonth: string | null;
  lastMonth: string | null;
  ticketsLinked: number;
  ticketLinkCoverage: number | null;
}

export interface RefreshResult {
  wrote: boolean;
  summaries: RefreshSummary[];
  totalMonths: number;
}

/** The monthly records for these customers, built from already-loaded data. */
export function buildMonthlyRecords(
  customers: Map<string, AssembledCustomer>,
  leadIds: string[],
  today: string,
  computedAt: string
): { records: MonthlyRecord[]; summaries: RefreshSummary[] } {
  const records: MonthlyRecord[] = [];
  const summaries: RefreshSummary[] = [];
  for (const leadId of leadIds) {
    const customer = customers.get(leadId);
    if (!customer) continue;
    const rows = buildMonthlyRows(customer.raw, today);
    for (const row of rows) records.push(toMonthlyRecord(leadId, row, customer.ticketLinkCoverage, computedAt));
    summaries.push({
      leadId,
      months: rows.length,
      firstMonth: rows[0]?.month ?? null,
      lastMonth: rows[rows.length - 1]?.month ?? null,
      ticketsLinked: rows.reduce((n, r) => n + r.tickets_linked, 0),
      ticketLinkCoverage: customer.ticketLinkCoverage,
    });
  }
  return { records, summaries };
}

/** Upserts records in chunks; throws on the first failure so a partial write is never reported as done. */
export async function upsertInChunks(
  supabase: SupabaseClient,
  table: string,
  records: object[],
  onConflict: string
): Promise<void> {
  for (let i = 0; i < records.length; i += UPSERT_CHUNK) {
    const { error } = await supabase.from(table).upsert(records.slice(i, i + UPSERT_CHUNK), { onConflict });
    if (error) throw new Error(`${table} upsert failed: ${error.message}`);
  }
}

export async function refreshMonthlyRows(
  supabase: SupabaseClient,
  leadIds: string[],
  today: string,
  options: { write: boolean } = { write: false }
): Promise<RefreshResult> {
  const customers = await loadCustomers(supabase, leadIds);
  const { records, summaries } = buildMonthlyRecords(customers, leadIds, today, new Date().toISOString());
  if (options.write) await upsertInChunks(supabase, "customer_value_monthly", records, "lead_id,month");
  return { wrote: options.write, summaries, totalMonths: records.length };
}
