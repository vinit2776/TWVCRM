/**
 * Who a Virtual Office renewal notice goes to.
 *
 * The renewal library historically knew only about client_email and
 * client_phone, so every notice — and every payment link — went straight to
 * the end client. 51 of 58 cases are billed to a postpaid aggregator who owns
 * the client relationship, which made that a channel-conflict problem rather
 * than a mis-addressed email: TWV would be soliciting a partner's customer
 * directly, at scale, from an automated job.
 *
 * Notices now follow the billing route:
 *
 *   postpaid aggregator            -> aggregator      (bill_to is not used)
 *   prepaid aggregator, bill_to    -> whoever bill_to names
 *   direct client                  -> the client
 *
 * The end client also receives a heads-up whenever the billing party is
 * someone else, carrying the amount and the payment link, so they can renew
 * directly if the partner does not.
 *
 * Note this deliberately does NOT reuse voBillParty() from tally-handoff. That
 * resolves the buyer of a *billing statement*, where a postpaid aggregator is
 * identified by the statement's own aggregator_id. On a *case*, bill_to is a
 * prepaid-only field and is null for postpaid — so voBillParty would fall
 * through and name the client, which is the wrong answer for all 51 of them.
 */

export type RenewalPartyKind = "aggregator" | "client";

export interface RenewalRecipient {
  kind: RenewalPartyKind;
  name: string;
  email: string | null;
  phone: string | null;
}

export interface RenewalRouting {
  /** Receives the full notice and is asked to settle it. */
  billing: RenewalRecipient;
  /** The end client, when they are not already the billing party. */
  headsUp: RenewalRecipient | null;
  /** Set when routing cannot be determined; nothing should be sent. */
  blocked: string | null;
}

export interface RenewalRoutableCase {
  client_name: string;
  client_company_name?: string | null;
  client_email?: string | null;
  client_phone?: string | null;
  aggregator_id?: string | null;
  bill_to?: "aggregator" | "client" | null;
  aggregator?: {
    name?: string | null;
    billing_method?: string | null;
    primary_email?: string | null;
    primary_phone?: string | null;
  } | null;
}

function clientRecipient(c: RenewalRoutableCase): RenewalRecipient {
  return {
    kind: "client",
    name: c.client_company_name || c.client_name,
    email: c.client_email ?? null,
    phone: c.client_phone ?? null,
  };
}

function aggregatorRecipient(c: RenewalRoutableCase): RenewalRecipient {
  return {
    kind: "aggregator",
    name: c.aggregator?.name || "(aggregator)",
    email: c.aggregator?.primary_email ?? null,
    phone: c.aggregator?.primary_phone ?? null,
  };
}

export function renewalRecipients(c: RenewalRoutableCase): RenewalRouting {
  const client = clientRecipient(c);

  // Direct client — nobody stands between TWV and them.
  if (!c.aggregator_id) {
    return { billing: client, headsUp: null, blocked: null };
  }

  const isPostpaid = c.aggregator?.billing_method === "postpaid";

  // Postpaid aggregators are invoiced monthly in arrears for all their cases,
  // so the aggregator is always the billing party. bill_to is a prepaid-only
  // field and is null here — reading it would misroute every postpaid case.
  if (isPostpaid) {
    return { billing: aggregatorRecipient(c), headsUp: client, blocked: null };
  }

  // Prepaid: bill_to was chosen per case when the invoice was raised.
  if (c.bill_to === "aggregator") {
    return { billing: aggregatorRecipient(c), headsUp: client, blocked: null };
  }
  if (c.bill_to === "client") {
    return { billing: client, headsUp: null, blocked: null };
  }

  // Prepaid with no bill_to: the case was never invoiced, so nobody has
  // decided who pays. Guessing here would either solicit a partner's client
  // or bill a partner for something they never agreed to.
  return {
    billing: client,
    headsUp: null,
    blocked: "bill_to is not set on this prepaid-aggregator case — choose who to bill before sending a renewal notice.",
  };
}

/** True when this party can actually be reached by email. */
export function canEmail(r: RenewalRecipient | null): boolean {
  return !!r?.email;
}
