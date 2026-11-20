/**
 * Fields on a Leave & License agreement that exist only as manual edits: the case row has no
 * column for them, so a regenerate that rebuilds the variables from the case alone would wipe
 * them. Everything the case does hold (rate, tenure, address, dates) still comes from the case,
 * so a regenerate keeps picking up case changes.
 */
export interface LeaveLicenseCarryOver {
  natureOfBusiness?: string;
  witness1Name?: string;
  witness1AadhaarLast4?: string;
  witness1Mobile?: string;
  witness2Name?: string;
  witness2AadhaarLast4?: string;
  witness2Mobile?: string;
  estampValue?: number;
  lesseeSignatoryName?: string;
  lesseeSignatoryDesignation?: string;
}

// What mergeLeaveLicenseVariables prints when nothing was entered: not a user edit.
const PLACEHOLDERS = new Set(["", "To be provided", "Authorized Signatory"]);

function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return PLACEHOLDERS.has(trimmed) ? undefined : trimmed;
}

export function leaveLicenseCarryOver(previous: Record<string, unknown> | null | undefined): LeaveLicenseCarryOver {
  if (!previous) return {};
  const estamp = Number(previous.estamp_value);
  return {
    natureOfBusiness: text(previous.nature_of_business),
    witness1Name: text(previous.witness_1_name),
    witness1AadhaarLast4: text(previous.witness_1_aadhaar_last4),
    witness1Mobile: text(previous.witness_1_mobile),
    witness2Name: text(previous.witness_2_name),
    witness2AadhaarLast4: text(previous.witness_2_aadhaar_last4),
    witness2Mobile: text(previous.witness_2_mobile),
    estampValue: Number.isFinite(estamp) && estamp > 0 ? estamp : undefined,
    lesseeSignatoryName: text(previous.lessee_signatory_name),
    lesseeSignatoryDesignation: text(previous.lessee_signatory_designation),
  };
}
