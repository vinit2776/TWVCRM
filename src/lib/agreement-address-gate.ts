
/** What the generators print when no address was entered. */
export const ADDRESS_PLACEHOLDER = "To be provided";

const PINCODE = /(?<!\d)\d{6}(?!\d)/;

/** An address as one printable line. The form takes it in a multi-line box, and
 *  a pasted address brings line breaks and curly punctuation with it; printed as
 *  typed, those break the party paragraph across lines in the PDF. */
export function cleanAddressText(t: string | null | undefined): string {
  return (t ?? "")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/\u2026/g, "...")
    .replace(/\s+/g, " ")
    .replace(/ ,/g, ",")
    .trim()
    .replace(/[,\s]+$/, "");
}

/** Characters the agreement PDF's font can't print (anything outside Latin-1,
 *  for example a letter typed with another keyboard layout). They come out as
 *  stray symbols, so an address holding any is not sent. */
export function unprintableAddressChars(t: string | null | undefined): string[] {
  return [...new Set([...cleanAddressText(t)].filter((c) => !/[\x20-\x7E\xA1-\xFF]/.test(c)))];
}

export interface AddressGate {
  blocked: boolean;
  reason: string | null;
}

/** A client agreement must carry the client's full address, ending in a pincode.
 *  The generators fall back to "To be provided" so a draft can still be built;
 *  this gate stops that draft from being sent or signed. */
export function agreementAddressGate(address: string | null | undefined): AddressGate {
  const a = (address ?? "").replace(/\s+/g, " ").trim();
  if (!a || a.toLowerCase() === ADDRESS_PLACEHOLDER.toLowerCase()) {
    return {
      blocked: true,
      reason: "The client's address is missing from this agreement. Add the full address (with pincode) on the case, regenerate the agreement, then try again.",
    };
  }
  const bad = unprintableAddressChars(a);
  if (bad.length > 0) {
    return {
      blocked: true,
      reason: `The client's address has characters the agreement cannot print (${bad.join(" ")}). Retype that part of the address on the case in English letters, then regenerate the agreement.`,
    };
  }
  if (!PINCODE.test(a)) {
    return {
      blocked: true,
      reason: "The client's address has no 6-digit pincode. Add the pincode on the case, regenerate the agreement, then try again.",
    };
  }
  return { blocked: false, reason: null };
}

const squash = (t: string | null | undefined) => cleanAddressText(t).toLowerCase();

export const ADDRESS_STALE_REASON =
  "The case address has changed since this agreement was generated. Regenerate the agreement to pick up the new address, then try again.";

/** True when the case now has an address that the stored agreement doesn't carry
 *  (the agreement is a snapshot taken when it was generated). The case is the one
 *  source for the address, so a stale agreement must be regenerated before it can
 *  be sent or signed. */
export function agreementAddressIsStale(caseAddress: string | null | undefined, agreementAddress: string | null | undefined): boolean {
  const c = squash(caseAddress);
  if (!c) return false;
  return c !== squash(agreementAddress);
}

/** The case's address as the agreements print it (street, city, state, pincode), on one line. */
export function caseAddressText(c: {
  client_address?: string | null;
  client_city?: string | null;
  client_state?: string | null;
  client_pincode?: string | null;
}): string {
  return [c.client_address, c.client_city, c.client_state, c.client_pincode].map(cleanAddressText).filter(Boolean).join(", ");
}
