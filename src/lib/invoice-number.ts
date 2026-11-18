/**
 * Compares two invoice numbers the way a person reads them: case, spaces and
 * dash/slash variants (hyphen, en dash, a mobile keyboard's "smart" punctuation)
 * are ignored, so "SD/A/26–27/467" and "sd/a/26-27/467 " are the same number.
 * Used for the retype-to-confirm step on both client and server.
 */
export function normalizeInvoiceNumber(v: string): string {
  return v.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function sameInvoiceNumber(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = normalizeInvoiceNumber(a ?? "");
  return x.length > 0 && x === normalizeInvoiceNumber(b ?? "");
}
