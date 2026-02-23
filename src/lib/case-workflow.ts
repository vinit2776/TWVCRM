import { CASE_STATUS_TRANSITIONS, CASE_STATUS_LABELS, CASE_STATUS_GROUPS } from "@/lib/constants";
import type { CaseStatus } from "@/types";

/**
 * Check if a status transition is valid.
 */
export function validateTransition(
  currentStatus: CaseStatus,
  newStatus: CaseStatus
): { valid: boolean; reason?: string } {
  const allowed = CASE_STATUS_TRANSITIONS[currentStatus] || [];

  if (!allowed.includes(newStatus)) {
    return {
      valid: false,
      reason: `Cannot transition from "${CASE_STATUS_LABELS[currentStatus]}" to "${CASE_STATUS_LABELS[newStatus]}". Allowed transitions: ${
        allowed.map((s) => CASE_STATUS_LABELS[s]).join(", ") || "none"
      }`,
    };
  }

  return { valid: true };
}

/**
 * Get the list of available transitions from the current status.
 */
export function getAvailableTransitions(
  currentStatus: CaseStatus
): { status: CaseStatus; label: string }[] {
  const allowed = CASE_STATUS_TRANSITIONS[currentStatus] || [];

  return allowed.map((status) => ({
    status: status as CaseStatus,
    label: CASE_STATUS_LABELS[status] || status,
  }));
}

/**
 * Get the timestamp field name for a given status.
 */
export function getTimestampField(status: CaseStatus): string | null {
  const map: Record<string, string> = {
    docs_requested: "docs_requested_at",
    docs_received: "docs_received_at",
    under_review: "review_started_at",
    internal_approved: "internal_approved_at",
    sent_for_client_approval: "sent_for_client_approval_at",
    client_approved: "client_approved_at",
    signing_in_progress: "signing_started_at",
    executed: "executed_at",
    invoiced: "invoiced_at",
    active: "activated_at",
    renewed: "renewed_at",
    lapsed: "lapsed_at",
  };

  return map[status] || null;
}

/**
 * Calculate the renewal due date based on start_date + tenure_months.
 * Returns a date 30 days before the end of the tenure.
 */
export function calculateRenewalDate(
  startDate: string,
  tenureMonths: number
): string {
  const start = new Date(startDate);
  const end = new Date(start);
  end.setMonth(end.getMonth() + tenureMonths);
  // Set renewal 30 days before end
  end.setDate(end.getDate() - 30);
  return end.toISOString();
}

/**
 * Calculate the end date of the tenure from start_date + tenure_months.
 */
export function calculateEndDate(
  startDate: string,
  tenureMonths: number
): string {
  const start = new Date(startDate);
  const end = new Date(start);
  end.setMonth(end.getMonth() + tenureMonths);
  return end.toISOString();
}

/**
 * Get the status group (for Kanban board) that a status belongs to.
 */
export function getStatusGroup(
  status: CaseStatus
): { key: string; label: string } | null {
  for (const [key, group] of Object.entries(CASE_STATUS_GROUPS)) {
    if (group.statuses.includes(status)) {
      return { key, label: group.label };
    }
  }
  return null;
}

/**
 * Get the progress percentage based on the current status (for progress bar).
 */
export function getProgressPercentage(status: CaseStatus): number {
  const allStatuses = [
    "intake_received",
    "docs_requested",
    "docs_received",
    "under_review",
    "compliance_check",
    "internal_approved",
    "sent_for_client_approval",
    "client_approved",
    "signing_in_progress",
    "executed",
    "invoiced",
    "active",
  ];

  // Terminal states
  if (status === "renewed") return 100;
  if (status === "lapsed") return 100;
  if (status === "renewal_due") return 95;

  const index = allStatuses.indexOf(status);
  if (index === -1) return 0;

  return Math.round((index / (allStatuses.length - 1)) * 100);
}

/**
 * Check if a case is in an active/open state (not closed).
 */
export function isCaseOpen(status: CaseStatus): boolean {
  const closedStatuses: CaseStatus[] = ["renewed", "lapsed"];
  return !closedStatuses.includes(status);
}

/**
 * Check if a case is in a state where documents can be uploaded.
 */
export function canUploadDocuments(status: CaseStatus): boolean {
  const uploadAllowed: CaseStatus[] = [
    "intake_received",
    "docs_requested",
    "docs_received",
    "under_review",
  ];
  return uploadAllowed.includes(status);
}

/**
 * Check if a case is in a state where compliance checks can be performed.
 */
export function canPerformComplianceChecks(status: CaseStatus): boolean {
  return status === "compliance_check";
}

/**
 * Get a summary of a case's lifecycle timing.
 */
export function getLifecycleTiming(caseData: {
  created_at: string;
  docs_requested_at?: string | null;
  docs_received_at?: string | null;
  review_started_at?: string | null;
  internal_approved_at?: string | null;
  executed_at?: string | null;
  activated_at?: string | null;
}): { phase: string; days: number }[] {
  const phases: { phase: string; start?: string | null; end?: string | null }[] = [
    {
      phase: "Intake → Docs Requested",
      start: caseData.created_at,
      end: caseData.docs_requested_at,
    },
    {
      phase: "Docs Requested → Received",
      start: caseData.docs_requested_at,
      end: caseData.docs_received_at,
    },
    {
      phase: "Review → Approved",
      start: caseData.review_started_at,
      end: caseData.internal_approved_at,
    },
    {
      phase: "Total Processing",
      start: caseData.created_at,
      end: caseData.activated_at || caseData.executed_at,
    },
  ];

  return phases
    .filter((p) => p.start && p.end)
    .map((p) => ({
      phase: p.phase,
      days: Math.ceil(
        (new Date(p.end!).getTime() - new Date(p.start!).getTime()) /
          (1000 * 60 * 60 * 24)
      ),
    }));
}
