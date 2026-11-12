import type { SupabaseClient } from "@supabase/supabase-js";
import {
  BILLING_CYCLE_DAYS,
  holdoverAmount,
  holdoverUpliftPct,
  planHoldoverPi,
  type AddressVerdict,
  type HoldoverPiReason,
  type HoldoverSettings,
} from "@/lib/vo-address-watch";

/**
 * Holdover proforma drafts for a lapsed Virtual Office case whose address is
 * still in use. Everything here only ever produces a DRAFT billing statement
 * for a person to review, finalize and send through the normal proforma flow;
 * nothing is sent to a customer.
 */

/** app_settings key: legal has signed off the holdover clause (terms library). Absent or anything but "true" is no. */
export const VO_HOLDOVER_CLAUSE_APPROVED_SETTING = "vo_holdover_clause_approved";

export function isHoldoverClauseApproved(value: string | null | undefined): boolean {
  return (value ?? "").trim().toLowerCase() === "true";
}

const GST_RATE = 18;

function addDays(date: string, days: number): string {
  const d = new Date(`${date.slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Days from lapse date to today (both YYYY-MM-DD), never negative. */
export function daysSinceLapse(lapseDate: string, today: string): number {
  const ms = Date.parse(`${today}T00:00:00Z`) - Date.parse(`${lapseDate.slice(0, 10)}T00:00:00Z`);
  return Math.max(0, Math.floor(ms / 86_400_000));
}

export interface HoldoverCaseFacts {
  lapsedAt: string;
  today: string;
  latestVerdict: AddressVerdict | null;
  released: boolean;
  proofVerified: boolean;
  /** Cycle numbers (1 based) that already have a live holdover statement. */
  existingCycles: number[];
}

export type HoldoverDecision =
  | { create: true; cycle: number }
  | { create: false; reason: HoldoverPiReason };

/**
 * The cycle that is due today is the one the lapse date has reached. Cycles
 * are "due and not yet created", so a missed run is caught up the next day
 * instead of skipped; the pure planner is asked about that cycle's own day.
 */
export function decideHoldover(f: HoldoverCaseFacts): HoldoverDecision {
  const day = daysSinceLapse(f.lapsedAt, f.today);
  const cycle = Math.floor(day / BILLING_CYCLE_DAYS) + 1;
  const plan = planHoldoverPi({
    latestVerdict: f.latestVerdict,
    released: f.released,
    proofVerified: f.proofVerified,
    day: (cycle - 1) * BILLING_CYCLE_DAYS,
    existingPiCount: f.existingCycles.includes(cycle) ? cycle : cycle - 1,
  });
  return plan.create ? { create: true, cycle } : { create: false, reason: plan.reason };
}

/** TWV-HO-<case digits>-C<cycle>: one per case and cycle, and the idempotency key. */
export function holdoverReference(caseNumber: string, cycle: number): string {
  return `TWV-HO-${caseNumber.replace(/\D/g, "") || "0"}-C${cycle}`;
}

export function cycleFromReference(ref: string | null | undefined): number | null {
  const m = /-C(\d+)$/.exec(ref ?? "");
  return m ? Number(m[1]) : null;
}

export interface HoldoverCase {
  id: string;
  case_number: string;
  rate: number;
  tenure_months: number | null;
  lapsed_at: string;
  client_gst_number?: string | null;
  location?: { name?: string | null } | null;
}

/** The billing_statements row for holdover cycle `cycle`. Qty x Rate = Amount. */
export function buildHoldoverStatementRow(c: HoldoverCase, cycle: number, settings: HoldoverSettings, today: string) {
  const subtotal = holdoverAmount({ rate: c.rate, tenureMonths: c.tenure_months ?? 12, n: cycle, settings });
  const uplift = holdoverUpliftPct(cycle, settings);
  const gst = Math.round(subtotal * GST_RATE) / 100;
  const periodStart = addDays(c.lapsed_at, (cycle - 1) * BILLING_CYCLE_DAYS);
  const periodEnd = addDays(periodStart, BILLING_CYCLE_DAYS - 1);
  const where = c.location?.name ?? "The WorkVilla";
  return {
    case_id: c.id,
    period_start: periodStart,
    period_end: periodEnd,
    due_date: addDays(today, 7),
    statement_type: "vo_holdover",
    fixed_amount: subtotal,
    usage_amount: 0,
    service_usage_amount: 0,
    booking_usage_amount: 0,
    subtotal,
    tax_percentage: GST_RATE,
    tax_amount: gst,
    cgst_amount: gst / 2,
    sgst_amount: gst / 2,
    igst_amount: 0,
    total_amount: subtotal + gst,
    is_interstate: false,
    place_of_supply: "Tamil Nadu",
    buyer_gstin: c.client_gst_number ?? null,
    status: "draft",
    line_items: [
      {
        type: "prepaid_rent",
        label: "Virtual Office holdover",
        subtotal,
        items: [
          {
            description: `Virtual Office address holdover (+${uplift}%) · ${where} · ${periodStart} to ${periodEnd}`,
            quantity: 1,
            rate: subtotal,
            amount: subtotal,
          },
        ],
      },
    ],
    prepaid_month: Number(periodStart.slice(5, 7)),
    prepaid_year: Number(periodStart.slice(0, 4)),
    reference_note: holdoverReference(c.case_number, cycle),
  };
}

export type CreateDraftResult =
  | { outcome: "created"; id: string }
  | { outcome: "exists" }
  | { outcome: "schema_missing" }
  | { outcome: "error"; message: string };

/** Inserts the draft. A duplicate (case, reference) is the unique guard saying "already done". */
export async function createHoldoverDraft(
  admin: SupabaseClient,
  c: HoldoverCase,
  cycle: number,
  settings: HoldoverSettings,
  today: string,
): Promise<CreateDraftResult> {
  const { data, error } = await admin
    .from("billing_statements")
    .insert(buildHoldoverStatementRow(c, cycle, settings, today))
    .select("id")
    .single();
  if (error) {
    if (error.code === "23505") return { outcome: "exists" };
    if (error.code === "23514") return { outcome: "schema_missing" };
    return { outcome: "error", message: error.message };
  }
  return { outcome: "created", id: (data as { id: string }).id };
}

/**
 * Text for a person to send; nothing here is sent. Plain wording, no legal
 * promises beyond the agreement's own holdover clause.
 */
export function holdoverNoticeDraft(p: {
  customerName: string;
  addressLine: string;
  piNumber: string;
  amountWithGst: string;
  periodLabel: string;
}): string {
  return [
    `Dear ${p.customerName},`,
    "",
    `Your Virtual Office agreement for ${p.addressLine} has ended, but the address still appears in public records as your registered or business address.`,
    `Until it is removed, the holdover charge in your agreement applies. Proforma invoice ${p.piNumber} for ${p.periodLabel} is ${p.amountWithGst} including GST.`,
    "",
    "To stop further invoices, please send us proof that the address has been removed (for example the amended GST certificate or the MCA filing acknowledgement). Once we have verified it, no further holdover invoices will be raised.",
    "",
    "Regards,",
    "The WorkVilla",
  ].join("\n");
}
