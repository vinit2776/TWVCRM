/**
 * Read-only health check of every AMC, used to decide which ones can stay, which can be
 * fixed in place and which have to be retired and set up again. Nothing here writes.
 */

export type AuditBucket = "clean" | "fixable" | "broken" | "retired";

export type AuditIssueCode =
  | "wrong_type"
  | "no_asset"
  | "no_dates"
  | "bad_dates"
  | "no_cycle_setup"
  | "over_billed"
  | "billed_over_value"
  | "duplicate_cover";

export interface AuditIssue {
  code: AuditIssueCode;
  /** broken = cannot be repaired by editing, so the AMC has to be retired and re-created. */
  severity: "fix" | "broken";
  label: string;
}

export interface AuditPoInput {
  id: string;
  po_number: string;
  status: string;
  po_type: string | null;
  amc_terminated_at: string | null;
  amc_start_date: string | null;
  amc_end_date: string | null;
  billing_cycle: string | null;
  cycle_count: number | null;
  total_ordered_amount: number;
  assetIds: string[];
  liveBills: number;
  billedTotal: number;
}

export interface AuditResult {
  bucket: AuditBucket;
  issues: AuditIssue[];
}

/** Billed amounts may exceed the PO value by GST and rounding; flag only a clear overshoot. */
const BILLED_OVER_VALUE_TOLERANCE = 1.2;

const isRetired = (po: AuditPoInput) => po.status === "cancelled" || !!po.amc_terminated_at;

function overlaps(a: AuditPoInput, b: AuditPoInput): boolean {
  if (!a.amc_start_date || !a.amc_end_date || !b.amc_start_date || !b.amc_end_date) return false;
  return a.amc_start_date <= b.amc_end_date && b.amc_start_date <= a.amc_end_date;
}

export function auditAmcs(pos: AuditPoInput[]): Map<string, AuditResult> {
  const live = pos.filter((p) => !isRetired(p));
  const out = new Map<string, AuditResult>();

  for (const po of pos) {
    if (isRetired(po)) {
      out.set(po.id, { bucket: "retired", issues: [] });
      continue;
    }
    const issues: AuditIssue[] = [];
    const isService = po.po_type === "service";

    if (!isService) {
      issues.push({ code: "wrong_type", severity: "fix", label: "Raised as a goods order — needs converting to a service contract" });
    }
    if (po.assetIds.length === 0) {
      issues.push({ code: "no_asset", severity: "fix", label: "No asset linked" });
    }
    if (!po.amc_start_date || !po.amc_end_date) {
      issues.push({ code: "no_dates", severity: "fix", label: "Start or end date missing" });
    } else if (po.amc_end_date <= po.amc_start_date) {
      issues.push({ code: "bad_dates", severity: "broken", label: "End date is not after the start date" });
    }
    if (isService && (!po.billing_cycle || !po.cycle_count)) {
      issues.push({ code: "no_cycle_setup", severity: "fix", label: "Billing frequency or number of bills missing" });
    }
    if (isService && po.cycle_count && po.liveBills > po.cycle_count) {
      issues.push({
        code: "over_billed",
        severity: "broken",
        label: `${po.liveBills} live bills against ${po.cycle_count} billing cycles`,
      });
    }
    if (po.total_ordered_amount > 0 && po.billedTotal > po.total_ordered_amount * BILLED_OVER_VALUE_TOLERANCE) {
      issues.push({ code: "billed_over_value", severity: "fix", label: "Bills add up to well over the PO value" });
    }

    const clash = live.find(
      (other) => other.id !== po.id && overlaps(po, other) && other.assetIds.some((a) => po.assetIds.includes(a))
    );
    if (clash) {
      issues.push({ code: "duplicate_cover", severity: "broken", label: `Same asset also covered by ${clash.po_number} over the same dates` });
    }

    const bucket: AuditBucket = issues.some((i) => i.severity === "broken") ? "broken" : issues.length ? "fixable" : "clean";
    out.set(po.id, { bucket, issues });
  }
  return out;
}
