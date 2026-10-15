/**
 * Usage month for a usage charge.
 *
 * A charge is filed under the month of its `charge_date`, and the invoice's
 * billing period follows that month. The invoice itself is dated the day it is
 * generated, so picking an earlier month never changes the invoice date. Staff
 * previously had to type a "charge date" and a charge for September entered on
 * 14 Oct landed on October's invoice. The picker works in months and derives
 * the stored date.
 */

export interface UsageMonthOption {
  /** "2026-09" */
  key: string;
  /** "September 2026" */
  label: string;
}

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

const pad = (n: number) => String(n).padStart(2, "0");

export function monthKeyOf(isoDate: string): string {
  return isoDate.slice(0, 7);
}

export function monthLabel(key: string): string {
  const [y, m] = key.split("-").map(Number);
  return `${MONTH_NAMES[m - 1]} ${y}`;
}

/** Current month first, then back `count - 1` months. `today` is YYYY-MM-DD. */
export function lastMonths(today: string, count = 6): UsageMonthOption[] {
  let [y, m] = today.split("-").map(Number);
  const out: UsageMonthOption[] = [];
  for (let i = 0; i < count; i++) {
    const key = `${y}-${pad(m)}`;
    out.push({ key, label: monthLabel(key) });
    m -= 1;
    if (m === 0) { m = 12; y -= 1; }
  }
  return out;
}

/**
 * Options for the picker: the last `count` months minus locked ones, plus the
 * month already selected (an older charge being edited keeps its own month
 * even when it is outside the window or locked, so opening Edit never forces a change).
 */
export function pickerOptions(today: string, lockedKeys: ReadonlySet<string>, selectedKey?: string | null, count = 6): UsageMonthOption[] {
  const base = lastMonths(today, count).filter((o) => !lockedKeys.has(o.key));
  if (selectedKey && !base.some((o) => o.key === selectedKey)) {
    return [...base, { key: selectedKey, label: monthLabel(selectedKey) }].sort((a, b) => b.key.localeCompare(a.key));
  }
  return base;
}

/**
 * The charge_date to store for a chosen month. Keeps an existing date when the
 * month is unchanged; the current month uses today; any past month uses its last day.
 */
export function chargeDateForMonth(key: string, today: string, existingDate?: string | null): string {
  if (existingDate && monthKeyOf(existingDate) === key) return existingDate;
  if (key === monthKeyOf(today)) return today;
  const [y, m] = key.split("-").map(Number);
  return `${key}-${pad(new Date(Date.UTC(y, m, 0)).getUTCDate())}`;
}

const MONTH_PATTERNS: Array<[number, RegExp]> = [
  [1, /\bjan(?:uary)?\b/i], [2, /\bfeb(?:ruary)?\b/i], [3, /\bmar(?:ch)?\b/i], [4, /\bapr(?:il)?\b/i],
  [5, /\bMay\b(?!\s+(?:be|not|have|need|also|include)\b)/], [6, /\bjun(?:e)?\b/i], [7, /\bjul(?:y)?\b/i], [8, /\baug(?:ust)?\b/i],
  [9, /\bsep(?:t|tember)?\b/i], [10, /\boct(?:ober)?\b/i], [11, /\bnov(?:ember)?\b/i], [12, /\bdec(?:ember)?\b/i],
];

/**
 * The single month a description names ("Print out charge -Sep month",
 * "Colour print, September 2026"), as a "YYYY-MM" key, or null when it names none
 * or several. Without a year the most recent such month on or before `today` is meant.
 */
export function monthNamedIn(text: string, today: string): string | null {
  const hits = MONTH_PATTERNS.filter(([, re]) => re.test(text)).map(([m]) => m);
  if (hits.length !== 1) return null;
  const month = hits[0];
  const yearMatch = text.match(/\b(20\d{2})\b/);
  const [ty, tm] = today.split("-").map(Number);
  const year = yearMatch ? Number(yearMatch[1]) : month <= tm ? ty : ty - 1;
  return `${year}-${pad(month)}`;
}

export function usageMonthHint(key: string, today: string): string {
  const label = monthLabel(key);
  return key >= monthKeyOf(today)
    ? `Goes on the ${label} invoice. It can be sent once the month ends. The invoice is dated the day you send it.`
    : `Goes on the ${label} invoice. The invoice is dated the day you send it.`;
}
