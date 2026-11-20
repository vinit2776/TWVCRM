/**
 * A regenerated Leave & License agreement keeps everything that was typed into the previous one.
 * The case row has no columns for some of those fields (nature of business, witnesses, e-stamp
 * value), and rebuilding from the case alone wiped them.
 *
 * Signature, stamp and seal are never stored in the variables: they are drawn onto the PDF at
 * signing, so a regenerated draft starts unsigned without any handling here.
 */

// Set by the system on every generation or reset, never typed by a person.
const SYSTEM_KEYS = new Set([
  "agreement_number",
  "agreement_date",
  "special_clause_text",
  "address_reset_at",
  "address_reset_reason",
]);

// Refreshed from the case when the case address moved on since this agreement was generated.
const ADDRESS_KEYS = ["client_address", "location_name", "location_address", "property_address"];

export function carryOverLeaveLicenseVariables<T extends object>(
  fresh: T,
  previous: Record<string, unknown> | null | undefined,
): T {
  if (!previous) return fresh;
  const addressMoved = Boolean(previous.address_reset_at);
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(previous)) {
    if (SYSTEM_KEYS.has(key)) continue;
    if (addressMoved && ADDRESS_KEYS.includes(key)) continue;
    if (value === undefined || value === null) continue;
    kept[key] = value;
  }
  return { ...fresh, ...kept } as T;
}
