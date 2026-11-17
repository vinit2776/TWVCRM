// Phone numbers are saved however they were typed ("98765 43210", "+91-98765-43210"), so a plain
// ilike on what the user searched misses them whenever the spacing differs. When a search term
// looks like a phone number we also match on its digits, allowing any separators in between.

const PHONE_LIKE = /^[\d\s+\-().]+$/;
const MIN_DIGITS = 4;

/** Digits to look for, or null when the term does not look like a phone number. */
export function phoneSearchDigits(term: string): string | null {
  const trimmed = term.trim();
  if (!PHONE_LIKE.test(trimmed)) return null;
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length < MIN_DIGITS) return null;
  // A country code or trunk prefix ("+91…", "0…") is often missing from the saved number.
  return digits.length > 10 ? digits.slice(-10) : digits;
}

/** PostgREST `or()` clauses matching the digits across any separators, for each column. */
export function phoneMatchClauses(term: string, columns: string[]): string[] {
  const digits = phoneSearchDigits(term);
  if (!digits) return [];
  const pattern = digits.split("").join("[^0-9]*");
  return columns.map((col) => `${col}.match.${pattern}`);
}
