import { formatCurrency } from "@/lib/utils";

export type CheckKey = "rent" | "usage" | "electricity" | "deposit" | "addon";
export type CheckTone = "ok" | "warn" | "info";
export interface WizardCheck {
  tone: CheckTone;
  text: string;
}

// Loose shapes: these are advisory hints read from existing GET routes, so a
// field that's missing or renamed degrades to "no hint" rather than an error.
export type RentRow = { contractId: string; category: string; periodLabel: string };
export type UsageMonth = { label: string; canSend: boolean; block: string | null; alreadyInvoiced: string | null; total: number };
export type UsageGroup = { contractId: string; months: UsageMonth[]; total: number };
export type ElecBill = { status: string; bill_month: number; bill_year: number };

const monthOf = (periodLabel: string) => periodLabel.split(" · ")[0];

export function rentCheck(rows: RentRow[]): WizardCheck {
  const mine = rows.filter((r) => r.category !== "renewal_drift" && r.category !== "no_renewal");
  const gaps = mine.filter((r) => r.category === "rent_gap");
  if (gaps.length > 0) {
    return { tone: "warn", text: `${gaps.length} month${gaps.length === 1 ? "" : "s"} not invoiced: ${gaps.map((g) => monthOf(g.periodLabel)).join(", ")}` };
  }
  const draft = mine.find((r) => r.category === "current_cycle");
  if (draft) return { tone: "info", text: `${monthOf(draft.periodLabel)} draft is ready to review and send` };
  const tally = mine.find((r) => r.category === "current_cycle_tally");
  if (tally) return { tone: "info", text: `${monthOf(tally.periodLabel)} is with accounts (Tally Inbox)` };
  const sent = mine.find((r) => r.category === "current_cycle_sent");
  if (sent) return { tone: "ok", text: `${monthOf(sent.periodLabel)} rent is already sent` };
  return { tone: "ok", text: "Nothing to invoice. Rent is up to date." };
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
