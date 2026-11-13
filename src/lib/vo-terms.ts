import type { ENTITY_TYPES, VO_TERM_DOCUMENTS, VO_TERM_PURPOSES } from "@/lib/constants";

export type VoTermDocument = (typeof VO_TERM_DOCUMENTS)[number];
export type VoTermPurpose = (typeof VO_TERM_PURPOSES)[number];
export type VoTermCompanyType = (typeof ENTITY_TYPES)[number];

/** A clause joined with one of its versions. */
export interface VoClauseVersion {
  code: string;
  title?: string;
  version: number;
  body: string;
  documents: string[];
  purposes: string[];
  company_types: string[];
  min_term_months: number | null;
  is_current: boolean;
  approved_at?: string | null;
}

export interface SnapshotEntry {
  code: string;
  version: number;
}

export interface TermLine extends SnapshotEntry {
  text: string;
}

export interface AssembledTerms {
  lines: TermLine[];
  snapshot: SnapshotEntry[];
  /** Current clauses that do not apply to this document, purpose, company type or term. */
  excluded: number;
  errors: string[];
}

export interface TermValues {
  term?: number | string | null;
  fee_rule?: string | null;
}

const KNOWN_PLACEHOLDERS = ["term", "fee_rule"] as const;
const PLACEHOLDER_RE = /\{([^{}]*)\}/g;

/**
 * Replace {term} and {fee_rule}. An unknown or unfilled placeholder is reported,
 * never blanked: the placeholder text stays in the result so it cannot go out
 * looking finished.
 */
export function fillPlaceholders(
  body: string,
  values: TermValues,
): { text: string; errors: string[] } {
  const errors: string[] = [];
  const text = body.replace(PLACEHOLDER_RE, (match, rawName: string) => {
    const name = rawName.trim();
    if (!(KNOWN_PLACEHOLDERS as readonly string[]).includes(name)) {
      errors.push(`Unknown placeholder {${name}}`);
      return match;
    }
    const value = values[name as (typeof KNOWN_PLACEHOLDERS)[number]];
    if (value === undefined || value === null || String(value).trim() === "") {
      errors.push(`No value for placeholder {${name}}`);
      return match;
    }
    return String(value).trim();
  });
  return { text, errors };
}

/** Legal has signed off a version once approved_at is set. */
export function isApproved(version: Pick<VoClauseVersion, "approved_at">): boolean {
  return !!version.approved_at;
}

function appliesTo(
  v: VoClauseVersion,
  document: string,
  purpose: string,
  companyType: string,
  termMonths: number,
): boolean {
  if (!v.is_current) return false;
  if (!v.documents.includes(document)) return false;
  if (!v.purposes.includes(purpose)) return false;
  if (!v.company_types.includes(companyType)) return false;
  if (v.min_term_months !== null && termMonths < v.min_term_months) return false;
  return true;
}

export function assembleTerms(input: {
  clauses: VoClauseVersion[];
  document: string;
  purpose: string;
  companyType: string;
  termMonths: number;
  values: TermValues;
}): AssembledTerms {
  const { clauses, document, purpose, companyType, termMonths, values } = input;
  const current = clauses.filter((c) => c.is_current);
  const matched = current
    .filter((c) => appliesTo(c, document, purpose, companyType, termMonths))
    .sort((a, b) => a.code.localeCompare(b.code, "en", { numeric: true }));

  const errors: string[] = [];
  const lines: TermLine[] = matched.map((c) => {
    const filled = fillPlaceholders(c.body, { ...values, term: values.term ?? termMonths });
    for (const e of filled.errors) errors.push(`${c.code}: ${e}`);
    return { code: c.code, version: c.version, text: filled.text };
  });

  return {
    lines,
    snapshot: matched.map((c) => ({ code: c.code, version: c.version })),
    excluded: current.length - matched.length,
    errors,
  };
}

export function diffSnapshots(
  a: SnapshotEntry[],
  b: SnapshotEntry[],
): { changed: string[]; added: string[]; removed: string[] } {
  const am = new Map(a.map((s) => [s.code, s.version]));
  const bm = new Map(b.map((s) => [s.code, s.version]));
  const changed: string[] = [];
  const added: string[] = [];
  const removed: string[] = [];
  for (const [code, version] of bm) {
    if (!am.has(code)) added.push(code);
    else if (am.get(code) !== version) changed.push(code);
  }
  for (const code of am.keys()) if (!bm.has(code)) removed.push(code);
  return { changed: changed.sort(), added: added.sort(), removed: removed.sort() };
}
