// The signer's Aadhaar is stored in full on the case because the agreement
// prints it, but it must not leak into audit rows or API responses.

export function maskAadhaar(input: string): string {
  const digits = input.replace(/[\s-]/g, "");
  if (!/^[0-9]+$/.test(digits) || digits.length < 4) return "XXXX XXXX XXXX";
  return `XXXX XXXX ${digits.slice(-4)}`;
}

/** True for text that looks like an already-masked Aadhaar (XXXX XXXX 1234). */
export function looksMaskedAadhaar(value: string): boolean {
  return /^[Xx*•]{4}[\s-]?[Xx*•]{4}[\s-]?(\d{4}|[Xx*•]{4})$/.test(value.trim());
}

type CaseLike = Record<string, unknown>;

/**
 * Copy of a case record with a stored Aadhaar masked. `idType` overrides the
 * record's own type — a PATCH body can carry the number without the type.
 */
export function redactCaseSecrets<T extends CaseLike>(record: T, idType?: unknown): T {
  const number = record.represented_by_id_number;
  const type = idType ?? record.represented_by_id_type;
  if (type !== "aadhaar" || typeof number !== "string" || !number) return record;
  return { ...record, represented_by_id_number: maskAadhaar(number) };
}

/** Audit `changes` for a case with the Aadhaar masked on both sides. */
export function redactCaseChanges(
  changes: Record<string, { old: unknown; new: unknown }>,
  idType: unknown
): Record<string, { old: unknown; new: unknown }> {
  const entry = changes.represented_by_id_number;
  if (!entry || idType !== "aadhaar") return changes;
  const mask = (v: unknown) => (typeof v === "string" && v ? maskAadhaar(v) : v);
  return {
    ...changes,
    represented_by_id_number: { old: mask(entry.old), new: mask(entry.new) },
  };
}
