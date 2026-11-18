import { rateCardPurposeFor } from "@/lib/vo-pricing";
import {
  assembleTerms,
  fillPlaceholders,
  isApproved,
  type VoClauseVersion,
} from "@/lib/vo-terms";

/**
 * Wiring of the central terms library into the Virtual Office flow (W2-5).
 * Pure: the callers load the library and the case or proposal, this decides
 * which clauses go out and what they say.
 */

export const VO_TERMS_MODE_KEY = "vo_terms_library_mode";
export type VoTermsMode = "off" | "on";

/** Anything but an explicit "on" is off, so a missing or odd setting changes nothing. */
export function parseTermsMode(value: unknown): VoTermsMode {
  return typeof value === "string" && value.trim().toLowerCase() === "on" ? "on" : "off";
}

/** A library row as the loaders return it: the version row plus its ids. */
export interface LibraryClause extends VoClauseVersion {
  /** vo_clause_versions.id */
  id?: string;
  clause_id?: string;
}

export interface TermsBillingParty {
  kind: "direct" | "aggregator";
  /** Who the fee is billed to, for {billed_party}. */
  name?: string | null;
}

export interface AssembleVoTermsInput {
  clauses: LibraryClause[];
  document: "proposal" | "agreement" | "renewal";
  /** Case or proposal purpose; the legacy values map through rateCardPurposeFor. */
  purpose: string | null | undefined;
  companyType: string | null | undefined;
  termMonths: number;
  billing: TermsBillingParty;
  customerName?: string | null;
  /** Whole-term fee in rupees, when known. */
  fee?: number | null;
  /** ISO dates (YYYY-MM-DD). */
  startDate?: string | null;
  endDate?: string | null;
  feeRule?: string | null;
}

export interface TermsWarning {
  code: string;
  title?: string;
  kind: "unapproved" | "unmapped_purpose" | "placeholder";
  message: string;
}

export interface SnapshotClause {
  code: string;
  version: number;
  version_id: string | null;
  clause_id: string | null;
  text: string;
}

export interface VoTermsSnapshot {
  schema: 1;
  document: string;
  purpose: string | null;
  company_type: string | null;
  term_months: number;
  billing_party: "direct" | "aggregator";
  clauses: SnapshotClause[];
}

export interface AssembledVoTerms {
  clauses: SnapshotClause[];
  /** Plain text of the included clauses, one paragraph each. */
  text: string;
  snapshot: VoTermsSnapshot;
  warnings: TermsWarning[];
}

const fmtInr = (n: number) =>
  `Rs. ${new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 }).format(n)}`;

function fmtDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });
}

/** Extra placeholders beyond the library's own {term} and {fee_rule}. */
function extraValues(input: AssembleVoTermsInput): Record<string, string | null> {
  return {
    fee: input.fee != null && Number.isFinite(input.fee) ? fmtInr(input.fee) : null,
    start_date: fmtDate(input.startDate),
    end_date: fmtDate(input.endDate),
    customer_name: input.customerName?.trim() || null,
    billed_party: input.billing.name?.trim() || null,
  };
}

const EXTRA_RE = /\{(fee|start_date|end_date|customer_name|billed_party)\}/g;

/** Fill the extra placeholders; one with no value is left visible and reported. */
function fillExtras(body: string, values: Record<string, string | null>): { text: string; missing: string[] } {
  const missing: string[] = [];
  const text = body.replace(EXTRA_RE, (match, name: string) => {
    const v = values[name];
    if (!v) {
      missing.push(name);
      return match;
    }
    return v;
  });
  return { text, missing };
}

/**
 * Select the APPROVED, applicable clauses in code order and render them. A clause
 * that applies but is not approved is never included; it is reported so staff know
 * what is missing. Nothing here throws on bad library data: problems are warnings.
 */
