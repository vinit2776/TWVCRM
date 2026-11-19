import { daysBetween } from "@/lib/accounts-queue";

/**
 * Pure helpers behind the IT work-queue dashboard. Kept free of fetch and React
 * so the lateness rules — the part that decides what turns red — can be tested
 * on their own.
 *
 * Like the accounts desk, an item has one of two urgencies: overdue or due
 * today. Anything not yet worth acting on (a ticket whose target is next week)
 * never becomes an item; it stays on the Issues page.
 */

export type ItQueueType = "vch" | "crd" | "tkt" | "tsk";
/** The tiles. "onb" is a customer-level view over the vch and crd rows, not a row type of its own. */
export type ItTileType = ItQueueType | "onb";
export type ItUrgency = "overdue" | "today";

export interface ItQueueItem {
  key: string;
  type: ItQueueType;
  title: string;
  subtitle: string;
  href: string;
  urgency: ItUrgency;
  daysLate: number;
  /** Replaces the default lateness chip, e.g. "5h late". */
  chip?: string;
  /** Set on rows that come from a customer's onboarding, so "New onboardings" can count customers. */
  customerKey?: string;
  /** Verb on the row's button; defaults to the type's own. */
  action?: string;
  /** Waiting on someone else: shown muted at the end, never counted. */
  blockedBy?: string;
  /** Tickets: who has it. Null means nobody does yet. */
  assigneeName?: string | null;
}

export const IT_QUEUE_TYPES: Record<ItTileType, { label: string; color: string; action: string }> = {
  onb: { label: "New onboardings", color: "#378ADD", action: "Open" },
  vch: { label: "WiFi vouchers", color: "#1D9E75", action: "Issue" },
  crd: { label: "Door access", color: "#7F77DD", action: "Enrol" },
  tkt: { label: "Work orders", color: "#D85A30", action: "Open" },
  tsk: { label: "Tasks", color: "#D4537E", action: "Open" },
};

export const IT_TILE_ORDER: ItTileType[] = ["onb", "vch", "crd", "tkt", "tsk"];

/** A new customer's WiFi and door access are due within this many days of activation. */
export const IT_ONBOARDING_OVERDUE_DAYS = 2;

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** Whole days a UTC timestamp is past `today` (IST YYYY-MM-DD), counted on the IST calendar. */
function istDate(iso: string): string {
  return new Date(new Date(iso).getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** A customer's IT steps age from activation; two days is the line. */
export function onboardingUrgency(
  since: string,
  today: string,
): { urgency: ItUrgency; daysLate: number } {
  const age = Math.max(0, daysBetween(istDate(since), today));
  return age >= IT_ONBOARDING_OVERDUE_DAYS ? { urgency: "overdue", daysLate: age } : { urgency: "today", daysLate: 0 };
}

/**
 * A ticket or task is late once its target has passed (or the system has already
 * flagged it breached), and due today when the target falls on today's IST date.
 * No target at all means act today. A target after today returns null — the item
 * stays out of the queue until its day comes.
 */
export function issueUrgency(
  slaTargetAt: string | null | undefined,
  slaBreached: boolean,
  now: Date,
  today: string,
): { urgency: ItUrgency; daysLate: number; chip?: string } | null {
  if (!slaTargetAt) {
    return slaBreached ? { urgency: "overdue", daysLate: 0, chip: "late" } : { urgency: "today", daysLate: 0 };
  }
  const lateMs = now.getTime() - new Date(slaTargetAt).getTime();
  if (lateMs > 0 || slaBreached) {
    const hours = Math.max(0, Math.floor(lateMs / 3_600_000));
    const daysLate = Math.max(0, daysBetween(istDate(slaTargetAt), today));
    return { urgency: "overdue", daysLate, chip: hours < 24 ? `${Math.max(hours, 1)}h late` : `${daysLate}d late` };
  }
  return istDate(slaTargetAt) <= today ? { urgency: "today", daysLate: 0 } : null;
}

/** Overdue before due-today, most late first, then by title so the order is stable. Blocked rows last. */
export function sortItQueue(items: ItQueueItem[]): ItQueueItem[] {
  return [...items].sort((a, b) => {
    const ab = a.blockedBy ? 1 : 0;
    const bb = b.blockedBy ? 1 : 0;
    if (ab !== bb) return ab - bb;
    if (a.urgency !== b.urgency) return a.urgency === "overdue" ? -1 : 1;
    if (a.daysLate !== b.daysLate) return b.daysLate - a.daysLate;
    return a.title.localeCompare(b.title);
  });
}

/** Counts what a person can act on; blocked rows are someone else's. */
export function countItUrgency(items: ItQueueItem[]): { overdue: number; today: number } {
  let overdue = 0;
  let total = 0;
  for (const item of items) {
    if (item.blockedBy) continue;
    total += 1;
    if (item.urgency === "overdue") overdue += 1;
  }
  return { overdue, today: total - overdue };
}

/** Tile figures. "onb" counts customers, every other tile counts rows. */
export function tileCounts(items: ItQueueItem[], tile: ItTileType): { total: number; overdue: number } {
  const live = items.filter((i) => !i.blockedBy);
  if (tile !== "onb") {
    const mine = live.filter((i) => i.type === tile);
    return { total: mine.length, overdue: mine.filter((i) => i.urgency === "overdue").length };
  }
  const customers = new Map<string, boolean>();
  for (const i of live) {
    if (!i.customerKey) continue;
    customers.set(i.customerKey, (customers.get(i.customerKey) ?? false) || i.urgency === "overdue");
  }
  return { total: customers.size, overdue: [...customers.values()].filter(Boolean).length };
}

/** Rows a tile shows. "onb" is every row that came from a customer's onboarding. */
export function rowsForTile(items: ItQueueItem[], tile: ItTileType | null): ItQueueItem[] {
  if (!tile) return items;
  if (tile === "onb") return items.filter((i) => !!i.customerKey);
  return items.filter((i) => i.type === tile);
}

export interface TeamLoadRow {
  name: string;
  open: number;
  overdue: number;
}

/** Open IT work per person, for the administrator. Unassigned work is its own row, listed last. */
export function teamLoad(items: { assigneeName: string | null; overdue: boolean }[]): TeamLoadRow[] {
  const byName = new Map<string, TeamLoadRow>();
  for (const i of items) {
    const name = i.assigneeName ?? "Not assigned";
    const row = byName.get(name) ?? { name, open: 0, overdue: 0 };
    row.open += 1;
    if (i.overdue) row.overdue += 1;
    byName.set(name, row);
  }
  return [...byName.values()].sort((a, b) => {
    if (a.name === "Not assigned") return 1;
    if (b.name === "Not assigned") return -1;
    return b.open - a.open || a.name.localeCompare(b.name);
  });
}
