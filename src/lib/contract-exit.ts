/**
 * Pure rules for the contract exit workflow. No I/O so they can be unit-tested.
 */

export const EXIT_CHARGE_TYPES = ["breakage", "painting", "missing_item", "extra_use", "other"] as const;
export type ExitChargeType = (typeof EXIT_CHARGE_TYPES)[number];

export const EXIT_CHARGE_TYPE_LABELS: Record<ExitChargeType, string> = {
  breakage: "Breakage",
  painting: "Painting",
  missing_item: "Missing item",
  extra_use: "Extra use",
  other: "Other",
};

/** Who may start an exit, record notice and edit its dates. */
export const EXIT_START_ROLES = ["admin", "manager", "sales_rep"] as const;
/** Who may add, edit or remove inspection charges. */
export const EXIT_CHARGE_ROLES = ["admin", "manager", "sales_rep", "floor_manager"] as const;
/** Who may complete (terminate) an exit or cancel one. */
export const EXIT_COMPLETE_ROLES = ["admin", "manager"] as const;

const DAY_MS = 86_400_000;
const IST_OFFSET_MS = 5.5 * 3_600_000;

/** Calendar date (YYYY-MM-DD) of an instant as seen in IST. */
export function istDateOf(d: Date): string {
  return new Date(d.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** An exit is early when the last day is before the contract's own end date. */
export function isEarlyExit(lastDay: string, contractEndDate: string | null): boolean {
  return !!contractEndDate && lastDay < contractEndDate.slice(0, 10);
}

/** Whole days between two YYYY-MM-DD dates (to - from). */
export function daysBetween(from: string, to: string): number {
  return Math.round((new Date(`${to}T00:00:00Z`).getTime() - new Date(`${from}T00:00:00Z`).getTime()) / DAY_MS);
}

export interface ExitDatesCheck { ok: true }
export interface ExitDatesError { ok: false; error: string }

export function validateExitDates(noticeOn: string, lastDay: string): ExitDatesCheck | ExitDatesError {
  const ymd = /^\d{4}-\d{2}-\d{2}$/;
  if (!ymd.test(noticeOn) || !ymd.test(lastDay)) return { ok: false, error: "Enter valid dates." };
  if (lastDay < noticeOn) return { ok: false, error: "The last day can't be before the notice date." };
  return { ok: true };
}

/** The last day has arrived (in IST): the exit can be completed. */
export function canCompleteOn(lastDay: string, now: Date): boolean {
  return istDateOf(now) >= lastDay;
}

export interface SettlementInput {
  depositAvailable: number;
  charges: number;
  unpaidInvoices: number;
  unbilledUsage: number;
}

export interface Settlement extends SettlementInput {
  /** Total the customer owes TWV against the deposit. */
  totalDeductions: number;
  /** Positive: refund due to the customer. */
  refund: number;
  /** Positive: the customer owes this much after the deposit is used up. */
  customerOwes: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export function computeSettlement(i: SettlementInput): Settlement {
  const totalDeductions = round2(i.charges + i.unpaidInvoices + i.unbilledUsage);
  const net = round2(i.depositAvailable - totalDeductions);
  return {
    ...i,
    totalDeductions,
    refund: net > 0 ? net : 0,
    customerOwes: net < 0 ? round2(-net) : 0,
  };
}
