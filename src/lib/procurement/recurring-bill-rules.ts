import { formatCurrency } from "@/lib/utils";

export interface RecurringBillRuleLike {
  expected_amount: number;
  tolerance_percent: number;
  max_auto_approve_amount: number;
  first_bill_id: string | null;
}

export interface CandidateBillLike {
  total_amount: number;
  invoice_number: string | null;
  invoice_date: string; // YYYY-MM-DD
}

export interface RecentBillLike {
  id: string;
  invoice_number: string | null;
  invoice_date: string; // YYYY-MM-DD
  total_amount: number;
}

export interface AutoApprovalCheck {
  key: "first_bill" | "duplicate" | "variance" | "cap";
  pass: boolean;
  label: string;
  detail: string;
}

export interface AutoApprovalResult {
  approved: boolean;
  checks: AutoApprovalCheck[];
  note: string;
}

const MS_PER_DAY = 86_400_000;

function normaliseInvoiceNumber(value: string | null): string {
  return (value ?? "").trim().toLowerCase();
}

function daysBetween(a: string, b: string): number {
  return Math.abs((new Date(a).getTime() - new Date(b).getTime()) / MS_PER_DAY);
}

/**
 * Hard duplicate gate for auto-approval — deliberately stricter and independent
 * of the finance-intelligence duplicate_detector feature flag (@/lib/finance-intelligence),
 * since that flag can be turned off for the fuzzy UI suggestion without weakening
 * this money-moving guardrail. Flags an exact invoice-number match, or a same-amount
 * bill within 3 days.
 */
function findDuplicate(candidate: CandidateBillLike, recentBills: RecentBillLike[]): RecentBillLike | null {
  const candidateNumber = normaliseInvoiceNumber(candidate.invoice_number);
  for (const bill of recentBills) {
    if (candidateNumber && normaliseInvoiceNumber(bill.invoice_number) === candidateNumber) {
      return bill;
    }
    const sameAmount = Math.abs(Number(bill.total_amount) - candidate.total_amount) <= 1;
    if (sameAmount && daysBetween(bill.invoice_date, candidate.invoice_date) <= 3) {
      return bill;
    }
  }
  return null;
}

/**
 * Decides whether a bill against an active recurring rule can skip manual
 * approval. Runs every guardrail (not short-circuiting) so the full picture
 * can be shown in the UI, even though only the first failure determines the
 * fallback-to-manual outcome in practice.
 */
export function evaluateAutoApproval(
  rule: RecurringBillRuleLike,
  candidate: CandidateBillLike,
  recentBills: RecentBillLike[],
): AutoApprovalResult {
  const checks: AutoApprovalCheck[] = [];

  const isFirstBillUnderRule = !rule.first_bill_id;
  checks.push({
    key: "first_bill",
    pass: !isFirstBillUnderRule,
    label: "First bill under this rule",
    detail: isFirstBillUnderRule
      ? "First invoice since this rule went active — always manual, by design"
      : "Not the first bill — rule has an established track record",
  });

  const duplicate = findDuplicate(candidate, recentBills);
  checks.push({
    key: "duplicate",
    pass: !duplicate,
    label: "Duplicate check",
    detail: duplicate
      ? `Matches ${formatCurrency(duplicate.total_amount)} on ${duplicate.invoice_date}${duplicate.invoice_number ? ` (invoice ${duplicate.invoice_number})` : ""}`
      : "No match on invoice number or amount",
  });

  const variancePercent = rule.expected_amount > 0
    ? ((candidate.total_amount - rule.expected_amount) / rule.expected_amount) * 100
    : 0;
  const withinTolerance = Math.abs(variancePercent) <= rule.tolerance_percent;
  const sign = variancePercent >= 0 ? "+" : "";
  checks.push({
    key: "variance",
    pass: withinTolerance,
    label: "Variance",
    detail: `${formatCurrency(candidate.total_amount)} vs ${formatCurrency(rule.expected_amount)} expected (${sign}${variancePercent.toFixed(1)}%, tolerance ±${rule.tolerance_percent}%)`,
  });

  const withinCap = candidate.total_amount <= rule.max_auto_approve_amount;
  checks.push({
    key: "cap",
    pass: withinCap,
    label: "Hard cap",
    detail: withinCap
      ? `Under ${formatCurrency(rule.max_auto_approve_amount)} cap`
      : `Over ${formatCurrency(rule.max_auto_approve_amount)} cap`,
  });

  const approved = checks.every((c) => c.pass);
  const note = approved
    ? `Auto-approved · ${checks.find((c) => c.key === "variance")!.detail}`
    : `Held for manual approval · ${checks.find((c) => !c.pass)!.detail}`;

  return { approved, checks, note };
}

export type BillingCycle = "monthly" | "quarterly" | "yearly";

export interface OverdueStatus {
  overdue: boolean;
  daysOverdue: number;
  nextExpectedDate: string; // YYYY-MM-DD
}

const CYCLE_MONTHS: Record<BillingCycle, number> = {
  monthly: 1,
  quarterly: 3,
  yearly: 12,
};

/**
 * Flags a rule whose billing cycle has rolled over with no new bill received —
 * the "missing bill" side of this feature, independent of auto-approval itself.
 * A grace period absorbs normal invoicing lag (vendors rarely bill exactly on
 * the cycle boundary).
 */
export function computeOverdueStatus(
  billingCycle: BillingCycle,
  lastBillInvoiceDate: string,
  today: string,
  graceDays = 5,
): OverdueStatus {
  const last = new Date(lastBillInvoiceDate);
  const next = new Date(last);
  next.setMonth(next.getMonth() + CYCLE_MONTHS[billingCycle]);
  const nextExpectedDate = next.toISOString().split("T")[0];

  const dueBy = new Date(next);
  dueBy.setDate(dueBy.getDate() + graceDays);

  const todayDate = new Date(today);
  const overdue = todayDate > dueBy;
  const daysOverdue = overdue ? Math.floor((todayDate.getTime() - dueBy.getTime()) / MS_PER_DAY) : 0;

  return { overdue, daysOverdue, nextExpectedDate };
}