export function assembleVoTerms(input: AssembleVoTermsInput): AssembledVoTerms {
  const purpose = rateCardPurposeFor(input.purpose);
  const warnings: TermsWarning[] = [];
  const companyType = input.companyType || "other";

  const snapshotBase: Omit<VoTermsSnapshot, "clauses"> = {
    schema: 1,
    document: input.document,
    purpose: purpose ?? input.purpose ?? null,
    company_type: input.companyType ?? null,
    term_months: input.termMonths,
    billing_party: input.billing.kind,
  };

  if (!purpose) {
    warnings.push({
      code: "-",
      kind: "unmapped_purpose",
      message: `No terms apply to purpose "${input.purpose ?? "unknown"}". Only GST new and GST existing have a terms library.`,
    });
    return { clauses: [], text: "", snapshot: { ...snapshotBase, clauses: [] }, warnings };
  }

  const current = input.clauses.filter((c) => c.is_current);
  const byKey = new Map(current.map((c) => [`${c.code}:${c.version}`, c]));
  const common = { document: input.document, purpose, companyType, termMonths: input.termMonths };

  const unapproved = assembleTerms({ ...common, clauses: current.filter((c) => !isApproved(c)), values: {} });
  for (const line of unapproved.snapshot) {
    const c = byKey.get(`${line.code}:${line.version}`);
    warnings.push({
      code: line.code,
      title: c?.title,
      kind: "unapproved",
      message: `${line.code}${c?.title ? ` (${c.title})` : ""} applies but legal has not approved it, so it is left out.`,
    });
  }

  const extras = extraValues(input);
  const approved = current.filter(isApproved);
  const assembled = assembleTerms({
    ...common,
    clauses: approved,
    values: { term: input.termMonths, fee_rule: input.feeRule ?? null },
  });
  // assembleTerms already filled {term}/{fee_rule} and kept unfilled ones visible; its
  // errors cover those. The extras are filled here on the rendered text.
  for (const e of assembled.errors) {
    if (/Unknown placeholder \{(fee|start_date|end_date|customer_name|billed_party)\}/.test(e)) continue;
    warnings.push({ code: e.split(":")[0], kind: "placeholder", message: e });
  }

  const clauses: SnapshotClause[] = assembled.lines.map((line) => {
    const src = byKey.get(`${line.code}:${line.version}`);
    const { text, missing } = fillExtras(line.text, extras);
    for (const name of missing) {
      warnings.push({ code: line.code, kind: "placeholder", message: `${line.code}: No value for placeholder {${name}}` });
    }
    // A stray placeholder neither list knows is reported too, not silently printed.
    const leftover = fillPlaceholders(text, {}).errors
      .filter((e) => e.startsWith("Unknown placeholder") && !/\{(fee|start_date|end_date|customer_name|billed_party)\}/.test(e))
      .map((e) => `${line.code}: ${e}`);
    for (const e of leftover) if (!warnings.some((w) => w.message === e)) warnings.push({ code: line.code, kind: "placeholder", message: e });
    return {
      code: line.code,
      version: line.version,
      version_id: src?.id ?? null,
      clause_id: src?.clause_id ?? null,
      text,
    };
  });

  return {
    clauses,
    text: renderTermsText(clauses),
    snapshot: { ...snapshotBase, clauses },
    warnings,
  };
}

/** One paragraph per clause, blank line between. */
export function renderTermsText(clauses: Array<{ text: string }>): string {
  return clauses.map((c) => c.text.trim()).filter(Boolean).join("\n\n");
}

/**
 * Join the case's approved special clause and the library terms into the single
 * special_clause_text the agreement template already prints. With no terms the
 * clause comes back untouched, so mode off is byte-identical.
 */
export function composeSpecialClause(caseClause: string | null | undefined, termsText: string | null | undefined): string | null {
  const clause = caseClause?.trim() ? caseClause : null;
  const terms = termsText?.trim() ? termsText.trim() : null;
  if (!terms) return clause;
  if (!clause) return terms;
  return `${clause.trimEnd()}\n\n${terms}`;
}

/** Approved renewal-document clauses (notice, offer, fee, KYC), for renewal reminder text. */
export function approvedRenewalClauses(
  clauses: LibraryClause[],
  input: Omit<AssembleVoTermsInput, "clauses" | "document">,
): AssembledVoTerms {
  return assembleVoTerms({ ...input, clauses, document: "renewal" });
}

export const HOLDOVER_CLAUSE_CODE = "T13";

/** True once legal has approved the current version of the holdover clause. */
export function holdoverApprovedIn(clauses: LibraryClause[]): boolean {
  return clauses.some((c) => c.code === HOLDOVER_CLAUSE_CODE && c.is_current && isApproved(c));
}
