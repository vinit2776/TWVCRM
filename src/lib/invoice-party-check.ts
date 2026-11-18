/**
 * Checks that an uploaded GST invoice is addressed to the customer the
 * statement belongs to. Both checks read the PDF's text, so they only answer
 * when the text was readable: `null` always means "could not tell", never
 * "mismatch" — callers must not block on it.
 */

const GSTIN_G = /\b(\d{2}[A-Z]{5}\d{4}[A-Z]\d[A-Z\d]{2})\b/g;

// Legal-form words are dropped so "ABC Pvt. Ltd." matches "ABC Private Limited".
const LEGAL_WORDS = new Set([
  "pvt", "private", "ltd", "limited", "llp", "inc", "incorporated", "co", "company", "corp", "corporation", "the", "m", "s", "ms",
]);

export function normalizePartyName(s: string): string {
  return s
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t && !LEGAL_WORDS.has(t))
    .join(" ");
}

export function extractGstins(text: string): string[] {
  return [...new Set([...text.toUpperCase().matchAll(GSTIN_G)].map((m) => m[1]))];
}

/**
 * True when any candidate name appears in the invoice text: as a phrase, or
 * with every one of its words present (survives a name wrapped over lines).
 * Null when there is no name to look for or the text is empty.
 */
export function partyNameInText(text: string, candidates: Array<string | null | undefined>): boolean | null {
  const names = candidates.map((c) => normalizePartyName(c ?? "")).filter(Boolean);
  const haystack = normalizePartyName(text);
  if (!names.length || !haystack) return null;
  const words = new Set(haystack.split(" "));
  return names.some((n) => haystack.includes(n) || n.split(" ").every((w) => words.has(w)));
}

/**
 * True when the customer's CRM GSTIN is printed on the invoice. Tally prints
 * the seller's GSTIN as well, so "any GSTIN found, but not ours" is the signal.
 * Null when the customer has no GSTIN or the text shows no GSTIN at all.
 */
export function partyGstinInText(text: string, crmGstin: string | null | undefined): boolean | null {
  const wanted = crmGstin?.trim().toUpperCase();
  if (!wanted) return null;
  const found = extractGstins(text);
  if (!found.length) return null;
  return found.includes(wanted);
}
