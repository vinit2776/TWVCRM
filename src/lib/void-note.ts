/**
 * Notes written onto the draft that /api/billing-statements/[id]/void creates
 * when it re-issues a voided statement. Two shapes exist in the database:
 *   current: "Replaces voided <number>.\nVoid reason: <reason>"
 *   legacy:  "Re-issued from voided <number>.\nOriginal void reason: <reason>"
 * The legacy shape was written before the wording changed and is never
 * rewritten, so the dialog has to read both.
 */
const REISSUE_NOTE = /^(?:Replaces voided|Re-issued from voided) (.+?)\.\n(?:Original void reason|Void reason): ([\s\S]*)$/;

export function parseReissueNote(notes: string): { voidedNumber: string; reason: string } | null {
  const m = notes.match(REISSUE_NOTE);
  return m ? { voidedNumber: m[1], reason: m[2] } : null;
}
