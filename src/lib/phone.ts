// One stored format for phone numbers, so a number can be searched, matched and messaged
// whatever way it was typed. An Indian number is stored as its 10 digits ("9876543210" —
// what the public forms and WhatsApp intake already store); anything else keeps its full
// digits with a leading "+" ("+14155550123"). The messaging layer adds the country code on send.

/** Canonical form of a phone number as typed by a person. Blank in, blank out. */
export function normalizeStoredPhone(raw: string | null | undefined): string {
  const text = (raw ?? "").trim();
  if (!text) return "";
  const plus = text.startsWith("+");
  let digits = text.replace(/\D/g, "");
  if (!digits) return "";
  if (digits.length === 12 && digits.startsWith("91")) digits = digits.slice(2);
  else if (digits.length === 11 && digits.startsWith("0")) digits = digits.slice(1);
  if (digits.length === 10) return digits;
  // Outside the Indian mobile shape: keep every digit, marking an international number.
  return plus && !digits.startsWith("91") ? `+${digits}` : digits;
}

/** Copy of `row` with the named phone fields normalised. Absent fields stay absent. */
export function normalizePhoneFields<T extends Record<string, unknown>>(
  row: T,
  fields: readonly string[] = ["phone", "mobile"],
): T {
  const out: Record<string, unknown> = { ...row };
  for (const f of fields) {
    const v = out[f];
    if (typeof v === "string") out[f] = normalizeStoredPhone(v);
  }
  return out as T;
}
