/**
 * The optional internal "what was agreed" note on a renewal contract
 * (contracts.renewal_agreed_note, migration 00609). One definition of the limit
 * and of how a submitted value is cleaned, shared by the renew route, the draft
 * edit route and both renewal dialogs.
 */

export const RENEWAL_NOTE_MAX_LENGTH = 1000;

export type RenewalNoteResult =
  | { ok: true; value: string | null }
  | { ok: false; error: string };

/**
 * Cleans a submitted note: absent or blank becomes null (no note), surrounding
 * whitespace is trimmed, and anything that is not text or is over the limit is
 * rejected rather than silently cut off.
 */
export function normalizeRenewalNote(input: unknown): RenewalNoteResult {
  if (input === undefined || input === null) return { ok: true, value: null };
  if (typeof input !== "string") return { ok: false, error: "Negotiation note must be text" };
  const trimmed = input.trim();
  if (trimmed.length === 0) return { ok: true, value: null };
  if (trimmed.length > RENEWAL_NOTE_MAX_LENGTH) {
    return {
      ok: false,
      error: `Negotiation note must be ${RENEWAL_NOTE_MAX_LENGTH} characters or fewer`,
    };
  }
  return { ok: true, value: trimmed };
}
