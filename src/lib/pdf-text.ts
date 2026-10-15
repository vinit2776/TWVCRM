/**
 * Text cleaning for jsPDF's built-in "helvetica" font, which only supports
 * WinAnsiEncoding (Latin-1). Free-text fields (terms, notes, descriptions) can
 * contain characters typed or pasted by users, like the rupee sign or smart
 * typography from Word/Docs, that fall outside that range. Left unhandled, a
 * single such character throws off jsPDF's line-width calculation for the whole
 * line it is in, producing stretched-out spacing and clipped or missing text.
 * Sanitize before rendering.
 */
export function sanitizeForPdf(text: string): string {
  return text
    .replace(/₹/g, "Rs.")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/…/g, "...")
    // Bullets (incl. Word's private-use U+F0B7) aren't in the built-in fonts and
    // would otherwise be stripped, leaving terms as an unmarked block of text.
    .replace(/[•●▪◦\uF0B7]/g, "-")
    .replace(/[^\x00-\xFF]/g, "");
}
