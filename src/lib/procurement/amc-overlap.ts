// An asset can sit on more than one AMC, but two live contracts over the same dates usually
// mean paying twice. This only finds them so the user can decide; it never blocks.

export interface AmcConflict {
  kind: "po" | "request";
  id: string;
  /** PO number or request number. */
  number: string;
  vendor: string | null;
  start: string;
  end: string;
}

/** Whether two inclusive ISO date ranges (YYYY-MM-DD) share at least one day. */
export function datesOverlap(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  return aStart <= bEnd && bStart <= aEnd;
}
