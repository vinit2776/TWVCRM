/**
 * Which Invoice wizard cards make sense for a contract's status and the
 * viewer's role. Each rule mirrors the gate on the screen the card opens, so a
 * card is never offered where its destination would refuse or preview nothing.
 *
 * Statuses are display statuses — see contractDisplayStatus(): a terminated
 * contract that never activated is "withdrawn".
 */

export type WizardChoiceKey = "rent" | "usage" | "electricity" | "deposit" | "addon" | "other";

// Who sees the wizard at all (admin, manager, accounts run billing).
export const INVOICE_WIZARD_ROLES = ["admin", "manager", "accounts"] as const;

// Who can raise an ad-hoc invoice — mirrors POST /api/invoices.
const CREATE_INVOICE_ROLES = ["admin", "manager", "sales_rep", "floor_manager"];
const BILLING_ROLES = ["admin", "manager", "accounts"];

const LIVE = ["active", "renewal_in_progress", "renewed"];
const NOT_YET_ACTIVE = ["draft", "sent", "viewed", "accepted"];

interface Rule {
  statuses: readonly string[];
  roles: readonly string[];
}

const RULES: Record<WizardChoiceKey, Rule> = {
  // The rent generator only bills these statuses — see BACKFILL_STATUSES in billing-months.ts.
  rent: { statuses: LIVE, roles: BILLING_ROLES },
  // Ended contracts still bill usage and late charges.
  usage: { statuses: [...LIVE, "expired", "terminated"], roles: BILLING_ROLES },
  electricity: { statuses: [...LIVE, "expired"], roles: BILLING_ROLES },
  // Deposits are collected up front on the proposal; top-ups only apply while the contract lives.
  deposit: { statuses: ["active", "renewal_in_progress"], roles: BILLING_ROLES },
  // Add-ons can be set up before activation and changed during the term.
  addon: { statuses: [...NOT_YET_ACTIVE, "active", "renewal_in_progress"], roles: BILLING_ROLES },
  // First invoice before activation; late fees and damages after. Never for a rejected or withdrawn contract.
  other: { statuses: [...NOT_YET_ACTIVE, ...LIVE, "expired", "terminated"], roles: CREATE_INVOICE_ROLES },
};

const ORDER: WizardChoiceKey[] = ["rent", "usage", "electricity", "deposit", "addon", "other"];

export function wizardChoices(status: string, role: string | null | undefined): WizardChoiceKey[] {
  if (!role) return [];
  return ORDER.filter((k) => RULES[k].statuses.includes(status) && RULES[k].roles.includes(role));
}

/** The button shows only for wizard roles with at least one card that applies. */
export function canUseInvoiceWizard(status: string, role: string | null | undefined): boolean {
  return !!role && (INVOICE_WIZARD_ROLES as readonly string[]).includes(role) && wizardChoices(status, role).length > 0;
}
