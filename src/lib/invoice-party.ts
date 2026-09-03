/**
 * Who an ad-hoc proforma invoice bills.
 *
 * These used to be raised only against a lead, so every surface resolved the
 * buyer by reading invoice.lead. They can now also be raised against a
 * Virtual Office case, which has no lead — the buyer comes from the case's
 * billing route instead.
 *
 * That routing is not reimplemented here: it delegates to
 * renewalRecipients(), the same resolver the renewal notices use, so a case
 * cannot bill one party for its renewal and a different one for an ad-hoc
 * charge. Postpaid aggregators are billed regardless of bill_to (a
 * prepaid-only field, null for them); prepaid honours bill_to; direct clients
 * bill themselves.
 */
import { renewalRecipients, type RenewalRoutableCase } from "@/lib/renewal-recipients";

export interface InvoiceLeadLike {
  first_name?: string | null;
  last_name?: string | null;
  company?: string | null;
  email?: string | null;
  phone?: string | null;
  mobile?: string | null;
  gst_number?: string | null;
}

export interface InvoiceCaseLike extends RenewalRoutableCase {
  case_number?: string | null;
  client_gst_number?: string | null;
  aggregator?: (RenewalRoutableCase["aggregator"] & { gst_number?: string | null }) | null;
}

export interface InvoiceParty {
  /** Who the invoice is addressed to and who the payment link is for. */
  name: string;
  email: string | null;
  phone: string | null;
  gstin: string | null;
  /** Where the buyer came from — drives what the UI says. */
  source: "lead" | "case-aggregator" | "case-client";
  /** For a partner-billed case, the client the charge actually concerns. */
  onBehalfOf: string | null;
  /** Set when routing cannot be determined and nothing should be raised. */
  blocked: string | null;
}

export function leadName(lead: InvoiceLeadLike): string {
  return (
    lead.company ||
    [lead.first_name, lead.last_name].filter(Boolean).join(" ") ||
    "(unnamed)"
  );
}

export function invoiceParty(source: {
  lead?: InvoiceLeadLike | null;
  case?: InvoiceCaseLike | null;
  /** Bill the client directly even on a partner-billed case. */
  billClientOverride?: boolean;
}): InvoiceParty | null {
  const c = source.case;

  if (c) {
    const routing = renewalRecipients(c);
    const clientName = c.client_company_name || c.client_name;

    // An override bills the end client for something they caused, even where
    // the case itself is billed to a partner.
    if (source.billClientOverride) {
      return {
        name: clientName,
        email: c.client_email ?? null,
        phone: c.client_phone ?? null,
        gstin: c.client_gst_number ?? null,
        source: "case-client",
        onBehalfOf: null,
        blocked: null,
      };
    }

    const billsAggregator = routing.billing.kind === "aggregator";
    return {
      name: routing.billing.name,
      email: routing.billing.email,
      phone: routing.billing.phone,
      gstin: billsAggregator
        ? c.aggregator?.gst_number ?? null
        : c.client_gst_number ?? null,
      source: billsAggregator ? "case-aggregator" : "case-client",
      // Named on the invoice so a partner holding many cases can tell them
      // apart; meaningless when the client is the one being billed.
      onBehalfOf: billsAggregator ? clientName : null,
      blocked: routing.blocked,
    };
  }

  if (source.lead) {
    return {
      name: leadName(source.lead),
      email: source.lead.email ?? null,
      phone: source.lead.phone || source.lead.mobile || null,
      gstin: source.lead.gst_number ?? null,
      source: "lead",
      onBehalfOf: null,
      blocked: null,
    };
  }

  return null;
}
