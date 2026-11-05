import { BILLING_CYCLE_MONTHS, type ServicePoBillingCycle } from "@/lib/constants";
import { cyclesBetween } from "@/lib/procurement/amc-billing";
import { invoiceFitsCycle, GST_SLABS, GST_ROUNDING_TOLERANCE } from "@/lib/procurement/invoice-fits-cycle";

export const CONVERTIBLE_STATUSES = ["ordered", "partially_received", "received", "invoice_received", "invoice_approved"] as const;

export interface ConvertInput {
  role: string;
  po: {
    po_type: string;
    status: string;
    total_ordered_amount: number | string;
    amc_terminated_at?: string | null;
    isAmc: boolean;
  };
  existingReports: number;
  billingCycle: string;
  cycleCount: number;
  serviceStart: string | null;
  /** Invoice to become cycle 1; omit to convert without one. */
  bill?: { po_id: string | null; service_report_id: string | null; approval_status: string; total_amount: number | string; base_amount?: number | string | null } | null;
  poId: string;
  cycle1From?: string | null;
  cycle1To?: string | null;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Rules for converting a goods-type AMC PO into a service PO. The database function
 * enforces the same rules inside its transaction; this runs first so the admin gets a
 * plain-English reason instead of a database error.
 */
export function checkConvertToService(i: ConvertInput):
  | { ok: true; unitCost: number }
  | { ok: false; error: string; status: number } {
  if (i.role !== "admin") return { ok: false, error: "Only an admin can convert a purchase order to a service contract", status: 403 };
  if (i.po.po_type !== "goods") return { ok: false, error: "This purchase order is already a service PO", status: 422 };
  if (!i.po.isAmc) return { ok: false, error: "Only AMC contracts can be converted", status: 422 };
  if (!(CONVERTIBLE_STATUSES as readonly string[]).includes(i.po.status)) {
    return { ok: false, error: `A ${i.po.status.replace(/_/g, " ")} purchase order can't be converted`, status: 422 };
  }
  if (i.po.amc_terminated_at) return { ok: false, error: "This AMC has been terminated", status: 422 };
  if (i.existingReports > 0) return { ok: false, error: "This purchase order already has service reports", status: 422 };
  if (!(i.billingCycle in BILLING_CYCLE_MONTHS)) return { ok: false, error: "Choose a billing cycle", status: 422 };
  if (!Number.isInteger(i.cycleCount) || i.cycleCount < 1) return { ok: false, error: "Cycle count must be at least 1", status: 422 };
  if (!i.serviceStart) return { ok: false, error: "A start date is required", status: 422 };

  const total = Number(i.po.total_ordered_amount);
  const unitCost = round2(total / i.cycleCount);
  if (Math.abs(unitCost * i.cycleCount - total) > 0.01) {
    return {
      ok: false,
      error: `${i.cycleCount} cycles don't split the PO total of ₹${total.toLocaleString("en-IN")} evenly. Pick a cycle count that does.`,
      status: 422,
    };
  }

  if (i.bill) {
    if (i.bill.po_id !== i.poId) return { ok: false, error: "That invoice is not on this purchase order", status: 422 };
    if (i.bill.approval_status === "rejected") return { ok: false, error: "A rejected invoice can't be used for cycle 1", status: 422 };
    if (i.bill.service_report_id) return { ok: false, error: "That invoice is already tied to a cycle", status: 422 };
    if (!invoiceFitsCycle(i.bill, unitCost).fits) {
      return { ok: false, error: `That invoice (₹${Number(i.bill.total_amount).toLocaleString("en-IN")}) is more than one cycle's cost (₹${unitCost.toLocaleString("en-IN")})`, status: 422 };
    }
    if (!i.cycle1From || !i.cycle1To || i.cycle1From > i.cycle1To) {
      return { ok: false, error: "Enter the cycle 1 period, with the end on or after the start", status: 422 };
    }
  }
  return { ok: true, unitCost };
}

function parts(d: string): { y: number; m: number; day: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d);
  return m ? { y: Number(m[1]), m: Number(m[2]), day: Number(m[3]) } : null;
}

