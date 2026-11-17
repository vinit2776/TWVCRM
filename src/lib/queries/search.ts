/**
 * Smart text search over a query thread, as a pure function so the matching
 * rules are unit-testable (src/lib/__tests__/queries-search.test.ts).
 *
 * Every word the reader types has to be found *somewhere* on the thread, but
 * not necessarily in the same field: "acme 17700 priya" finds the thread about
 * Acme's ₹17,700 statement that Priya was asked about. Matching ignores case,
 * accents, currency symbols and thousands separators.
 */

export type SearchPart = string | number | null | undefined;

const CURRENCY_NOISE = /[₹$]|\brs\b\.?|\binr\b/g;
// "17,700" -> "17700", but leave "a, b" alone.
const THOUSANDS_COMMA = /(\d),(?=\d{3}(?!\d))/g;

export function normalizeSearchText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(CURRENCY_NOISE, " ")
    .replace(THOUSANDS_COMMA, "$1")
    .replace(THOUSANDS_COMMA, "$1");
}

/** The words a search needle is made of, normalized; empty words dropped. */
export function searchTokens(needle: string): string[] {
  return normalizeSearchText(needle).split(/\s+/).filter(Boolean);
}

/** One searchable blob from everything worth finding a thread by. */
export function buildSearchBlob(parts: readonly SearchPart[]): string {
  return normalizeSearchText(
    parts
      .filter((p): p is string | number => p !== null && p !== undefined && p !== "")
      .map(String)
      .join(" \n "),
  );
}

export function matchesSearchTokens(blob: string, tokens: readonly string[]): boolean {
  return tokens.every((t) => blob.includes(t));
}
