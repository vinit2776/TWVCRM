/**
 * Auto-renewal planner: turns facts about each opted-in contract into "what the
 * daily job would do about it", and renders the internal digest.
 *
 * Pure functions, no database and no sending. In dry-run (the only mode this
 * part ships) the job loads the facts, calls planAutoRenewals(), emails the
 * digest to staff, and changes nothing.
 */
import { escalateUnitPrice } from "@/lib/line-item-escalation";
import {
  DEFAULT_AUTO_RENEW_TIMING,
  addDaysYmd,
  computeNoticeSchedule,
  evaluateAutoRenewEligibility,
  programmedEscalation,
  type AutoRenewHoldCode,
  type AutoRenewTiming,
  type NoticeSchedule,
} from "@/lib/auto-renewal";

/** What the notice period defaults to when a contract has none recorded: what its agreement prints. */
export const DEFAULT_NOTICE_PERIOD_MONTHS = 2;

/** How far ahead the digest lists upcoming actions. */
export const UPCOMING_WINDOW_DAYS = 30;

export interface PlanLine {
  description: string;
  quantity: number;
  unit_price: number;
  escalates?: boolean;
}

/** Everything the planner needs about one opted-in contract. Loaded by the job. */
export interface AutoRenewFacts {
  id: string;
  contractNumber: string;
  customer: string;
  location: string | null;
  status: string;
  endDate: string;
  noticePeriodMonths: number | null;
  seats: number;
  items: PlanLine[];
  subtotal: number;
  agreementEscalationPercentage: number | null;
  escalationPercentage: number | null;
  renewalDeclined: boolean;
  hasLiveExit: boolean;
  overdueAmount: number;
  hasActiveMoratorium: boolean;
  hasActiveRentWaiver: boolean;
  hasRatePhases: boolean;
  specialClauseStatus: string | null;
  escalationApprovalPending: boolean;
  /** The renewal draft that already exists for this contract, if any: its rent and the escalation applied to it. */
  renewalDraft: { subtotal: number; escalationPercentage: number | null } | null;
}

export type PlanStage =
  | "held"
  | "scheduled"
  | "draft_due"
  | "notice_window"
  | "waiting"
  | "confirmation_due"
  | "awaiting_roll"
  | "roll_due";

export const PLAN_STAGE_LABELS: Record<PlanStage, string> = {
  held: "Held: needs a person",
  scheduled: "Scheduled",
  draft_due: "Would prepare the draft now",
  notice_window: "Would send customer notice #1 (window open)",
  waiting: "Notice sent, waiting for the end date",
  confirmation_due: "Would send the rate confirmation",
  awaiting_roll: "Term ended; rolls on the 1st (that month's invoice carries both rates)",
  roll_due: "Would roll into the next term",
};

export interface PlanItem {
  facts: AutoRenewFacts;
  stage: PlanStage;
  holds: { code: AutoRenewHoldCode; label: string }[];
  schedule: NoticeSchedule;
  /** The day the next term starts. */
  rollOn: string;
  /** The next dated step after today, or null when none remain. */
  next: { label: string; on: string } | null;
  /** The agreement's escalation. */
  programmedPct: number;
  /** Rent per month the next term carries: the existing draft's rent when there is one, else the agreement's escalation applied. */
  nextRent: number;
  /** The escalation behind nextRent. Differs from programmedPct when the existing draft was negotiated. */
  nextRentPct: number;
  /** True when nextRent comes from an existing draft rather than a projection. */
  nextRentIsDraft: boolean;
}

export interface AutoRenewPlan {
  today: string;
  items: PlanItem[];
  held: PlanItem[];
  /** Acting now, in the order a person would read them. */
  dueNow: PlanItem[];
  /** Dated steps inside the next UPCOMING_WINDOW_DAYS that are not due now. */
  upcoming: PlanItem[];
}

function isLastDayOfMonth(ymd: string): boolean {
  return addDaysYmd(ymd, 1).slice(8, 10) === "01";
}

/**
 * The day the next term starts. The day after the end date, except that a term
 * ending mid-month waits for the 1st of the next month: its final month is one
 * invoice with two rates, generated at the previous month's end, and that only
 * works while the old contract is still "renewal in progress".
 */
export function computeRollDate(endDate: string): string {
  const dayAfter = addDaysYmd(endDate, 1);
  if (isLastDayOfMonth(endDate)) return dayAfter;
  const [y, m] = endDate.split("-").map(Number);
  const next = new Date(Date.UTC(y, m, 1)); // month index m is the following month
  return next.toISOString().slice(0, 10);
}

/**
 * Rent per month for the next term at `pct`: escalating lines rise, fixed lines stay.
 * Whole rupees, like the renewal route. A contract with no line items has nothing to
 * mark fixed, so the whole stored subtotal escalates.
 */
