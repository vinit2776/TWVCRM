/**
 * Fuzzy string matching for the duplicate-invoice detector.
 *
 * Two metrics implemented:
 *
 *   1. Levenshtein edit distance — number of single-char insert / delete /
 *      substitute operations needed to transform A → B. Cheap, intuitive.
 *
 *   2. similarity() — normalised 0..1 score where 1 = identical and 0 =
 *      completely different. We use it as the human-facing "confidence"
 *      score in the duplicate warning UI.
 */

/**
 * Levenshtein distance between two strings.
 * Time: O(m × n). Space: O(min(m, n)) — we keep only two rows.
 *
 * Returns the minimum number of single-character edits required.
 */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  // Ensure b is the shorter string so the inner array is smaller
  if (a.length < b.length) {
    [a, b] = [b, a];
  }

  let prevRow = Array(b.length + 1).fill(0).map((_, i) => i);
  let curRow = Array(b.length + 1).fill(0);

  for (let i = 1; i <= a.length; i++) {
    curRow[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curRow[j] = Math.min(
        curRow[j - 1] + 1,        // insertion
        prevRow[j] + 1,           // deletion
        prevRow[j - 1] + cost,    // substitution
      );
    }
    [prevRow, curRow] = [curRow, prevRow];
  }
  return prevRow[b.length];
}

/**
 * Similarity score in [0, 1] derived from edit distance.
 *   similarity("INV-001", "INV-001") = 1.0
 *   similarity("INV-001", "INV-002") = 0.857  (1 substitution out of 7 chars)
 *   similarity("ABC", "XYZ")         = 0.0
 *
 * Useful for ranking duplicate candidates from "definitely the same" down
 * to "probably different".
 */
export function similarity(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - levenshtein(a, b) / maxLen;
}

/**
 * Normalise an invoice number for comparison.
 *
 * Strips whitespace, lower-cases, removes leading zeros after separators
 * — so "INV/2026/001" ≈ "inv/2026/1" ≈ " INV/2026/01 " match.
 *
 * Does NOT modify the original — caller can still display the original
 * format. This is only used for matching.
 */
export function normaliseInvoiceNumber(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/0+(\d)/g, "$1");          // collapse leading zeros: 001 → 1
}
