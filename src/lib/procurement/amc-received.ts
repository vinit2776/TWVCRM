/**
 * An AMC is meant to cover an item the business already has, so the contract normally
 * starts once the item is received. This is only a heads-up: nothing is blocked and the
 * AMC's status is unchanged, because contracts that began before they were entered here
 * are recorded the same way.
 */
const NOT_RECEIVED = ["pending", "ordered", "partially_received"];

export const AMC_NOT_RECEIVED_WARNING =
  "Item not received yet — an AMC normally covers an item that has been received.";

export function amcNotReceived(po: { status: string; po_type?: string | null; amc_terminated_at?: string | null }): boolean {
  // A service PO has no goods to receive; the asset's own purchase PO carries that check.
  if (po.po_type === "service") return false;
  return !po.amc_terminated_at && NOT_RECEIVED.includes(po.status);
}

/** Where the asset was bought: its purchase PO and how many delivery challans are in. */
export interface AssetPurchasePo {
  id: string;
  po_number: string;
  status: string;
  dc_count: number;
}

const RECEIVED_STATUSES = ["received", "invoice_received", "invoice_approved"];

/** Goods count as received once a delivery challan is logged or the PO is marked received. */
export function purchaseReceived(po: AssetPurchasePo): boolean {
  return po.dc_count > 0 || RECEIVED_STATUSES.includes(po.status);
}

export interface AssetForAmc {
  id?: string;
  name?: string | null;
  asset_code?: string | null;
  serial_number?: string | null;
  location_id?: string | null;
  lifecycle_stage?: string | null;
  procurement_po_id?: string | null;
  /** Filled in by the server from procurement_po_id. */
  purchase_po?: AssetPurchasePo | null;
}

/** What an asset still lacks before an AMC on it is fully set up. Warn only; never blocks. */
export function assetGaps(asset: AssetForAmc): string[] {
  const gaps: string[] = [];
  if (!asset.name?.trim()) gaps.push("name");
  if (!asset.serial_number?.trim()) gaps.push("serial number");
  if (!asset.location_id) gaps.push("location");
  if (asset.purchase_po) {
    if (!purchaseReceived(asset.purchase_po)) {
      gaps.push(`delivery challan not received on ${asset.purchase_po.po_number}`);
    }
  } else if (asset.lifecycle_stage === "procured") {
    // No purchase PO to check (older equipment): the lifecycle stage is the only signal left.
    gaps.push("receipt at the location (stage is still Procured)");
  }
  return gaps;
}

/** Linked assets that are missing details, each with what is missing. */
export function assetsNeedingDetails(assets: AssetForAmc[]): Array<{ asset: AssetForAmc; gaps: string[] }> {
  const seen = new Set<string>();
  const out: Array<{ asset: AssetForAmc; gaps: string[] }> = [];
  for (const asset of assets) {
    const key = asset.id ?? asset.asset_code ?? "";
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    const gaps = assetGaps(asset);
    if (gaps.length) out.push({ asset, gaps });
  }
  return out;
}

/** PO lines that are not linked to an asset: an AMC covers assets, not other purchases. */
export function linesWithoutAsset(
  items: Array<{ item_name?: string | null; linked_asset_id?: string | null; linked_asset?: unknown }>
): string[] {
  return items
    .filter((i) => !i.linked_asset_id && !i.linked_asset)
    .map((i) => i.item_name?.trim() || "Unnamed line");
}

/** Where to record the delivery challan, when the asset's goods are not yet received. */
export function receiptHref(asset: AssetForAmc): string | null {
  const po = asset.purchase_po;
  return po && !purchaseReceived(po) ? `/procurement/orders/${po.id}` : null;
}
