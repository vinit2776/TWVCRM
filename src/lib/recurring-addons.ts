/**
 * Recurring add-ons: monthly extras (valet parking, name board, locker) that
 * sit beside the escalating monthly fee. They never escalate and can be
 * switched off or ended mid-contract.
 *
 * On a proposal they are a plain list (`proposals.recurring_addons`). When the
 * contract is created each becomes a `contract_addons` row dated to the
 * contract term, which billing already prorates by day.
 */

import type { ProposalAddon } from "@/types";

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Rows with a description and a positive amount; anything else is a blank row. */
export function cleanAddons(addons: ProposalAddon[] | null | undefined): ProposalAddon[] {
  return (addons ?? [])
    .map((a) => ({ description: String(a.description ?? "").trim(), amount: Number(a.amount) }))
    .filter((a) => a.description !== "" && a.amount > 0);
}

export function addonsMonthlyTotal(addons: ProposalAddon[] | null | undefined): number {
  return round2(cleanAddons(addons).reduce((sum, a) => sum + a.amount, 0));
}

/** The part of a month an add-on is billed in a first, partial month. */
export function prorateMonthly(amount: number, daysRemaining: number, daysInMonth: number): number {
  if (daysInMonth <= 0 || daysRemaining >= daysInMonth) return round2(amount);
  return round2((amount * daysRemaining) / daysInMonth);
}

export interface ContractAddonSeed {
  contract_id: string;
  description: string;
  amount: number;
  effective_from: string;
  effective_until: string;
  is_active: true;
  created_by: string | null;
}

/** `contract_addons` rows for a new contract: every add-on runs the full term. */
export function seedContractAddons(
  addons: ProposalAddon[] | null | undefined,
  contractId: string,
  termStart: string,
  termEnd: string,
  createdBy: string | null
): ContractAddonSeed[] {
  return cleanAddons(addons).map((a) => ({
    contract_id: contractId,
    description: a.description,
    amount: a.amount,
    effective_from: termStart,
    effective_until: termEnd,
    is_active: true,
    created_by: createdBy,
  }));
}

export interface AddonDates {
  effective_from: string;
  effective_until: string | null;
}

export interface TermDates {
  start: string;
  end: string;
}

/**
 * An add-on left on the contract's default dates follows the term when it
 * moves (the start date is a placeholder until the first invoice is paid, and
 * an extension pushes the end date out). One whose dates were edited for the
 * customer is left alone. Returns the new dates, or null when nothing changes.
 */
export function followTermDates(addon: AddonDates, from: TermDates, to: TermDates): AddonDates | null {
  const startFollows = addon.effective_from === from.start;
  const endFollows = addon.effective_until === from.end;
  const next: AddonDates = {
    effective_from: startFollows ? to.start : addon.effective_from,
    effective_until: endFollows ? to.end : addon.effective_until,
  };
  if (next.effective_from === addon.effective_from && next.effective_until === addon.effective_until) return null;
  return next;
}

/**
 * The sentence a customer-facing document prints about escalation, or null
 * when the document carries no figure (proposals saved before it was captured).
 */
export function escalationNote(percent: number | null | undefined, hasAddons: boolean, cycleMonths?: number | null): string | null {
  if (percent == null || !Number.isFinite(Number(percent))) return null;
  const base = cycleMonths
    ? `Escalation of ${Number(percent)}% applies to the monthly fee every ${cycleMonths} months from the start date, each step on the fee then in force.`
    : `Escalation of ${Number(percent)}% applies to the monthly fee at each renewal.`;
  return hasAddons ? `${base} Recurring add-ons are not subject to escalation.` : base;
}
