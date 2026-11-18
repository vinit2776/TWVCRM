interface PrepaidPackageScope {
  workspace_type?: string | null;
  space_id?: string | null;
}

/**
 * A package is a bundle of units for a specific kind of space, not a wallet.
 * Legacy packages with neither field set are unrestricted; new ones must
 * always carry at least one (enforced at creation).
 */
export function isPrepaidApplicableToSpace(
  pkg: PrepaidPackageScope | null | undefined,
  space: { id: string; workspace_type?: string | null },
): boolean {
  if (pkg?.space_id && pkg.space_id !== space.id) return false;
  if (pkg?.workspace_type && pkg.workspace_type !== space.workspace_type) return false;
  return true;
}

const normaliseCompany = (name?: string | null) => (name ?? "").trim().toLowerCase();

/**
 * A package bought by a lead is that lead's own. A package bought for a
 * company (no lead) can be used by any contact whose lead record carries
 * the same company name.
 */
export function isPrepaidOwnedByCustomer(
  purchase: { lead_id?: string | null; company_name?: string | null },
  customer: { leadId?: string | null; company?: string | null },
): boolean {
  if (purchase.lead_id && purchase.lead_id === customer.leadId) return true;
  const owner = normaliseCompany(purchase.company_name);
  return owner !== "" && owner === normaliseCompany(customer.company);
}

/** Escape LIKE wildcards so a company name is matched literally by ilike. */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}
