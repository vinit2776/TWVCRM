import type { SupabaseClient } from "@supabase/supabase-js";

/** Labels that already mean "this is the purchase invoice", from before doc_kind existed. */
export const INVOICE_LABELS = ["Purchase Invoice", "Tax Invoice"];

export function isInvoiceDoc(doc: { doc_kind?: string | null; label?: string | null }): boolean {
  return doc.doc_kind === "invoice" || INVOICE_LABELS.includes(doc.label ?? "");
}

/**
 * Which of these assets have a purchase invoice attached. Uses the service client on
 * purpose: commercial documents are hidden from some roles by RLS, and a role that
 * cannot see the file must still not be told "missing" when it exists. Returns ids only,
 * or null when the lookup failed, so callers show no flag rather than a false one.
 */
export async function assetIdsWithInvoice(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  admin: SupabaseClient<any, any, any>,
  assetIds: string[]
): Promise<Set<string> | null> {
  if (assetIds.length === 0) return new Set();
  const { data, error } = await admin
    .from("asset_documents")
    .select("asset_id, doc_kind, label")
    .in("asset_id", assetIds)
    .or(`doc_kind.eq.invoice,label.in.(${INVOICE_LABELS.map((l) => `"${l}"`).join(",")})`);
  if (error) {
    console.error("[asset invoice] lookup failed:", error.message);
    return null;
  }
  return new Set((data ?? []).map((d) => d.asset_id as string));
}
