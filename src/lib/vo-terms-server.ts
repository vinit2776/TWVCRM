import type { SupabaseClient } from "@supabase/supabase-js";
import { scaleForTerm } from "@/lib/vo-rates";
import {
  VO_TERMS_MODE_KEY,
  assembleVoTerms,
  holdoverApprovedIn,
  parseTermsMode,
  type AssembleVoTermsInput,
  type AssembledVoTerms,
  type LibraryClause,
  type VoTermsMode,
  type VoTermsSnapshot,
} from "@/lib/vo-terms-assemble";

// Deploy precedes the hand-applied migrations, so a missing table or column is a
// normal state, not a failure (same approach as src/lib/kyc-waiver.ts).
const NOT_MIGRATED = new Set(["42P01", "42703"]);

/** The wiring switch. Any failure reads as off, so nothing changes by accident. */
export async function getVoTermsMode(admin: SupabaseClient): Promise<VoTermsMode> {
  try {
    const { data, error } = await admin.from("app_settings").select("value").eq("key", VO_TERMS_MODE_KEY).maybeSingle();
    if (error) return "off";
    return parseTermsMode(data?.value);
  } catch {
    return "off";
  }
}

/** Current version of every clause with its ids, or null when the library is not set up yet. */
export async function loadLibraryClauses(admin: SupabaseClient): Promise<LibraryClause[] | null> {
  try {
    const { data, error } = await admin
      .from("vo_clause_versions")
      .select(
        "id, clause_id, version, body, documents, purposes, company_types, min_term_months, is_current, approved_at, clause:vo_clauses(code, title)",
      )
      .eq("is_current", true);
    if (error) {
      if (!NOT_MIGRATED.has(error.code ?? "")) console.error("[vo-terms] library load failed:", error.message);
      return null;
    }
    return (data ?? []).map((row) => {
      const r = row as unknown as Omit<LibraryClause, "code" | "title"> & {
        clause: { code: string; title: string } | { code: string; title: string }[] | null;
      };
      const clause = Array.isArray(r.clause) ? r.clause[0] : r.clause;
      const { clause: _joined, ...rest } = r;
      void _joined;
      return { ...rest, code: clause?.code ?? "?", title: clause?.title };
    });
  } catch (err) {
    console.error("[vo-terms] library load threw:", err);
    return null;
  }
}

/**
 * Has legal approved the holdover clause (T13)? The address watch must not draft
 * holdover proforma invoices until this is true. Not-set-up and errors read as false.
 */
export async function isHoldoverClauseApproved(admin: SupabaseClient): Promise<boolean> {
  const clauses = await loadLibraryClauses(admin);
  return !!clauses && holdoverApprovedIn(clauses);
}

/** Approved renewal and notice clauses for a case, for the renewal reminder text. Empty when not set up. */
export async function loadRenewalNoticeClauses(
  admin: SupabaseClient,
  input: Omit<AssembleVoTermsInput, "clauses" | "document">,
): Promise<AssembledVoTerms | null> {
  const clauses = await loadLibraryClauses(admin);
  if (!clauses) return null;
  return assembleVoTerms({ ...input, clauses, document: "renewal" });
}

interface ProposalForTerms {
  vo_term_months: number | null;
  vo_quoted_price: number | string | null;
  vo_price_snapshot?: { purpose?: string | null } | null;
  lead?: { entity_type?: string | null; company?: string | null; first_name?: string | null; last_name?: string | null } | null;
}

/** Assemble the proposal terms for a VO proposal row. Null when the library is not set up. */
export async function assembleProposalTerms(admin: SupabaseClient, p: ProposalForTerms): Promise<AssembledVoTerms | null> {
  const clauses = await loadLibraryClauses(admin);
  if (!clauses) return null;
  const term = p.vo_term_months ?? 12;
  const rate = p.vo_quoted_price != null ? Number(p.vo_quoted_price) : null;
  const lead = p.lead;
  const customer = lead?.company || `${lead?.first_name ?? ""} ${lead?.last_name ?? ""}`.trim() || null;
  return assembleVoTerms({
    clauses,
    document: "proposal",
    purpose: p.vo_price_snapshot?.purpose ?? null,
    companyType: lead?.entity_type ?? null,
    termMonths: term,
    billing: { kind: "direct", name: customer },
    customerName: customer,
    fee: rate != null && Number.isFinite(rate) ? scaleForTerm(rate, term) : null,
  });
}

