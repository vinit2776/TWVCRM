/**
 * The most one bill may be for, before GST. A service PO (AMC) is billed per cycle, so
 * its limit is the cycle cost, not the whole contract value; the server enforces the same
 * thing, and the form should say so before the user hits Save.
 */
export function billAmountCeiling(po: {
  po_type?: string | null;
  total_ordered_amount?: number | string | null;
  unit_cost_per_cycle?: number | string | null;
}): number | null {
  const cycle = Number(po.unit_cost_per_cycle ?? 0);
  const value = po.po_type === "service" && cycle > 0 ? cycle : Number(po.total_ordered_amount ?? 0);
  return value > 0 ? value : null;
}
