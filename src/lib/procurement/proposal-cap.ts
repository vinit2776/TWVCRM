/**
 * An AMC set up from a vendor proposal may be agreed lower than the proposal, never higher.
 * The ceiling is the proposal's contract total for that asset line, before GST, stored on
 * the request line when the request is created and carried forward on every later edit.
 */

/** Rupees of rounding allowed, so a proposal that splits unevenly into bills still passes. */
export const PROPOSAL_CAP_TOLERANCE = 1;

/**
 * The whole contract's value for a line: the cycles billed here plus any settled before
 * this system (a running contract), times the cost of one cycle.
 */
export function lineContractTotal(quantity: number, openingCycles: number, perCycleCost: number): number {
  return Math.round((quantity + Math.max(0, openingCycles)) * perCycleCost * 100) / 100;
}

export function exceedsProposalCap(
  line: { quantity: number; perCycleCost: number; cap: number | null | undefined },
  openingCycles: number
): boolean {
  if (line.cap == null) return false;
  return lineContractTotal(line.quantity, openingCycles, line.perCycleCost) > line.cap + PROPOSAL_CAP_TOLERANCE;
}

export function proposalCapMessage(cap: number): string {
  return `The value can be lowered from the proposal but not raised. This line is capped at ₹${cap.toLocaleString("en-IN")} before GST.`;
}
