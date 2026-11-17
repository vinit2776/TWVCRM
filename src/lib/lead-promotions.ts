// Promotions on the enquiry-inflow chart: which days one was running, and what came in then.

export interface Promotion {
  id: string;
  name: string;
  source: string | null;
  starts_on: string;
  ends_on: string | null;
  spend: number | null;
}

export interface InflowDay {
  day: string;
  total: number;
  sources: Record<string, number>;
}

/** Every yyyy-MM-dd from `from` to `to`, inclusive. */
export function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  const end = Date.parse(`${to}T00:00:00Z`);
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= end; t += 24 * 60 * 60 * 1000) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

/** Whether a promotion is running on a day. A promotion with no end date is still running. */
export function runningOn(p: Promotion, day: string, today: string): boolean {
  return p.starts_on <= day && day <= (p.ends_on ?? today);
}

/** The promotions running on each day of the range. */
export function promotionsByDay(promos: Promotion[], days: string[], today: string): Record<string, Promotion[]> {
  const out: Record<string, Promotion[]> = {};
  for (const d of days) {
    const running = promos.filter((p) => runningOn(p, d, today));
    if (running.length) out[d] = running;
  }
  return out;
}

export interface PromotionResult {
  id: string;
  name: string;
  /** Enquiries received on the days it ran (from its source only, when it has one). */
  enquiries: number;
  /** The same number of days just before it started, for comparison. */
  before: number;
  days: number;
  costPerEnquiry: number | null;
}

/** What each promotion brought, against the same number of days just before it. */
export function promotionResults(promos: Promotion[], inflow: Record<string, InflowDay | undefined>, today: string): PromotionResult[] {
  const count = (day: string, source: string | null) => {
    const d = inflow[day];
    if (!d) return 0;
    return source ? (d.sources[source] ?? 0) : d.total;
  };
  return promos.map((p) => {
    const end = p.ends_on ?? today;
    const ran = daysBetween(p.starts_on, end < p.starts_on ? p.starts_on : end);
    const startMs = Date.parse(`${p.starts_on}T00:00:00Z`);
    const beforeFrom = new Date(startMs - ran.length * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const beforeTo = new Date(startMs - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const enquiries = ran.reduce((a, d) => a + count(d, p.source), 0);
    const before = daysBetween(beforeFrom, beforeTo).reduce((a, d) => a + count(d, p.source), 0);
    return {
      id: p.id,
      name: p.name,
      enquiries,
      before,
      days: ran.length,
      costPerEnquiry: p.spend && enquiries > 0 ? Math.round(p.spend / enquiries) : null,
    };
  });
}