export function previewNextRent(items: PlanLine[], pct: number, subtotal: number): number {
  const multiplier = 1 + pct / 100;
  if (!items.length) return Math.round(subtotal * multiplier);
  return items.reduce(
    (sum, item) => sum + escalateUnitPrice(item, multiplier, Math.round) * item.quantity,
    0,
  );
}

function stageFor(today: string, schedule: NoticeSchedule, rollOn: string, endDate: string, hasHolds: boolean): PlanStage {
  if (hasHolds) return "held";
  if (today > endDate) return today >= rollOn ? "roll_due" : "awaiting_roll";
  if (today < schedule.draftOn) return "scheduled";
  if (today < schedule.noticeOn) return "draft_due";
  if (today <= schedule.noticeDeadline) return "notice_window";
  if (schedule.confirmationOn && today >= schedule.confirmationOn) return "confirmation_due";
  return "waiting";
}

/** The next dated step strictly after today. */
function nextStep(today: string, schedule: NoticeSchedule, rollOn: string): { label: string; on: string } | null {
  const steps: { label: string; on: string }[] = [
    { label: "Prepare draft", on: schedule.draftOn },
    { label: "Customer notice #1", on: schedule.noticeOn },
    { label: "Notice deadline", on: schedule.noticeDeadline },
    ...(schedule.confirmationOn ? [{ label: "Rate confirmation", on: schedule.confirmationOn }] : []),
    { label: "Next term starts", on: rollOn },
  ];
  return steps.find((s) => s.on > today) ?? null;
}

export function planAutoRenewals(
  facts: AutoRenewFacts[],
  today: string,
  timing: AutoRenewTiming = DEFAULT_AUTO_RENEW_TIMING,
): AutoRenewPlan {
  const items: PlanItem[] = facts.map((f) => {
    const schedule = computeNoticeSchedule(f.endDate, f.noticePeriodMonths ?? DEFAULT_NOTICE_PERIOD_MONTHS, timing);
    const rollOn = computeRollDate(f.endDate);
    const eligibility = evaluateAutoRenewEligibility({
      autoRenew: true,
      status: f.status,
      renewalDeclined: f.renewalDeclined,
      hasLiveExit: f.hasLiveExit,
      overdueAmount: f.overdueAmount,
      hasActiveMoratorium: f.hasActiveMoratorium,
      hasActiveRentWaiver: f.hasActiveRentWaiver,
      hasRatePhases: f.hasRatePhases,
      hasUnapprovedSpecialClause: f.specialClauseStatus != null && f.specialClauseStatus !== "approved",
      escalationApprovalPending: f.escalationApprovalPending,
    });
    const programmedPct = programmedEscalation({
      agreement_escalation_percentage: f.agreementEscalationPercentage,
      escalation_percentage: f.escalationPercentage,
    });
    const draftPct = f.renewalDraft?.escalationPercentage ?? null;
    return {
      facts: f,
      holds: eligibility.holds,
      schedule,
      rollOn,
      stage: stageFor(today, schedule, rollOn, f.endDate, eligibility.holds.length > 0),
      next: nextStep(today, schedule, rollOn),
      programmedPct,
      nextRent: f.renewalDraft ? f.renewalDraft.subtotal : previewNextRent(f.items, programmedPct, f.subtotal),
      nextRentPct: f.renewalDraft && draftPct != null ? draftPct : programmedPct,
      nextRentIsDraft: !!f.renewalDraft,
    };
  });

  const byEnd = (a: PlanItem, b: PlanItem) => a.facts.endDate.localeCompare(b.facts.endDate);
  const horizon = addDaysYmd(today, UPCOMING_WINDOW_DAYS);
  const actingStages: PlanStage[] = ["draft_due", "notice_window", "confirmation_due", "roll_due"];

  return {
    today,
    items: [...items].sort(byEnd),
    held: items.filter((i) => i.stage === "held").sort(byEnd),
    dueNow: items.filter((i) => actingStages.includes(i.stage)).sort(byEnd),
    upcoming: items
      .filter((i) => !actingStages.includes(i.stage) && i.stage !== "held" && i.next && i.next.on <= horizon)
      .sort((a, b) => (a.next!.on).localeCompare(b.next!.on)),
  };
}

// ---------------------------------------------------------------------------
// Digest
// ---------------------------------------------------------------------------

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function rentCell(i: PlanItem): string {
  const pct = `+${i.nextRentPct}%`;
  const note = i.nextRentIsDraft
    ? i.nextRentPct !== i.programmedPct
      ? `draft, ${pct}: negotiated, agreement is ${i.programmedPct}%`
      : `draft, ${pct}`
    : pct;
  return `${inr(i.nextRent)} <span style="color:#64748b">(${note})</span>`;
}

function inr(n: number): string {
  return `₹${Math.round(n).toLocaleString("en-IN")}`;
}

