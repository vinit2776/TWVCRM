import { describe, it, expect } from "vitest";
import { billingRouteOf, watermarkPolicy } from "@/lib/agreement-watermark-policy";

const postpaid = { aggregator_id: "a", aggregator: { billing_method: "postpaid" } };
const prepaid  = { aggregator_id: "a", aggregator: { billing_method: "prepaid" } };
const direct   = { aggregator_id: null };

describe("billingRouteOf", () => {
  it("reads the route off the aggregator, defaulting a case with none to direct", () => {
    expect(billingRouteOf(postpaid)).toBe("postpaid");
    expect(billingRouteOf(prepaid)).toBe("prepaid");
    expect(billingRouteOf(direct)).toBe("direct");
  });

  it("treats an aggregator with no billing_method as prepaid, not postpaid", () => {
    // Erring the other way would release clean copies on unconfigured partners.
    expect(billingRouteOf({ aggregator_id: "a", aggregator: {} })).toBe("prepaid");
  });
});

describe("watermarkPolicy", () => {
  it("forces the watermark on an unpaid prepaid case", () => {
    const p = watermarkPolicy({ case: prepaid, hasPaidInvoice: false, isDraft: true });
    expect(p.forced).toBe(true);
    expect(p.reason).toContain("prepaid billing");
  });

  it("forces it on an unpaid direct case too", () => {
    const p = watermarkPolicy({ case: direct, hasPaidInvoice: false, isDraft: true });
    expect(p.forced).toBe(true);
    expect(p.reason).toContain("billed directly");
  });

  it("releases the lock once the invoice is paid", () => {
    expect(watermarkPolicy({ case: prepaid, hasPaidInvoice: true, isDraft: true }).forced).toBe(false);
    expect(watermarkPolicy({ case: direct, hasPaidInvoice: true, isDraft: true }).forced).toBe(false);
  });

  it("never locks a postpaid case, paid or not", () => {
    expect(watermarkPolicy({ case: postpaid, hasPaidInvoice: false, isDraft: true }).forced).toBe(false);
    expect(watermarkPolicy({ case: postpaid, hasPaidInvoice: true, isDraft: true }).forced).toBe(false);
  });

  it("reports an executed agreement as settled, with no lock to apply", () => {
    const p = watermarkPolicy({ case: prepaid, hasPaidInvoice: false, isDraft: false });
    expect(p.settled).toBe(true);
    expect(p.forced).toBe(false);
  });
});
