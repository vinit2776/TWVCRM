/**
 * Shared "suspect line" heuristic for transfer approval.
 *
 * Used by both the transfer detail API route (to enforce that flagged lines
 * were explicitly reviewed before a transfer can be approved) and the
 * transfer detail page (to highlight the same lines in the approve table).
 * Kept in one place so the two never drift out of sync.
 */

export interface TransferLineIntel {
  consumption_30d: number;
  usage_per_head: number | null;
  usage_per_head_prev_month: number | null;
}

export interface TransferLineFlag {
  suspect: boolean;
  reason: string | null;
}

// Requesting more than this multiple of what was actually consumed in the
// trailing 30 days is worth a second look.
const REQUEST_VS_CONSUMPTION_MULTIPLE = 1.5;
// Usage/head jumping by more than this multiple month-over-month is worth
// a second look.
const USAGE_PER_HEAD_JUMP_MULTIPLE = 1.5;

export function flagTransferLine(
  requestedQty: number,
  intel: TransferLineIntel | undefined
): TransferLineFlag {
  if (!intel) {
    return { suspect: true, reason: "No consumption history — verify manually" };
  }

  if (intel.consumption_30d > 0 && requestedQty > intel.consumption_30d * REQUEST_VS_CONSUMPTION_MULTIPLE) {
    const multiple = requestedQty / intel.consumption_30d;
    return { suspect: true, reason: `Requesting ${multiple.toFixed(1)}x recent 30-day usage` };
  }

  if (intel.consumption_30d === 0 && requestedQty > 0) {
    return { suspect: true, reason: "No consumption history — verify manually" };
  }

  if (
    intel.usage_per_head !== null &&
    intel.usage_per_head_prev_month !== null &&
    intel.usage_per_head_prev_month > 0 &&
    intel.usage_per_head > intel.usage_per_head_prev_month * USAGE_PER_HEAD_JUMP_MULTIPLE
  ) {
    const multiple = intel.usage_per_head / intel.usage_per_head_prev_month;
    return { suspect: true, reason: `Usage/head up ${multiple.toFixed(1)}x vs last month` };
  }

  return { suspect: false, reason: null };
}
