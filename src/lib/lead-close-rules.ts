/**
 * Moving a lead to lost needs a reason. A lead that is already lost stays editable without one,
 * because legacy lost rows have none and must not become impossible to touch.
 */
export function lostReasonMissing(input: {
  oldStatus: string | null | undefined;
  oldLostReason: string | null | undefined;
  newStatus: string | undefined;
  newLostReason: string | null | undefined;
}): boolean {
  if (input.newStatus !== "lost") return false;
  if (input.oldStatus === "lost") return false;
  return !(input.newLostReason?.trim() || input.oldLostReason?.trim());
}
