/**
 * Postpaid aggregator billing, pure rules.
 *
 * cases.rate is the fee for the whole tenure. The legacy monthly run bills it
 * every month; the once-per-tenure mode bills each case once, in the invoice
 * period that contains its term start, for the full term fee (see termFee), and never again for
 * the same term. A renewed term is a new case row with its own start_date.
 */

import { termFee as canonicalTermFee } from "@/lib/vo-term-fee";

export const AGG_BILLING_MODE_KEY = "vo_agg_billing_mode";

export type AggBillingMode = "legacy" | "once_per_tenure";

/** Case statuses the aggregator invoice run bills. */
export const AGG_BILLABLE_CASE_STATUSES = ["active", "renewal_due", "invoiced", "executed"] as const;

/** Anything other than the exact string 'once_per_tenure' keeps today's behaviour. */
export function parseAggBillingMode(value: unknown): AggBillingMode {
  return typeof value === "string" && value.trim() === "once_per_tenure" ? "once_per_tenure" : "legacy";
}

export interface TermBillingCase {
  id: string;
  case_number?: string | null;
  rate: number | null;
  tenure_months?: number | null;
  start_date?: string | null;
  activated_at?: string | null;
}

/**
 * Fee for the whole term. For terms of 12 months or less cases.rate is the fee
 * for that term; for longer terms (24, 36, 48) it is the annual rate, so the
 * term fee is rate x years.
 */
export function termFee(c: Pick<TermBillingCase, "rate" | "tenure_months">): number {
  return canonicalTermFee(c.rate, c.tenure_months);
}

export interface BilledTerm {
  case_id: string;
  term_start: string;
}

/**
 * Start of the case's current term as YYYY-MM-DD. Renewal creates a new case
 * whose start_date is the new term's start, so start_date is the term start;
 * cases without one fall back to the activation date.
 */
export function termStartOf(c: Pick<TermBillingCase, "start_date" | "activated_at">): string | null {
  const raw = c.start_date || c.activated_at;
  if (!raw) return null;
  const day = String(raw).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
}

function inPeriod(day: string, periodMonth: number, periodYear: number): boolean {
  return day.slice(0, 7) === `${periodYear}-${String(periodMonth).padStart(2, "0")}`;
}

export interface BillableTerm<C extends TermBillingCase = TermBillingCase> {
  case: C;
  termStart: string;
  amount: number;
}

export function billableCasesForPeriod<C extends TermBillingCase>({
  cases,
  periodMonth,
  periodYear,
  alreadyBilled,
}: {
  cases: C[];
  periodMonth: number;
  periodYear: number;
  alreadyBilled: BilledTerm[];
}): BillableTerm<C>[] {
  const billed = new Set(alreadyBilled.map((b) => `${b.case_id}|${String(b.term_start).slice(0, 10)}`));
  const out: BillableTerm<C>[] = [];
  for (const c of cases) {
    if (!c.rate || c.rate <= 0) continue;
    const termStart = termStartOf(c);
    if (!termStart || !inPeriod(termStart, periodMonth, periodYear)) continue;
    if (billed.has(`${c.id}|${termStart}`)) continue;
    out.push({ case: c, termStart, amount: termFee(c) });
  }
  return out;
}

/**
 * The legacy monthly amount for one case: the whole rate each month, pro-rated
 * by days in the activation month. Kept identical to the original inline math
 * (including its local-time Date use); a test pins the output.
 */
export function legacyLineAmount(
  c: Pick<TermBillingCase, "rate" | "activated_at">,
  periodMonth: number,
  periodYear: number,
): { amount: number; proRatedDays?: number; totalDays: number } {
  const totalDays = new Date(periodYear, periodMonth, 0).getDate();
  let activeDays = totalDays;
  let proRatedDays: number | undefined;

  if (c.activated_at) {
    const activatedDate = new Date(c.activated_at);
    if (activatedDate.getMonth() === periodMonth - 1 && activatedDate.getFullYear() === periodYear) {
      activeDays = totalDays - activatedDate.getDate() + 1;
      proRatedDays = activeDays;
    }
  }

  const monthlyRate = c.rate || 0;
  const amount =
    proRatedDays !== undefined ? Math.round((monthlyRate / totalDays) * activeDays * 100) / 100 : monthlyRate;
  return { amount, proRatedDays, totalDays };
}

export interface BillingPreviewRow {
  caseId: string;
  caseNumber: string | null;
  termStart: string | null;
  legacy: number;
  oncePerTenure: number;
  difference: number;
}

/** What each mode would bill per case for the period (cases with a rate only). */
export function previewLegacyVsNew({
  cases,
  periodMonth,
  periodYear,
  alreadyBilled,
}: {
  cases: TermBillingCase[];
  periodMonth: number;
  periodYear: number;
  alreadyBilled: BilledTerm[];
}): BillingPreviewRow[] {
  const once = new Map(
    billableCasesForPeriod({ cases, periodMonth, periodYear, alreadyBilled }).map((b) => [b.case.id, b.amount]),
  );
  const round = (n: number) => Math.round(n * 100) / 100;
  return cases
    .filter((c) => c.rate && c.rate > 0)
    .map((c) => {
      const legacy = legacyLineAmount(c, periodMonth, periodYear).amount;
      const oncePerTenure = once.get(c.id) ?? 0;
      return {
        caseId: c.id,
        caseNumber: c.case_number ?? null,
        termStart: termStartOf(c),
        legacy,
        oncePerTenure,
        difference: round(oncePerTenure - legacy),
      };
    });
}
