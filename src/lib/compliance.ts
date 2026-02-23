import { DOCUMENT_CHECKLISTS, COMPLIANCE_CHECKLISTS } from "@/lib/constants";
import type { VoPurpose, EntityType, CaseDocStatus, ComplianceCheckStatus } from "@/types";

export interface DocumentChecklistItem {
  type: string;
  label: string;
  required: boolean;
}

export interface ComplianceChecklistItem {
  check_name: string;
  check_category: string;
  sort_order: number;
}

/**
 * Generate the document checklist for a given purpose and entity type.
 * Returns the list of document slots that should be created for a case.
 */
export function generateDocumentChecklist(
  purpose: VoPurpose,
  entityType: EntityType
): DocumentChecklistItem[] {
  const purposeChecklists = DOCUMENT_CHECKLISTS[purpose];
  if (!purposeChecklists) return [];

  // Try exact entity type match first
  const checklist = purposeChecklists[entityType];
  if (checklist) return checklist;

  // Fall back to "other" if available
  const fallback = purposeChecklists["other"];
  if (fallback) return fallback;

  // Fall back to "individual" as last resort
  const individual = purposeChecklists["individual"];
  if (individual) return individual;

  return [];
}

/**
 * Generate the compliance checklist for a given purpose.
 * Returns the list of compliance checks that should be created for a case.
 */
export function generateComplianceChecklist(
  purpose: VoPurpose
): ComplianceChecklistItem[] {
  return COMPLIANCE_CHECKLISTS[purpose] || [];
}

/**
 * Check if all required documents have been approved.
 */
export function areAllRequiredDocsApproved(
  documents: { is_required: boolean; status: CaseDocStatus }[]
): {
  allApproved: boolean;
  totalRequired: number;
  approvedCount: number;
  pendingCount: number;
  rejectedCount: number;
} {
  const required = documents.filter((d) => d.is_required);
  const approved = required.filter((d) => d.status === "approved");
  const rejected = required.filter((d) => d.status === "rejected");
  const pending = required.filter(
    (d) => d.status === "pending" || d.status === "uploaded"
  );

  return {
    allApproved: approved.length === required.length && required.length > 0,
    totalRequired: required.length,
    approvedCount: approved.length,
    pendingCount: pending.length,
    rejectedCount: rejected.length,
  };
}

/**
 * Check if all compliance checks have passed (or been waived).
 */
export function areAllComplianceChecksPassed(
  checks: { status: ComplianceCheckStatus }[]
): {
  allPassed: boolean;
  totalChecks: number;
  passedCount: number;
  failedCount: number;
  pendingCount: number;
  waivedCount: number;
} {
  const passed = checks.filter((c) => c.status === "passed");
  const failed = checks.filter((c) => c.status === "failed");
  const pending = checks.filter((c) => c.status === "pending");
  const waived = checks.filter((c) => c.status === "waived");

  const effectivelyPassed = passed.length + waived.length;

  return {
    allPassed: effectivelyPassed === checks.length && checks.length > 0,
    totalChecks: checks.length,
    passedCount: passed.length,
    failedCount: failed.length,
    pendingCount: pending.length,
    waivedCount: waived.length,
  };
}

/**
 * Get document completion summary for display.
 */
export function getDocumentCompletionSummary(
  documents: { is_required: boolean; status: CaseDocStatus }[]
): {
  percentage: number;
  label: string;
  color: string;
} {
  const total = documents.length;
  if (total === 0) return { percentage: 0, label: "No documents", color: "gray" };

  const completed = documents.filter(
    (d) => d.status === "approved"
  ).length;

  const percentage = Math.round((completed / total) * 100);

  let color = "gray";
  if (percentage === 100) color = "green";
  else if (percentage >= 50) color = "blue";
  else if (percentage > 0) color = "yellow";

  return {
    percentage,
    label: `${completed}/${total} documents approved`,
    color,
  };
}

/**
 * Get compliance completion summary for display.
 */
export function getComplianceCompletionSummary(
  checks: { status: ComplianceCheckStatus }[]
): {
  percentage: number;
  label: string;
  color: string;
} {
  const total = checks.length;
  if (total === 0)
    return { percentage: 0, label: "No compliance checks", color: "gray" };

  const passed = checks.filter(
    (c) => c.status === "passed" || c.status === "waived"
  ).length;
  const failed = checks.filter((c) => c.status === "failed").length;

  const percentage = Math.round((passed / total) * 100);

  let color = "gray";
  if (percentage === 100) color = "green";
  else if (failed > 0) color = "red";
  else if (percentage >= 50) color = "blue";
  else if (percentage > 0) color = "yellow";

  return {
    percentage,
    label: `${passed}/${total} checks passed`,
    color,
  };
}

/**
 * Get the list of missing required documents for an email notification.
 */
export function getMissingRequiredDocuments(
  documents: { document_type: string; label: string; is_required: boolean; status: CaseDocStatus }[]
): string[] {
  return documents
    .filter(
      (d) =>
        d.is_required &&
        (d.status === "pending" || d.status === "rejected")
    )
    .map((d) => d.label);
}
