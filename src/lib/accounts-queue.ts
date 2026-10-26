import { AGING_ESCALATE_HOURS } from "@/lib/tally-handoff";

/**
 * Pure helpers behind the accounts work-queue dashboard. Kept free of fetch and
 * React so the lateness rules — the part that decides what turns red — can be
 * tested on their own.
 *
 * "Overdue" and "due today" are the only two urgencies a queue item can have.
 * Anything not yet worth acting on (a bill due next month, a TDS month still
 * weeks out) never becomes an item at all.
 */

export type QueueType = "inv" | "pay" | "qry" | "ven" | "pet" | "tds";
export type QueueUrgency = "overdue" | "today";

export interface QueueItem {
  key: string;
  type: QueueType;
  title: string;
  subtitle: string;
  href: string;
  urgency: QueueUrgency;
  /** Whole days past the reference date. 0 for "today" items. */
  daysLate: number;
  /** Replaces the default lateness chip, e.g. TDS counts days left instead. */
  chip?: string;
}

/** Colour is the kind of work; lateness has its own chip, so none of these are red or amber. */
export const QUEUE_TYPES: Record<QueueType, { label: string; color: string; action: string }> = {
  inv: { label: "Tally invoice", color: "#378ADD", action: "Handle" },
  pay: { label: "Payment to verify", color: "#1D9E75", action: "Verify" },
  qry: { label: "Query", color: "#639922", action: "Reply" },
  ven: { label: "Vendor bill", color: "#D4537E", action: "Pay" },
  pet: { label: "Petty cash", color: "#888780", action: "Review" },
  tds: { label: "TDS", color: "#D8861E", action: "Open" },
};

export const QUEUE_TYPE_ORDER: QueueType[] = ["inv", "pay", "qry", "ven", "pet", "tds"];

/** Petty cash only records created_at, so age since creation stands in for time spent waiting. */
export const PETTY_CASH_OVERDUE_DAYS = 2;
/** A TDS month enters the queue this many days before its deposit date. */
export const TDS_LEAD_DAYS = 7;

const DAY_MS = 86_400_000;
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** Today's date in IST as YYYY-MM-DD. Server UTC dates drift a day around midnight IST. */
export function todayIST(now: Date = new Date()): string {
  return new Date(now.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** Whole days from `from` to `to` (both YYYY-MM-DD); negative when `to` is earlier. */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(to.slice(0, 10)) - Date.parse(from.slice(0, 10))) / DAY_MS);
}

/** Tally handoffs age from their last state change; 48h is the inbox's own "aged" line. */
export function inboxUrgency(agingHours: number): { urgency: QueueUrgency; daysLate: number } {
  const daysLate = Math.max(0, Math.floor(agingHours / 24));
  return agingHours >= AGING_ESCALATE_HOURS
    ? { urgency: "overdue", daysLate }
    : { urgency: "today", daysLate: 0 };
}

/** Items with a due date (queries, bills): late once the date has passed. No date means act today. */
export function dueDateUrgency(
  due: string | null | undefined,
  today: string,
): { urgency: QueueUrgency; daysLate: number } {
  if (!due) return { urgency: "today", daysLate: 0 };
  const late = daysBetween(due, today);
  return late > 0 ? { urgency: "overdue", daysLate: late } : { urgency: "today", daysLate: 0 };
}

export function ageDaysUrgency(
  createdAt: string,
  today: string,
  overdueAfterDays: number,
): { urgency: QueueUrgency; daysLate: number } {
  const age = Math.max(0, daysBetween(createdAt, today));
  return age >= overdueAfterDays ? { urgency: "overdue", daysLate: age } : { urgency: "today", daysLate: 0 };
}

/**
 * Deposit date for a TDS month: the 7th of the following month, except March
 * (financial year end), which is due 30 April. Mirrors depositDueDate in the TDS page.
 */
export function tdsDueDate(month: number, year: number): string {
  const nextMonth = month === 12 ? 1 : month + 1;
  const nextYear = month === 12 ? year + 1 : year;
  const day = month === 3 ? 30 : 7;
  return `${nextYear}-${String(nextMonth).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Null while the deposit date is still comfortably away. */
export function tdsUrgency(
  month: number,
  year: number,
  today: string,
): { urgency: QueueUrgency; daysLate: number; daysLeft: number } | null {
  const daysLeft = daysBetween(today, tdsDueDate(month, year));
  if (daysLeft > TDS_LEAD_DAYS) return null;
  if (daysLeft < 0) return { urgency: "overdue", daysLate: -daysLeft, daysLeft };
  return { urgency: "today", daysLate: 0, daysLeft };
}

/** Overdue before due-today, most late first, then by title so the order is stable. */
export function sortQueue(items: QueueItem[]): QueueItem[] {
  return [...items].sort((a, b) => {
    if (a.urgency !== b.urgency) return a.urgency === "overdue" ? -1 : 1;
    if (a.daysLate !== b.daysLate) return b.daysLate - a.daysLate;
    return a.title.localeCompare(b.title);
  });
}

export function countUrgency(items: QueueItem[]): { overdue: number; today: number } {
  let overdue = 0;
  for (const item of items) if (item.urgency === "overdue") overdue += 1;
  return { overdue, today: items.length - overdue };
}
