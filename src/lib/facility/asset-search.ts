/** Columns a word typed into the asset search may match, in any of them. */
export const ASSET_SEARCH_COLUMNS = ["name", "asset_code", "serial_number", "mac_address", "make", "model"] as const;

/**
 * Splits what was typed into words; an asset must match every word, each in any column, so
 * "hvac 68" finds an HVAC whose serial holds 68. Characters PostgREST reads as filter syntax
 * are treated as word breaks rather than passed through.
 */
export function assetSearchTerms(input: string): string[] {
  return input
    .replace(/[,()*\\%]/g, " ")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 6);
}

/** The PostgREST `or` filter that matches one word against every searchable column. */
export function assetTermFilter(term: string): string {
  return ASSET_SEARCH_COLUMNS.map((c) => `${c}.ilike.%${term}%`).join(",");
}
