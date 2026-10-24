import type { SupabaseClient } from "@supabase/supabase-js";
import { loadJourney } from "./load";
import type { Journey } from "./types";

// A journey only counts as "open" if its contract or proposal started recently.
// Older rows are historical; chasing them from a dashboard would be noise.
const CANDIDATE_WINDOW_DAYS = 120;
const MAX_CANDIDATES = 60;
const CONCURRENCY = 6;
const CACHE_MS = 60_000;

export interface OpenJourney {
  leadId: string;
  customer: string;
  /** Contract number if there is a live contract, else the proposal number. */
  ref: string;
  /** Contract id when there is one; alerts dedupe on this. */
  contractId: string | null;
  /** When this customer's contract/proposal started, or activation time for a live contract. */
  since: string;
  /** ISO activation time, if activated. */
  activatedAt: string | null;
  /** The lead's assigned rep, if any. */
  assignedTo: string | null;
  journey: Journey;
}

type Row = Record<string, unknown>;

let cache: { at: number; rows: OpenJourney[] } | null = null;

function customerName(l: Row | undefined): string {
  if (!l) return "Customer";
  const company = (l.company as string | null)?.trim();
  if (company) return company;
  return `${(l.first_name as string) ?? ""} ${(l.last_name as string) ?? ""}`.trim() || "Customer";
}

async function pool<T, R>(items: T[], size: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx]);
      }
    }),
  );
  return out;
}

/**
 * Journeys that are still in progress and recent enough to chase. Read-only.
 * Memoised for a minute because every dashboard load of every user asks for it
 * and each journey costs a handful of queries.
 */
export async function listOpenJourneys(admin: SupabaseClient): Promise<OpenJourney[]> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.rows;

  const since = new Date(Date.now() - CANDIDATE_WINDOW_DAYS * 86_400_000).toISOString();

  const [contractsRes, proposalsRes] = await Promise.all([
    admin
      .from("contracts")
      .select("id, contract_number, lead_id, status, created_at, activated_at, lead:leads(company, first_name, last_name, assigned_to)")
      .in("status", ["draft", "sent", "viewed", "accepted", "active"])
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(MAX_CANDIDATES),
    admin
      .from("proposals")
      .select("id, proposal_number, lead_id, status, created_at, lead:leads(company, first_name, last_name)")
      .in("status", ["draft", "sent", "viewed", "accepted"])
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(MAX_CANDIDATES),
  ]);

  const contracts = (contractsRes.data ?? []) as unknown as Row[];
  const proposals = (proposalsRes.data ?? []) as unknown as Row[];

  interface Candidate {
    leadId: string;
    customer: string;
    ref: string;
    contractId: string | null;
    proposalId: string | null;
    since: string;
    activatedAt: string | null;
    assignedTo: string | null;
  }
  const candidates: Candidate[] = [];
  const leadsWithContract = new Set<string>();
  for (const c of contracts) {
    leadsWithContract.add(c.lead_id as string);
    candidates.push({
      leadId: c.lead_id as string,
      customer: customerName(c.lead as Row | undefined),
      ref: c.contract_number as string,
      contractId: c.id as string,
      proposalId: null,
      since: ((c.activated_at as string) ?? (c.created_at as string)),
      activatedAt: (c.activated_at as string) ?? null,
      assignedTo: ((c.lead as Row | undefined)?.assigned_to as string) ?? null,
    });
  }
  // A proposal only gets its own entry while its lead has no live contract;
  // after that the contract's journey already covers it.
  for (const p of proposals) {
    if (leadsWithContract.has(p.lead_id as string)) continue;
    candidates.push({
      leadId: p.lead_id as string,
      customer: customerName(p.lead as Row | undefined),
      ref: p.proposal_number as string,
      contractId: null,
      proposalId: p.id as string,
      since: p.created_at as string,
      activatedAt: null,
      assignedTo: null,
    });
  }

  const loaded = await pool(candidates.slice(0, MAX_CANDIDATES), CONCURRENCY, async (c) => {
    try {
      const journey = await loadJourney(admin, c.leadId, { contractId: c.contractId, proposalId: c.proposalId });
      return journey && !journey.complete
        ? ({ leadId: c.leadId, customer: c.customer, ref: c.ref, contractId: c.contractId, since: c.since, activatedAt: c.activatedAt, assignedTo: c.assignedTo, journey } as OpenJourney)
        : null;
    } catch (err) {
      console.error("[journey] open-journeys load failed", c.leadId, err);
      return null;
    }
  });

  const rows = loaded.filter((r): r is OpenJourney => r !== null);
  cache = { at: Date.now(), rows };
  return rows;
}
