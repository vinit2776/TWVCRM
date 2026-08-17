/**
 * Calendar-month arithmetic for billing — which months a contract owes rent
 * for, and which of those have actually been billed.
 *
 * Dependency-free on purpose. billing.ts pulls in the service-role Supabase
 * client, so anything importing it is server-only; these helpers also run in
 * the browser, where the contract's Invoices card flags unbilled months inline.
 * Same reasoning as rate-phase-dates.ts.
 */

/**
 * A contract's opening billing anchor: the first day of the first month it
 * should be billed for.
 *
 * Start mid-month and the proposal's pro-rata invoice covers that partial
 * month, so contract billing opens the following month. Start on the 1st and
 * the start month itself is the first billed month.
 *
 * Always the 1st of a month, never the contract's start day. Billing periods
 * are whole calendar months and the advance-cycle gate only reads which MONTH
 * the anchor falls in — a day-of-month here is noise that reads as if it means
 * something. It also must never be start + cycleMonths: that points at the
 * SECOND cycle and silently skips billing the first one entirely.
 */
export function firstBillingAnchor(startYmd: string): string {
  const [y, m, d] = startYmd.split("-").map(Number);
  if (d === 1) return `${y}-${String(m).padStart(2, "0")}-01`;
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
}

/** A calendar month, as billing counts them. */
export interface BillingMonth { year: number; month: number }

/** The subset of a statement needed to work out which months it billed rent for. */
export interface RentCoverage {
  statement_type: string;
  period_start: string;
  period_end: string;
  prepaid_month?: number | null;
  prepaid_year?: number | null;
  voided_at?: string | null;
}

const ymOf = (ymd: string): BillingMonth => ({ year: +ymd.slice(0, 4), month: +ymd.slice(5, 7) });
const monthKey = (m: BillingMonth) => m.year * 12 + m.month;
const monthAfter = (m: BillingMonth): BillingMonth =>
  m.month === 12 ? { year: m.year + 1, month: 1 } : { year: m.year, month: m.month + 1 };

/** Every month a statement charged rent for. */
function monthsCoveredByStatement(s: RentCoverage): BillingMonth[] {
  if (s.voided_at) return [];
  // Only rent-bearing statements count. A usage/electricity/reimbursement
  // statement for a month says nothing about whether rent was billed.
  if (s.statement_type !== "rent" && s.statement_type !== "combined") return [];

  // Legacy combined rows carry the CURRENT month as their period and embed the
  // NEXT month's rent, so period_start alone would name the wrong month.
  if (s.prepaid_month && s.prepaid_year) {
    const out: BillingMonth[] = [];
    let cur: BillingMonth = { year: s.prepaid_year, month: s.prepaid_month };
    const end = ymOf(s.period_end);
    // An advance-cycle statement spans several months; a single-month one
    // ends before its own prepaid month, so the loop adds nothing and the
    // push below covers it.
    while (monthKey(cur) <= monthKey(end)) {
      out.push(cur);
      cur = monthAfter(cur);
    }
    if (out.length === 0) out.push({ year: s.prepaid_year, month: s.prepaid_month });
    return out;
  }

  if (s.statement_type === "combined") return [monthAfter(ymOf(s.period_start))];

  const out: BillingMonth[] = [];
  let cur = ymOf(s.period_start);
  const end = ymOf(s.period_end);
  while (monthKey(cur) <= monthKey(end)) {
    out.push(cur);
    cur = monthAfter(cur);
  }
  return out;
}

/**
 * Months this contract should already have been billed rent for, but wasn't.
 *
 * The window is deliberately conservative at both ends, because a false alarm
 * costs someone a pointless investigation:
 *
 *   • It opens at the LATER of the contract's own first billing month and the
 *     first month a billing run could possibly have covered it — the run that
 *     bills month M executes at the end of M-1, so a contract whose row was
 *     created in June was first billable for July. Without that floor, every
 *     contract predating the CRM's billing rollout reads as months in arrears.
 *   • It closes at the CURRENT month. Next month's rent is billed by the run at
 *     the end of this one, so it is not late yet.
 *
 * A returned month means no rent-bearing statement covers it. That is a prompt
 * for a human, not proof of lost revenue — the rent may have been invoiced
 * outside the CRM, which is exactly why this reports instead of billing.
 */
export function unbilledMonths(opts: {
  startDate: string;
  endDate: string;
  /** Contract row creation — the CRM cannot have billed before this existed. */
  createdAt: string;
  /** Today, as YYYY-MM-DD in IST. */
  today: string;
  statements: RentCoverage[];
}): BillingMonth[] {
  const ownFirst = ymOf(firstBillingAnchor(opts.startDate));
  const firstRunnable = monthAfter(ymOf(opts.createdAt.slice(0, 10)));
  const first = monthKey(ownFirst) >= monthKey(firstRunnable) ? ownFirst : firstRunnable;

  const contractEnd = ymOf(opts.endDate);
  const now = ymOf(opts.today);
  const last = monthKey(contractEnd) <= monthKey(now) ? contractEnd : now;

  if (monthKey(first) > monthKey(last)) return [];

  const covered = new Set<number>();
  for (const s of opts.statements) {
    for (const m of monthsCoveredByStatement(s)) covered.add(monthKey(m));
  }

  const missing: BillingMonth[] = [];
  let cur = first;
  while (monthKey(cur) <= monthKey(last)) {
    if (!covered.has(monthKey(cur))) missing.push(cur);
    cur = monthAfter(cur);
  }
  return missing;
}
