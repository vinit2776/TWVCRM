/**
 * An AMC is meant to cover an item the business already has, so the contract normally
 * starts once the item is received. This is only a heads-up: nothing is blocked and the
 * AMC's status is unchanged, because contracts that began before they were entered here
 * are recorded the same way.
 */
const NOT_RECEIVED = ["pending", "ordered", "partially_received"];

export const AMC_NOT_RECEIVED_WARNING =
  "Item not received yet — an AMC normally covers an item that has been received.";

export function amcNotReceived(po: { status: string; amc_terminated_at?: string | null }): boolean {
  return !po.amc_terminated_at && NOT_RECEIVED.includes(po.status);
}

export interface AssetForAmc {
  id?: string;
  name?: string | null;
  asset_code?: string | null;
  serial_number?: string | null;
  location_id?: string | null;
}

/** What an asset still lacks before an AMC on it is fully set up. Warn only; never blocks. */
export function assetGaps(asset: AssetForAmc): string[] {
  const gaps: string[] = [];
  if (!asset.name?.trim()) gaps.push("name");
  if (!asset.serial_number?.trim()) gaps.push("serial number");
  if (!asset.location_id) gaps.push("location");
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
