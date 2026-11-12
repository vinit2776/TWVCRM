/**
 * Whether a Leave & License agreement may leave the building without the DRAFT
 * watermark.
 *
 * The watermark is a commercial control, not a formatting choice. On a route
 * where the customer pays before occupying, a clean unexecuted agreement is a
 * document they can print, sign and act on before any money has arrived — so
 * the mark stays until it has. Where the customer is billed in arrears there is
 * no payment to withhold it against, and a clean copy is theirs to print.
 *
 * Deliberately computed, never stored: nobody can tick their way out of a lock,
 * and the answer changes on its own the moment an invoice is settled.
 */
export type BillingRoute = "prepaid" | "postpaid" | "direct";

export interface WatermarkPolicyCase {
  aggregator_id?: string | null;
  aggregator?: { name?: string | null; billing_method?: string | null } | null;
}

export interface WatermarkPolicy {
  route: BillingRoute;
  /** True when the watermark cannot be switched off. */
  forced: boolean;
  /** Plain-language why, shown beside the checkbox. */
  reason: string;
  /**
   * True once the agreement is signed, stamped or executed — there is no
   * watermark at all then, and no control to show.
   */
  settled: boolean;
}

export function billingRouteOf(c: WatermarkPolicyCase): BillingRoute {
  if (!c.aggregator_id) return "direct";
  return c.aggregator?.billing_method === "postpaid" ? "postpaid" : "prepaid";
}

export function watermarkPolicy(args: {
  case: WatermarkPolicyCase;
  /** A vo_case invoice exists for this case and is settled. */
  hasPaidInvoice: boolean;
  /** From isDraftAgreement() — false once signed/stamped/executed. */
  isDraft: boolean;
}): WatermarkPolicy {
  const route = billingRouteOf(args.case);

  if (!args.isDraft) {
    return {
      route,
      forced: false,
      settled: true,
      reason: "This agreement is executed — copies are never watermarked.",
    };
  }

  // Postpaid partners are invoiced monthly in arrears, so there is nothing to
  // withhold the document against.
  if (route === "postpaid") {
    return {
      route,
      forced: false,
      settled: false,
      reason: "Untick to release a clean copy for printing on stamp paper.",
    };
  }

  if (args.hasPaidInvoice) {
    return {
      route,
      forced: false,
      settled: false,
      reason: "Payment received — untick to release a clean copy.",
    };
  }

  const label = route === "direct" ? "billed directly" : "prepaid billing";
  return {
    route,
    forced: true,
    settled: false,
    reason: `Required until payment is received — ${label}.`,
  };
}
