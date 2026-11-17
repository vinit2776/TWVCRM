/**
 * Membership-agreement wording for recurring add-ons. A contract with none keeps
 * exactly the clauses it has always had, so only agreements that carry add-ons
 * read differently: the add-ons get their own schedule row, and the escalation
 * clauses say they are outside it.
 */

export interface AgreementAddon {
  description: string;
  /** Monthly amount, excluding GST. */
  amount: number;
  effective_from: string;
  effective_until?: string | null;
  is_active?: boolean;
}

/** The add-ons the agreement lists: those still billing. A paused one is not part of the deal being signed. */
export function agreementAddons<T extends AgreementAddon>(addons: T[] | null | undefined): T[] {
  return (addons ?? []).filter((a) => a.is_active !== false);
}

/** One line per add-on for schedule row 8A, e.g. "Valet car parking: Rs. 7,000 + GST per month, 19 Nov 2026 to 18 May 2027". */
export function addonScheduleText(
  addons: AgreementAddon[],
  contractEnd: string,
  formatMoney: (n: number) => string,
  formatDate: (ymd: string) => string
): string {
  const lines = addons.map(
    (a) =>
      `${a.description}: ${formatMoney(Number(a.amount))} + GST per month, ${formatDate(a.effective_from)} to ${formatDate(a.effective_until || contractEnd)}`
  );
  return (
    lines.join("\n") +
    "\n\nBilled together with the Monthly Membership Fees. Not subject to escalation. May be withdrawn on the Member's written request."
  );
}

export interface EscalationClauses {
  /** Schedule item 18. */
  autoRenewal: string;
  /** Schedule item 19. */
  escalation: string;
}

/** Item 18 prints a whole percent as "10.0" (as it always has) and a negotiated half percent as "12.5". */
const autoRenewalPercent = (n: number) => (Number.isInteger(n) ? `${n}.0` : `${n}`);

export function escalationClauses(escalation: number, tenureMonths: number, hasAddons: boolean): EscalationClauses {
  const pct = autoRenewalPercent(escalation);
  if (!hasAddons) {
    return {
      autoRenewal: `In case Notice for Termination (as defined below) is not served before the expiry of the Initial Term, the Membership Agreement will be auto-renewed for another Term, having the same Lock-in Period with escalation on Monthly Membership Fees & all other charges at ${pct} %.`,
      escalation: `${escalation} % on Monthly Membership Fees and all products and services after expiry of ${tenureMonths}.0 months commencing from the Commencement Date.`,
    };
  }
  return {
    autoRenewal: `In case Notice for Termination (as defined below) is not served before the expiry of the Initial Term, the Membership Agreement will be auto-renewed for another Term, having the same Lock-in Period with escalation on Monthly Membership Fees at ${pct} %. Recurring Add-ons listed in item 8A are not subject to escalation.`,
    escalation: `${escalation} % on Monthly Membership Fees after expiry of ${tenureMonths}.0 months commencing from the Commencement Date. Recurring Add-ons listed in item 8A are not subject to escalation.`,
  };
}
