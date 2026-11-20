// Pure aggregation for the petty cash analytics screen. Kept free of I/O so the
// totals can be unit-tested; the route feeds it every matching expense, not a page.

export interface AnalyticsRow {
  entry_number: string;
  date: string; // YYYY-MM-DD
  amount: number;
  description: string;
  category_id: string | null;
  category: string | null;
  person_id: string;
  person: string;
  location_id: string | null;
  location: string | null;
}

export interface BreakdownItem {
  id: string | null;
  name: string;
  total: number;
  count: number;
}

export interface PettyCashAnalytics {
  totalSpend: number;
  count: number;
  average: number;
  byCategory: BreakdownItem[];
  byPerson: BreakdownItem[];
  byLocation: BreakdownItem[];
  byWeek: { weekStart: string; total: number; count: number }[];
  topEntries: AnalyticsRow[];
}

/** Monday of the week containing `date` (YYYY-MM-DD), computed in UTC so it never shifts a day. */
export function weekStart(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  const back = (d.getUTCDay() + 6) % 7; // Mon=0 … Sun=6
  d.setUTCDate(d.getUTCDate() - back);
  return d.toISOString().slice(0, 10);
}

function breakdown(
  rows: AnalyticsRow[],
  key: (r: AnalyticsRow) => { id: string | null; name: string },
): BreakdownItem[] {
  const map = new Map<string, BreakdownItem>();
  for (const r of rows) {
    const { id, name } = key(r);
    const k = id ?? `none:${name}`;
    const cur = map.get(k) ?? { id, name, total: 0, count: 0 };
    cur.total += r.amount;
    cur.count += 1;
    map.set(k, cur);
  }
  return [...map.values()].sort((a, b) => b.total - a.total);
}

export function aggregatePettyCash(rows: AnalyticsRow[], topN = 10): PettyCashAnalytics {
  const totalSpend = rows.reduce((s, r) => s + r.amount, 0);

  const weeks = new Map<string, { total: number; count: number }>();
  for (const r of rows) {
    const w = weekStart(r.date);
    const cur = weeks.get(w) ?? { total: 0, count: 0 };
    cur.total += r.amount;
    cur.count += 1;
    weeks.set(w, cur);
  }

  return {
    totalSpend,
    count: rows.length,
    average: rows.length ? totalSpend / rows.length : 0,
    byCategory: breakdown(rows, (r) => ({ id: r.category_id, name: r.category ?? "Uncategorized" })),
    byPerson: breakdown(rows, (r) => ({ id: r.person_id, name: r.person })),
    byLocation: breakdown(rows, (r) => ({ id: r.location_id, name: r.location ?? "No location" })),
    byWeek: [...weeks.entries()]
      .map(([weekStart, v]) => ({ weekStart, ...v }))
      .sort((a, b) => a.weekStart.localeCompare(b.weekStart)),
    topEntries: [...rows].sort((a, b) => b.amount - a.amount).slice(0, topN),
  };
}

/** Spreadsheet apps run text starting with these as a formula; prefix a quote so a description can't. */
function csvCell(v: string | number | null): string {
  let s = v == null ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function entriesToCsv(rows: AnalyticsRow[]): string {
  const header = ["Entry", "Date", "Person", "Location", "Category", "Description", "Amount"];
  const lines = rows.map((r) =>
    [r.entry_number, r.date, r.person, r.location, r.category, r.description, r.amount].map(csvCell).join(","),
  );
  return [header.join(","), ...lines].join("\n");
}
