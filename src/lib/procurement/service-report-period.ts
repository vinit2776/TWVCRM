import type { ServicePoBillingCycle } from "@/lib/constants";
import { cycleSchedule } from "@/lib/procurement/amc-running";
import { formatDate } from "@/lib/utils";

export interface ServiceReportPo {
  amc_start_date?: string | null;
  amc_end_date?: string | null;
  service_start_date?: string | null;
  billing_cycle?: string | null;
}

/**
 * The dates of a contract's billing cycle, so a service report never needs them typed in.
 * Null when the PO has no dates or the cycle number is past the end of the schedule.
 */
export function cycleSpan(po: ServiceReportPo, cycleNumber: number): { from: string; to: string } | null {
  const start = po.amc_start_date ?? po.service_start_date ?? null;
  const end = po.amc_end_date ?? null;
  if (!start || !end || !po.billing_cycle) return null;
  const hit = cycleSchedule(start, end, po.billing_cycle as ServicePoBillingCycle).find((c) => c.n === cycleNumber);
  return hit ? { from: hit.from, to: hit.to } : null;
}

/** A visit date is invalid in the future; one outside its cycle is only worth a warning. */
export function serviceDateProblem(serviceDate: string, today: string): string | null {
  return serviceDate > today ? "The service date can't be in the future. Record the report once the visit has happened." : null;
}

export function outsideCycleWarning(serviceDate: string, span: { from: string; to: string } | null): string | null {
  if (!span) return null;
  return serviceDate < span.from || serviceDate > span.to
    ? `That date is outside this cycle (${formatDate(span.from)} to ${formatDate(span.to)}). Check the cycle number is right.`
    : null;
}
