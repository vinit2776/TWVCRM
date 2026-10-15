import { formatCurrency } from "@/lib/utils";

export type CheckKey = "rent" | "usage" | "electricity" | "deposit" | "addon";
export type CheckTone = "ok" | "warn" | "info";
export interface WizardCheck {
  tone: CheckTone;
  text: string;
  /** Rent only: nothing here can be opened for invoicing, so the card should only offer the list. */
  nothingToOpen?: boolean;
}

// Loose shapes: these are advisory hints read from existing GET routes, so a
// field that's missing or renamed degrades to "no hint" rather than an error.
export type RentRow = {
  /** Stable queue key — the same id the billing page's rent list uses. */
  id?: string;
  contractId: string;
  category: string;
  periodLabel: string;
  statementId?: string;
  backfillTarget?: { month: number; year: number };
  gapMonth?: string;
  amount?: number | null;
  estimate?: { total: number } | null;
};
export type UsageMonth = { label: string; canSend: boolean; block: string | null; alreadyInvoiced: string | null; total: number };
export type UsageGroup = { contractId: string; months: UsageMonth[]; total: number };
export type ElecBill = { status: string; bill_month: number; bill_year: number };

const monthOf = (periodLabel: string) => periodLabel.split(" · ")[0];

/**
 * Rows the rent list lets someone invoice in one click: a missed month that
 * may be billed directly, or this cycle's draft. Mirrors the "Send invoice" and
 * "Review & send" buttons in unbilled-billed-tabs.tsx.
 */
export function actionableRentRows(rows: RentRow[]): RentRow[] {
  return rows.filter((r) => !!r.backfillTarget || (r.category === "current_cycle" && !!r.statementId));
}

export function rentCheck(rows: RentRow[]): WizardCheck {
  const mine = rows.filter((r) => r.category !== "renewal_drift" && r.category !== "no_renewal");
  const nothingToOpen = actionableRentRows(mine).length === 0;
  const gaps = mine.filter((r) => r.category === "rent_gap");
  if (gaps.length > 0) {
    return { tone: "warn", nothingToOpen, text: `${gaps.length} month${gaps.length === 1 ? "" : "s"} not invoiced: ${gaps.map((g) => monthOf(g.periodLabel)).join(", ")}` };
  }
  const draft = mine.find((r) => r.category === "current_cycle");
  if (draft) return { tone: "info", nothingToOpen, text: `${monthOf(draft.periodLabel)} draft is ready to review and send` };
  const tally = mine.find((r) => r.category === "current_cycle_tally");
  if (tally) return { tone: "info", nothingToOpen, text: `${monthOf(tally.periodLabel)} is with accounts (Tally Inbox)` };
  const sent = mine.find((r) => r.category === "current_cycle_sent");
  if (sent) return { tone: "ok", nothingToOpen, text: `${monthOf(sent.periodLabel)} rent is already sent` };
  return { tone: "ok", nothingToOpen, text: "Nothing to invoice. Rent is up to date." };
}

/** Label for one row in the month picker. */
export function rentRowLabel(row: RentRow): string {
  return monthOf(row.periodLabel);
}

export function usageCheck(group: UsageGroup | undefined): WizardCheck {
  if (!group || group.months.length === 0) return { tone: "info", text: "No unbilled usage right now" };
  const locked = group.months.find((m) => m.block === "accounting_locked");
  if (locked) return { tone: "warn", text: `${locked.label} is locked in accounting. Charges dated then can't be invoiced.` };
  const ready = group.months.filter((m) => m.canSend);
  if (ready.length > 0) {
    return { tone: "info", text: `Already waiting: ${ready.map((m) => `${m.label} ${formatCurrency(m.total)}`).join(", ")}` };
  }
  const open = group.months.find((m) => m.block === "open_month");
  if (open) return { tone: "info", text: `${open.label} usage can be sent once the month ends` };
  return { tone: "info", text: "Unbilled usage exists but isn't ready to send" };
}

export function electricityCheck(configured: boolean, bills: ElecBill[], monthLabel: string): WizardCheck {
  if (!configured) {
    return { tone: "warn", text: "Electricity billing isn't set up for this contract. Set it up in its Electricity section first." };
  }
  if (bills.some((b) => b.status === "invoiced")) return { tone: "warn", text: `${monthLabel} is already invoiced. Capturing again may double-bill.` };
  if (bills.length > 0) return { tone: "info", text: `A draft bill for ${monthLabel} already exists` };
  return { tone: "info", text: `No ${monthLabel} bill captured yet` };
}