const iso = (d: Date) => d.toISOString().slice(0, 10);

/** Last day of cycle 1: the start advanced by the cycle length, minus a day. */
export function cycle1Period(start: string | null | undefined, cycle: ServicePoBillingCycle): { from: string; to: string } | null {
  const p = start ? parts(start) : null;
  if (!p) return null;
  const end = new Date(Date.UTC(p.y, p.m - 1 + (BILLING_CYCLE_MONTHS[cycle] ?? 12), p.day - 1));
  return { from: iso(new Date(Date.UTC(p.y, p.m - 1, p.day))), to: iso(end) };
}

const CYCLE_BY_COUNT: Record<number, ServicePoBillingCycle> = { 12: "monthly", 4: "quarterly", 2: "half_yearly", 1: "yearly" };

/**
 * A starting guess for the dialog. When the live invoices are all the same size and
 * together make up the PO total, their number is the cycle count (two equal invoices
 * on a ₹16,065 PO is half-yearly). Otherwise fall back to yearly. It is only a default;
 * the admin confirms it.
 */
export function suggestConversion(input: {
  total: number;
  amcStart?: string | null;
  amcEnd?: string | null;
  liveBillAmounts: number[];
  /** The PO's payment terms text, e.g. "Half-Yearly Payment(AMC)". */
  paymentTerms?: string | null;
}): { billingCycle: ServicePoBillingCycle; cycleCount: number; reason: "invoices" | "payment_terms" | "dates" } {
  const n = input.liveBillAmounts.length;
  const total = round2(input.total);
  const equalShare = (a: number, k: number) =>
    Math.abs(a - total / k) <= 0.01 ||
    GST_SLABS.some((r) => Math.abs(a - round2((total / k) * (1 + r / 100))) <= GST_ROUNDING_TOLERANCE);
  if (n > 0 && CYCLE_BY_COUNT[n] && input.liveBillAmounts.every((a) => equalShare(a, n))) {
    return { billingCycle: CYCLE_BY_COUNT[n], cycleCount: n, reason: "invoices" };
  }
  const fromTerms = cycleFromText(input.paymentTerms);
  if (fromTerms) {
    const k = cyclesBetween(input.amcStart, input.amcEnd, fromTerms) ?? Math.round(12 / BILLING_CYCLE_MONTHS[fromTerms]);
    return { billingCycle: fromTerms, cycleCount: k, reason: "payment_terms" };
  }
  const byDates = cyclesBetween(input.amcStart, input.amcEnd, "yearly");
  return { billingCycle: "yearly", cycleCount: byDates ?? 1, reason: "dates" };
}

/** Reads a billing cycle out of free text such as "Half-Yearly Payment(AMC)". */
export function cycleFromText(text: string | null | undefined): ServicePoBillingCycle | null {
  const t = (text ?? "").toLowerCase().replace(/[-_]/g, " ");
  if (/half\s*yearly|bi\s*annual|six\s*month|6\s*month/.test(t)) return "half_yearly";
  if (/quarter/.test(t)) return "quarterly";
  if (/monthly|per month/.test(t)) return "monthly";
  if (/yearly|annual|12\s*month/.test(t)) return "yearly";
  return null;
}

/** Every cycle's date range, so the user can see the whole year before confirming. */
export function cyclePeriods(start: string | null | undefined, cycle: ServicePoBillingCycle, count: number): Array<{ n: number; from: string; to: string }> {
  const p = start ? parts(start) : null;
  if (!p || !Number.isInteger(count) || count < 1 || count > 60) return [];
  const months = BILLING_CYCLE_MONTHS[cycle] ?? 12;
  return Array.from({ length: count }, (_, i) => ({
    n: i + 1,
    from: iso(new Date(Date.UTC(p.y, p.m - 1 + i * months, p.day))),
    to: iso(new Date(Date.UTC(p.y, p.m - 1 + (i + 1) * months, p.day - 1))),
  }));
}
