// Who may decide a petty cash expense or fund request, what happens next, and which
// warnings an approver sees. Pure so the rules are unit-tested and shared by the
// PATCH routes, the inbox API and the UI.

export const PC_SECOND_APPROVAL_DEFAULT = 5000;
/** "Approve all clean" only offers small items so a bulk click can't move real money unseen. */
export const PC_BULK_APPROVE_MAX_AMOUNT = 1000;
/** An expense this many times the person's usual in that category is flagged. */
export const PC_SPIKE_RATIO = 2;
const PC_SPIKE_MIN_SAMPLES = 3;

export type EntryStage = "pending_manager" | "pending_admin";

export function needsSecondApproval(amount: number, threshold: number): boolean {
  return amount >= threshold;
}

export type Decision = { ok: true } | { ok: false; reason: string };

/** Nobody decides their own spend. Stage 1 is manager/admin; stage 2 is admin/accounts. */
export function canDecideEntry(
  role: string,
  userId: string,
  entry: { submitted_by: string; status: string },
): Decision {
  if (entry.submitted_by === userId) {
    return { ok: false, reason: "You logged this expense, so someone else must approve or reject it." };
  }
  if (entry.status === "pending_manager") {
    return ["admin", "manager"].includes(role)
      ? { ok: true }
      : { ok: false, reason: "Only a manager or admin can decide at this stage." };
  }
  if (entry.status === "pending_admin") {
    return ["admin", "accounts"].includes(role)
      ? { ok: true }
      : { ok: false, reason: "Only Admin or Accounts can give the second approval." };
  }
  return { ok: false, reason: `This expense is already ${entry.status.replace("_", " ")}.` };
}

/**
 * Where an approved expense goes next. An admin approving at stage 1 satisfies both stages,
 * so large amounts do not wait for a second person when the admin is the one deciding.
 */
export function nextStatusOnApprove(
  role: string,
  stage: EntryStage,
  amount: number,
  threshold: number,
): "pending_admin" | "approved" {
  if (stage === "pending_admin") return "approved";
  return needsSecondApproval(amount, threshold) && role !== "admin" ? "pending_admin" : "approved";
}

/** Fund requests: only an admin approves; Accounts then pays them from Acc Payables. Not your own request. */
export function canDecideRequest(role: string, userId: string, req: { created_by: string; status: string }): Decision {
  if (req.created_by === userId) {
    return { ok: false, reason: "You raised this request, so someone else must approve or reject it." };
  }
  if (req.status !== "pending") return { ok: false, reason: "This request is no longer waiting for a decision." };
  return role === "admin"
    ? { ok: true }
    : { ok: false, reason: "Only an admin approves fund requests. Once approved, Accounts pays it from Acc Payables." };
}

export interface EntryFlag {
  code: "no_bill" | "duplicate_amount" | "above_usual";
  message: string;
}

export interface FlagInput {
  amount: number;
  attachmentCount: number;
  nudgeAmount: number;
  categoryName: string | null;
  /** Average of this person's approved expenses in the same category (last 90 days) and how many. */
  usualAvg: number | null;
  usualSamples: number;
  /** Date of another expense by the same person for the same amount in the last 14 days. */
  duplicateOn: string | null;
}

export function computeEntryFlags(i: FlagInput): EntryFlag[] {
  const flags: EntryFlag[] = [];
  if (i.amount >= i.nudgeAmount && i.attachmentCount === 0) {
    flags.push({ code: "no_bill", message: `No bill attached for an amount of ₹${i.nudgeAmount.toLocaleString("en-IN")} or more.` });
  }
  if (i.duplicateOn) {
    flags.push({ code: "duplicate_amount", message: `The same amount was logged by this person on ${i.duplicateOn}. Check it is not a double entry.` });
  }
  if (i.usualAvg && i.usualSamples >= PC_SPIKE_MIN_SAMPLES && i.amount >= i.usualAvg * PC_SPIKE_RATIO) {
    const x = (i.amount / i.usualAvg).toFixed(1);
    flags.push({ code: "above_usual", message: `${x}× this person's usual ${i.categoryName ?? "expense"} (usually about ₹${Math.round(i.usualAvg).toLocaleString("en-IN")}).` });
  }
  return flags;
}

/** Safe to approve in bulk: has a bill, small, no warnings, not yours, still at stage 1. */
export function isCleanForBulk(i: { amount: number; attachmentCount: number; flags: EntryFlag[]; own: boolean; stage: EntryStage }): boolean {
  return i.stage === "pending_manager" && !i.own && i.attachmentCount > 0 && i.amount <= PC_BULK_APPROVE_MAX_AMOUNT && i.flags.length === 0;
}

export const PC_REJECT_REASONS = [
  "Bill is missing",
  "Amount doesn't match the bill",
  "Not a business expense",
  "Wrong category",
  "Duplicate of another expense",
] as const;

/** Turn ticked reasons + free text into the note the person will read. */
export function buildRejectNote(reasons: string[], detail: string): string {
  return [...reasons, detail.trim()].filter(Boolean).join(". ");
}

/**
 * Where a resubmitted expense goes. It returns to the stage that rejected it, so a second-stage
 * rejection is not sent back through the manager, but only if it is still the same or a smaller
 * amount and still needs the second stage. Any increase (or an amount now below the second-approval
 * line) restarts at the manager, because the earlier approval was for something different.
 */
export function resubmitStage(i: {
  rejectedLevel: "manager" | "admin" | null;
  oldAmount: number;
  newAmount: number;
  threshold: number;
}): EntryStage {
  if (i.rejectedLevel === "admin" && i.newAmount <= i.oldAmount && needsSecondApproval(i.newAmount, i.threshold)) {
    return "pending_admin";
  }
  return "pending_manager";
}
