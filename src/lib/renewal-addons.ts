/**
 * Which recurring add-ons ride into a renewal term. An add-on is carried by
 * default when it is still billing and runs to the end of the term being
 * renewed; one that was paused, or ended early at the customer's request, is
 * left behind unless a person ticks it. Carried add-ons are never escalated:
 * the amount is copied as it is, and the dates become the new term.
 */

export interface CarryableAddon {
  id: string;
  description: string;
  /** Monthly amount, excluding GST. */
  amount: number;
  effective_from: string;
  effective_until?: string | null;
  is_active: boolean;
}

export interface RenewalAddonSeed {
  contract_id: string;
  description: string;
  amount: number;
  effective_from: string;
  effective_until: string;
  is_active: true;
  created_by: string | null;
}

/** Still billing, and not due to stop before the term ends. */
export function addonRunsToTermEnd(addon: Pick<CarryableAddon, "is_active" | "effective_until">, termEnd: string): boolean {
  return addon.is_active && (!addon.effective_until || addon.effective_until >= termEnd);
}

/** The add-ons to tick by default when renewing. */
export function defaultCarryIds(addons: CarryableAddon[], termEnd: string): string[] {
  return addons.filter((a) => addonRunsToTermEnd(a, termEnd)).map((a) => a.id);
}

/**
 * `contract_addons` rows for the renewal draft. `carryIds` is the person's
 * choice from the renewal dialog; leave it undefined (the auto-renewal job, an
 * older caller) to carry the defaults.
 */
export function renewalAddonSeeds(
  addons: CarryableAddon[],
  carryIds: string[] | undefined,
  termEnd: string,
  newContractId: string,
  newStart: string,
  newEnd: string,
  createdBy: string | null
): RenewalAddonSeed[] {
  const chosen = new Set(carryIds ?? defaultCarryIds(addons, termEnd));
  return addons
    .filter((a) => chosen.has(a.id))
    .map((a) => ({
      contract_id: newContractId,
      description: a.description,
      amount: Number(a.amount),
      effective_from: newStart,
      effective_until: newEnd,
      is_active: true as const,
      created_by: createdBy,
    }));
}
