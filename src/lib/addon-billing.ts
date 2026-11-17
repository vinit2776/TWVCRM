/**
 * Recurring add-on billing rules shared by the add-ons API and the contract
 * page. The month proration here mirrors generateRentProformas in billing.ts
 * (per-day, rounded to the paisa) so that a draft statement corrected after an
 * add-on changes shows the same figure billing would have produced.
 */

const round2 = (n: number) => Math.round(n * 100) / 100;
const DAY_MS = 86_400_000;

export interface AddonTerms {
  description: string;
  /** Monthly amount, excluding GST. */
  amount: number;
  effective_from: string;
  effective_until: string | null;
  is_active: boolean;
}

export interface MonthWindow {
  first: string;
  last: string;
  days: number;
}

export interface StatementItem {
  description: string;
  amount: number;
  note?: string;
  monthly_rate?: number;
  days_used?: number;
  days_in_month?: number;
  [key: string]: unknown;
}

export interface StatementSection {
  label?: string;
  type?: string;
  items: StatementItem[];
  subtotal?: number;
  [key: string]: unknown;
}

const toUtc = (ymd: string) => new Date(`${ymd}T00:00:00Z`);

/** The calendar month containing `ymd`. */
export function monthWindow(ymd: string): MonthWindow {
  const d = toUtc(ymd);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const days = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const mm = String(m + 1).padStart(2, "0");
  return { first: `${y}-${mm}-01`, last: `${y}-${mm}-${String(days).padStart(2, "0")}`, days };
}

/** Whether the add-on is billed on a given day (active and inside its dates). */
export function isAddonLiveOn(
  addon: Pick<AddonTerms, "is_active" | "effective_from"> & { effective_until?: string | null },
  ymd: string
): boolean {
  if (!addon.is_active) return false;
  if (addon.effective_from > ymd) return false;
  if (addon.effective_until && addon.effective_until < ymd) return false;
  return true;
}

export type AddonTermKind = "full" | "ended_early" | "custom";

/**
 * How an add-on's dates relate to the contract term: running the whole term,
 * stopped before it ends, or on some other dates agreed with the customer.
 */
export function addonTermKind(
  addon: Pick<AddonTerms, "effective_from"> & { effective_until?: string | null },
  termStart?: string | null,
  termEnd?: string | null
): AddonTermKind {
  if (!termStart || !termEnd) return "custom";
  const until = addon.effective_until ?? termEnd;
  if (addon.effective_from === termStart && until === termEnd) return "full";
  if (addon.effective_from === termStart && until < termEnd) return "ended_early";
  return "custom";
}

/**
 * The statement line for this add-on in one calendar month, or null when it is
 * not billed that month. A partial month is prorated by day.
 */
export function addonLineForMonth(addon: AddonTerms, month: MonthWindow): StatementItem | null {
  if (!addon.is_active) return null;
  const from = toUtc(addon.effective_from);
  const until = addon.effective_until ? toUtc(addon.effective_until) : null;
  const first = toUtc(month.first);
  const last = toUtc(month.last);
  const billStart = from > first ? from : first;
  const billEnd = until && until < last ? until : last;
  const billDays = Math.floor((billEnd.getTime() - billStart.getTime()) / DAY_MS) + 1;
  if (billDays <= 0) return null;
  const prorated = billDays < month.days;
  return {
    description: addon.description,
    amount: prorated ? round2((addon.amount / month.days) * billDays) : addon.amount,
    ...(prorated
      ? {
          note: `Pro-rated ${billDays}/${month.days} days`,
          monthly_rate: addon.amount,
          days_used: billDays,
          days_in_month: month.days,
        }
      : {}),
  };
}

/** A statement line that was produced for this add-on (name and rate both match). */
export function itemMatchesAddon(item: StatementItem, addon: Pick<AddonTerms, "description" | "amount">): boolean {
  const description = String(item.description ?? "");
  const nameMatches = description === addon.description || description.startsWith(`${addon.description} | `);
  const amount = Number(addon.amount);
  const rateMatches = Number(item.amount) === amount || Number(item.monthly_rate) === amount;
  return nameMatches && rateMatches;
}

export interface AddonChangeResult {
  sections: StatementSection[];
  /** Change to the statement subtotal, in rupees (negative when a line came out). */
  delta: number;
  removed: StatementItem | null;
  added: StatementItem | null;
  /** False when the draft has no rent section to put a new line in. */
  placed: boolean;
}

const isRentSection = (s: StatementSection) => String(s.label ?? "").toLowerCase().includes("rent");

/**
 * Corrects one single-month statement for a change to one add-on: takes out the
 * line the old terms produced and puts in the line the new terms produce. Pass
 * `before: null` for a new add-on and `after: null` for one that is gone.
 */
export function applyAddonChange(
  sections: StatementSection[],
  before: AddonTerms | null,
  after: AddonTerms | null,
  month: MonthWindow
): AddonChangeResult {
  let removed: StatementItem | null = null;
  let next = sections.map((s) => ({ ...s, items: [...(s.items ?? [])] }));

  if (before) {
    for (const section of next) {
      const index = section.items.findIndex((item) => itemMatchesAddon(item, before));
      if (index >= 0) {
        removed = section.items[index];
        section.items.splice(index, 1);
        section.subtotal = round2(Number(section.subtotal ?? 0) - Number(removed.amount));
        break;
      }
    }
  }

  let added: StatementItem | null = null;
  let placed = true;
  const line = after ? addonLineForMonth(after, month) : null;
  if (line) {
    const target = next.find(isRentSection);
    if (target) {
      target.items.push(line);
      target.subtotal = round2(Number(target.subtotal ?? 0) + line.amount);
      added = line;
    } else {
      placed = false;
    }
  }

  if (!added && !removed) next = sections;
  const delta = round2(Number(added?.amount ?? 0) - Number(removed?.amount ?? 0));
  return { sections: next, delta, removed, added, placed };
}

/**
 * The add-ons a billing run prices for a contract. Normally just its own. When
 * the contract is being renewed and the renewal has carried its own add-ons, the
 * renewal's are added and the contract's own stop at its end date, so an add-on
 * that exists on both is never priced twice. With none carried, the contract's
 * add-ons are returned exactly as they were.
 */
export function addonsForBillingRun<T extends { effective_until: string | null }>(
  own: T[] | null,
  renewalCarried: T[],
  contractEnd: string
): T[] | null {
  if (renewalCarried.length === 0) return own;
  return [
    ...(own ?? []).map((a) => ({
      ...a,
      effective_until: !a.effective_until || a.effective_until > contractEnd ? contractEnd : a.effective_until,
    })),
    ...renewalCarried,
  ];
}