function longDate(ymd: string): string {
  return new Date(`${ymd}T00:00:00Z`).toLocaleDateString("en-IN", {
    timeZone: "UTC", day: "numeric", month: "short", year: "numeric",
  });
}

export interface DigestOptions {
  /** Ask the reader to read it as a rehearsal. Always true in this part. */
  dryRun: boolean;
  /** Absolute link prefix for contract links, e.g. https://twv-crm.vercel.app */
  appUrl?: string;
}

const TD = 'style="padding:8px 12px;border-bottom:1px solid #e5e7eb;vertical-align:top;font-size:13px"';
const TH = 'style="padding:8px 12px;text-align:left;border-bottom:2px solid #cbd5e1;color:#475569;font-size:12px"';

function contractCell(i: PlanItem, appUrl?: string): string {
  const label = `${escapeHtml(i.facts.contractNumber)}<br><span style="color:#64748b">${escapeHtml(i.facts.customer)}</span>`;
  return appUrl ? `<a href="${escapeHtml(appUrl)}/contracts/${encodeURIComponent(i.facts.id)}" style="color:#015e65">${label}</a>` : label;
}

function section(title: string, note: string, head: string[], rows: string[]): string {
  if (!rows.length) return "";
  return `<h2 style="font-size:15px;margin:24px 0 2px;color:#0f172a">${escapeHtml(title)} (${rows.length})</h2>
<p style="margin:0 0 8px;color:#64748b;font-size:12px">${escapeHtml(note)}</p>
<table style="width:100%;border-collapse:collapse"><tr>${head.map((h) => `<th ${TH}>${escapeHtml(h)}</th>`).join("")}</tr>${rows.join("")}</table>`;
}

export function digestSubject(plan: AutoRenewPlan, dryRun: boolean): string {
  const parts = [`${plan.items.length} on autopilot`];
  if (plan.held.length) parts.push(`${plan.held.length} held`);
  if (plan.dueNow.length) parts.push(`${plan.dueNow.length} due now`);
  return `${dryRun ? "[Dry run] " : ""}Auto-renewal: ${parts.join(", ")} · ${plan.today}`;
}

export function renderDigestHtml(plan: AutoRenewPlan, opts: DigestOptions): string {
  const held = section(
    "Needs a person",
    "Opted in, but something has to be dealt with first. The job will not renew these by itself.",
    ["Contract", "Ends", "Why"],
    plan.held.map((i) => `<tr><td ${TD}>${contractCell(i, opts.appUrl)}</td><td ${TD}>${longDate(i.facts.endDate)}</td><td ${TD}>${i.holds.map((h) => escapeHtml(h.label)).join("<br>")}</td></tr>`),
  );
  const dueNow = section(
    "Due now",
    "What the job would act on today.",
    ["Contract", "Ends", "Would do", "Next rent"],
    plan.dueNow.map((i) => `<tr><td ${TD}>${contractCell(i, opts.appUrl)}</td><td ${TD}>${longDate(i.facts.endDate)}</td><td ${TD}>${escapeHtml(PLAN_STAGE_LABELS[i.stage])}</td><td ${TD}>${rentCell(i)}</td></tr>`),
  );
  const upcoming = section(
    `Coming up (next ${UPCOMING_WINDOW_DAYS} days)`,
    "The next dated step for each contract on autopilot.",
    ["Contract", "Ends", "Next step", "Next rent"],
    plan.upcoming.map((i) => `<tr><td ${TD}>${contractCell(i, opts.appUrl)}</td><td ${TD}>${longDate(i.facts.endDate)}</td><td ${TD}>${escapeHtml(i.next!.label)}<br><span style="color:#64748b">${longDate(i.next!.on)}</span></td><td ${TD}>${rentCell(i)}</td></tr>`),
  );
  const banner = opts.dryRun
    ? `<div style="background:#fef3c7;color:#92400e;border-radius:6px;padding:8px 12px;font-size:13px;margin-bottom:12px"><b>Dry run.</b> Nothing was prepared, sent or changed, and no customer was contacted. This is what the job would do.</div>`
    : "";
  const empty = !held && !dueNow && !upcoming
    ? `<p style="color:#475569;font-size:13px">Nothing needs attention and nothing is due in the next ${UPCOMING_WINDOW_DAYS} days.</p>`
    : "";

  return `<div style="font-family:Inter,Arial,sans-serif;max-width:720px;margin:0 auto;color:#0f172a">
<h1 style="font-size:18px;margin:0 0 4px">Auto-renewal digest</h1>
<p style="margin:0 0 12px;color:#64748b;font-size:13px">${longDate(plan.today)} · ${plan.items.length} contract${plan.items.length === 1 ? "" : "s"} opted in</p>
${banner}${held}${dueNow}${upcoming}${empty}
</div>`;
}
