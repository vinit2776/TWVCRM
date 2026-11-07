// Who may see the re-billing (outward) side of electricity: the customer bills, what they charge and
// the margin over the landlord's invoice. Everyone else who works the landlord payable sees only the
// inward side. Manager stays in for now; it is gated later once the full scope is deployed.
export const ELECTRICITY_REBILLING_ROLES = ["admin", "accounts", "manager"] as const;

export function canSeeElectricityRebilling(role: string | null | undefined): boolean {
  return !!role && (ELECTRICITY_REBILLING_ROLES as readonly string[]).includes(role);
}

/**
 * Removes every customer-facing figure from a landlord electricity bill row so a payables-only
 * role can never see the markup. Customer columns on the row are prefixed `customer_`.
 */
export function stripRebilling<T extends Record<string, unknown>>(bill: T): T {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(bill)) {
    if (key.startsWith("customer_")) continue;
    out[key] = value;
  }
  out.customer_bills = [];
  return out as T;
}