interface CaseForTerms {
  purpose: string | null;
  client_entity_type: string | null;
  client_name: string | null;
  client_company_name?: string | null;
  tenure_months: number | null;
  rate: number | string | null;
  start_date: string | null;
  end_date: string | null;
  case_source?: string | null;
  aggregator?: { name?: string | null; company_name?: string | null } | null;
  bill_to?: string | null;
}

/** Assemble the agreement terms for a VO case. Null when the library is not set up. */
export async function assembleCaseAgreementTerms(admin: SupabaseClient, c: CaseForTerms): Promise<AssembledVoTerms | null> {
  const clauses = await loadLibraryClauses(admin);
  if (!clauses) return null;
  const term = c.tenure_months ?? 12;
  const rate = c.rate != null ? Number(c.rate) : null;
  const customer = c.client_company_name || c.client_name || null;
  const viaAggregator = c.case_source === "aggregator";
  const aggName = c.aggregator?.company_name || c.aggregator?.name || null;
  const billedToAggregator = viaAggregator && c.bill_to !== "client";
  return assembleVoTerms({
    clauses,
    document: "agreement",
    purpose: c.purpose,
    companyType: c.client_entity_type,
    termMonths: term,
    billing: { kind: viaAggregator ? "aggregator" : "direct", name: billedToAggregator ? aggName : customer },
    customerName: customer,
    // Per the rate rule, a term over 12 months stores the ANNUAL rate.
    fee: rate != null && Number.isFinite(rate) ? scaleForTerm(rate, term) : null,
    startDate: c.start_date,
    endDate: c.end_date,
  });
}

/** True for the Postgres codes that mean "migration not applied yet". */
export function isNotMigrated(code: string | undefined | null): boolean {
  return NOT_MIGRATED.has(code ?? "");
}

/**
 * Terms to print in a VO case agreement, or null when the wiring is off, the library is
 * not set up, or no approved clause applies (so the agreement is exactly as before).
 */
export async function termsForCaseAgreement(
  admin: SupabaseClient,
  c: CaseForTerms & { aggregator_id?: string | null },
): Promise<AssembledVoTerms | null> {
  if ((await getVoTermsMode(admin)) !== "on") return null;
  let aggregator = c.aggregator ?? null;
  if (!aggregator && c.aggregator_id) {
    const { data } = await admin.from("aggregators").select("name, company_name").eq("id", c.aggregator_id).maybeSingle();
    aggregator = data ?? null;
  }
  const terms = await assembleCaseAgreementTerms(admin, { ...c, aggregator });
  return terms && terms.clauses.length > 0 ? terms : null;
}

const PROPOSAL_TERMS_SELECT =
  "id, kind, vo_term_months, vo_quoted_price, vo_price_snapshot, lead:leads!proposals_lead_id_fkey(entity_type, company, first_name, last_name)";

/**
 * On send: freeze the terms this VO proposal goes out with. No-op unless the wiring is on.
 * Never throws and never blocks the send; a missing column (migration 00690 pending) is a quiet skip.
 * Returns the snapshot written, or null.
 */
export async function snapshotProposalTermsOnSend(admin: SupabaseClient, proposalId: string): Promise<VoTermsSnapshot | null> {
  try {
    if ((await getVoTermsMode(admin)) !== "on") return null;
    const { data } = await admin.from("proposals").select(PROPOSAL_TERMS_SELECT).eq("id", proposalId).maybeSingle();
    if (!data || data.kind !== "virtual_office") return null;
    const terms = await assembleProposalTerms(admin, data as unknown as ProposalForTerms);
    if (!terms || terms.clauses.length === 0) return null;
    const { error } = await admin.from("proposals").update({ vo_terms_snapshot: terms.snapshot }).eq("id", proposalId);
    if (error) {
      if (!NOT_MIGRATED.has(error.code ?? "")) console.error("[vo-terms] proposal snapshot failed:", error.message);
      return null;
    }
    return terms.snapshot;
  } catch (err) {
    console.error("[vo-terms] proposal snapshot threw:", err);
    return null;
  }
}

export { PROPOSAL_TERMS_SELECT };
