// Rules for petty cash bills / proof of payment. Pure so the permission and nudge
// logic can be unit-tested; the routes and UI both call these.

export const PC_ATTACHMENT_KINDS = ["receipt", "payment_proof", "other"] as const;
export type PcAttachmentKind = (typeof PC_ATTACHMENT_KINDS)[number];

export const PC_ATTACHMENT_MAX_FILES = 5;
export const PC_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
export const PC_RECEIPT_NUDGE_DEFAULT = 1000;

const MANAGE_ANY_ROLES = ["admin", "accounts"];

export function canManageAnyAttachment(role: string): boolean {
  return MANAGE_ANY_ROLES.includes(role);
}

/**
 * Who may add a file to an expense: accounts/admin any time; the submitter until the
 * expense is approved (so a rejected one can be fixed). After approval only accounts/admin
 * can add a missing bill.
 */
export function canAddToEntry(role: string, userId: string, entry: { submitted_by: string; status: string }): boolean {
  if (canManageAnyAttachment(role)) return true;
  return entry.submitted_by === userId && entry.status !== "approved";
}

/** Payment proof on a fund request is part of issuing cash, so it is accounts/admin only. */
export function canAddToRequest(role: string): boolean {
  return canManageAnyAttachment(role);
}

/** A file can be removed by accounts/admin, or by whoever uploaded it while the record is still open. */
export function canRemoveAttachment(
  role: string,
  userId: string,
  attachment: { uploaded_by: string },
  recordLocked: boolean,
): boolean {
  if (canManageAnyAttachment(role)) return true;
  return attachment.uploaded_by === userId && !recordLocked;
}

/** True when an expense is big enough to expect a bill and has none. Clears itself once a file exists. */
export function needsReceiptNudge(amount: number, attachmentCount: number, threshold: number): boolean {
  return amount >= threshold && attachmentCount === 0;
}

/** Keep the original name readable but safe as a storage path segment. */
export function safeFileName(name: string): string {
  const cleaned = name.normalize("NFKD").replace(/[^\w.\- ]+/g, "").trim().replace(/\s+/g, "-");
  return (cleaned || "file").slice(0, 80);
}
