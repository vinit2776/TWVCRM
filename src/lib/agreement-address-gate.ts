
/** What the generators print when no address was entered. */
export const ADDRESS_PLACEHOLDER = "To be provided";

const PINCODE = /(?<!\d)\d{6}(?!\d)/;

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
  if (!PINCODE.test(a)) {
    return {
      blocked: true,
      reason: "The client's address has no 6-digit pincode. Add the pincode on the case, regenerate the agreement, then try again.",
    };
  }
  return { blocked: false, reason: null };
}

const squash = (t: string | null | undefined) => (t ?? "").replace(/\s+/g, " ").trim().toLowerCase();

/** True when the case now has an address that the stored agreement doesn't carry
 *  (the agreement is a snapshot taken when it was generated). Warning only: staff
 *  may deliberately edit the address on the agreement itself. */
export function agreementAddressIsStale(caseAddress: string | null | undefined, agreementAddress: string | null | undefined): boolean {
  const c = squash(caseAddress);
  if (!c) return false;
  return c !== squash(agreementAddress);
}
