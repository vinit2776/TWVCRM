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
  /** The contract this statement was raised against. Only needed when the
   *  caller passes statements from more than one contract (a renewal chain). */
  contract_id?: string | null;
  /** Set when the rent inside this statement belongs to a different contract —
   *  a renewal billed on its parent while awaiting activation. */
  billed_on_behalf_of_contract_id?: string | null;
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
 * Does a statement from somewhere in the renewal chain count as coverage for
 * THIS contract?
 *
 * Own statements always do. A relative's statement does only when the rent in
 * it belongs here — otherwise a parent's own earlier months would mask genuine
 * gaps in the renewal.
 */
function countsTowards(
  s: RentCoverage,
  contractId: string | undefined,
  startDate: string,
): boolean {
  // Caller passed a single contract's statements — nothing to disambiguate.
  if (!contractId || !s.contract_id) return true;
  if (s.contract_id === contractId) return true;

  // Explicitly attributed here by the generator.
  if (s.billed_on_behalf_of_contract_id === contractId) return true;
  // Attributed somewhere else.
  if (s.billed_on_behalf_of_contract_id) return false;

  // Untagged — either it predates the billed_on_behalf column or the caller
  // didn't select it. Fall back to the period: a parent cannot legitimately
  // bill ITSELF for a period starting on or after its renewal's start date, so
  // that rent was this contract's.
  return s.period_start >= startDate;
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
 *
 * The end of the window is normally the earlier of the contract's own
 * `end_date` and today — once a term is over, nothing more should have been
 * billed against it. `renewal_in_progress` is the one exception: the rent
 * generator (`computeRenewalSplitRentSegments` in billing.ts) deliberately
 * keeps billing a parent past its own `end_date`, at the renewal draft's
 * rate, for as long as the renewal sits unactivated — so capping the window
 * at `end_date` here would silently stop checking for gaps the generator is
 * still supposed to be filling. For that status the window instead runs
 * through today, same as an active contract with no end in sight yet.
 */
export function unbilledMonths(opts: {
  startDate: string;
  endDate: string;
  /** Contract row creation — the CRM cannot have billed before this existed. */
  createdAt: string;
  /** Today, as YYYY-MM-DD in IST. */
  today: string;
  /**
   * Statements to count as coverage. For a renewal, pass the whole chain —
   * the contract's own statements AND its ancestors'. A renewal's opening
   * months are routinely billed on the parent: while the parent is still
   * `renewal_in_progress` and the renewal is not yet active, the parent is the
   * only billable contract, so the run charges it at the renewal's rate for
   * days past its own end_date. Looking at one contract in isolation reports
   * those months as unbilled when they have in fact been invoiced and paid.
   */
  statements: RentCoverage[];
  /** This contract's id — required only when `statements` spans a chain. */
  contractId?: string;
  /** This contract's current status — see the window note above. Omit when
   *  unknown; the window then falls back to capping at `endDate`, same as
   *  every non-`renewal_in_progress` status. */
  contractStatus?: string;
  /** Months an admin waived (contract_rent_waivers.waived_month, YYYY-MM-DD):
   *  deliberately not billed through the CRM, so not reported as missed. */
  waivedMonths?: string[];
}): BillingMonth[] {
  const ownFirst = ymOf(firstBillingAnchor(opts.startDate));
  const firstRunnable = monthAfter(ymOf(opts.createdAt.slice(0, 10)));
  const first = monthKey(ownFirst) >= monthKey(firstRunnable) ? ownFirst : firstRunnable;

  const now = ymOf(opts.today);
  const last = opts.contractStatus === "renewal_in_progress"
    ? now
    : (monthKey(ymOf(opts.endDate)) <= monthKey(now) ? ymOf(opts.endDate) : now);

  if (monthKey(first) > monthKey(last)) return [];

  const covered = new Set<number>();
  for (const s of opts.statements) {
    if (!countsTowards(s, opts.contractId, opts.startDate)) continue;
    for (const m of monthsCoveredByStatement(s)) covered.add(monthKey(m));
  }
  for (const w of opts.waivedMonths ?? []) covered.add(monthKey(ymOf(w)));

  const missing: BillingMonth[] = [];
  let cur = first;
  while (monthKey(cur) <= monthKey(last)) {
    if (!covered.has(monthKey(cur))) missing.push(cur);
    cur = monthAfter(cur);
  }
  return missing;
}

/**
 * First month a missed rent month may be raised one at a time from the
 * contract page or the rent-gap list. CRM rent billing began with prepaid
 * month June 2026; anything earlier was invoiced outside the CRM, so a "gap"
 * before it is history to waive, not rent to raise.
 */
export const RENT_BACKFILL_FLOOR: BillingMonth = { year: 2026, month: 6 };

/** Statuses the rent generator will bill — a button for any other status would preview nothing. */
const BACKFILL_STATUSES = new Set(["active", "renewal_in_progress", "renewed"]);

/**
 * Of a contract's missed months (from unbilledMonths), the ones that may be
 * raised one at a time — "Bill this month" on the contract page, "Send
 * invoice" on Billing → Unbilled. Monthly contracts only, from
 * RENT_BACKFILL_FLOOR onward, and only for statuses the generator bills:
 *
 *   • active — any missed month of its term. Once a month has started, the
 *     ordinary "Bill next cycle" targets the FOLLOWING month, so without this
 *     a month whose month-end run was missed could never be raised at all.
 *   • renewal_in_progress — also months after its own end_date: the renewal
 *     isn't active yet, so the parent keeps billing at the renewal's terms.
 *   • renewed — only up to its own end_date. A renewal activated early leaves
 *     the parent owing its remaining tenure at its own rate; the renewal bills
 *     from its own start date and can't reach those months.
 *
 * Every month is still previewed before anything is sent, and a waived month
 * never reaches here (unbilledMonths treats it as handled).
 */
export function backfillableRentMonths(opts: {
  missed: BillingMonth[];
  billingCycle: string | null | undefined;
  contractStatus: string | null | undefined;
  endDate: string | null | undefined;
}): BillingMonth[] {
  const { missed, billingCycle, contractStatus, endDate } = opts;
  if (billingCycle !== "monthly" || !contractStatus || !BACKFILL_STATUSES.has(contractStatus) || !endDate) return [];
  const floorKey = monthKey(RENT_BACKFILL_FLOOR);
  const endKey = monthKey(ymOf(endDate));
  return missed.filter((m) =>
    monthKey(m) >= floorKey && (contractStatus === "renewal_in_progress" || monthKey(m) <= endKey)
  );
}
