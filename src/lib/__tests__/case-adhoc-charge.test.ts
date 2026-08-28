import { describe, it, expect } from "vitest";
import { computeAdhocCharge, AdhocChargeError, type AdhocChargeCase } from "@/lib/case-adhoc-charge";

const base: AdhocChargeCase = {
  id: "case-1",
  case_number: "TWV-CASE-0051",
  case_source: "aggregator",
  bill_to: null,
  client_name: "KAMALESHAN F",
  client_company_name: "GLOTRENDZ PRIVATE LIMITED",
  client_gst_number: "33AAACG1111A1Z5",
  aggregator_id: "agg-1",
  aggregator: {
    name: "Instaspaces",
    gst_number: "07AAACI2222B1Z5",
    same_state_as_twv: true,
    billing_method: "postpaid",
  },
};

const charge = { description: "Mail handling — 14 letters over allowance", amount: 140 };

describe("computeAdhocCharge — who it bills", () => {
  it("bills the aggregator on a postpaid case, ignoring the null bill_to", () => {
    const r = computeAdhocCharge(base, charge);
    expect(r.billTo).toBe("aggregator");
    expect(r.buyerName).toBe("Instaspaces");
    expect(r.buyerGstin).toBe("07AAACI2222B1Z5");
  });

  it("still names the end client, so a partner can tell its cases apart", () => {
    expect(computeAdhocCharge(base, charge).endClientName).toBe("GLOTRENDZ PRIVATE LIMITED");
  });

  it("bills the client on a direct case", () => {
    const r = computeAdhocCharge(
      { ...base, case_source: "direct", aggregator_id: null, aggregator: null },
      charge,
    );
    expect(r.billTo).toBe("client");
    expect(r.buyerGstin).toBe("33AAACG1111A1Z5");
  });

  it("honours bill_to on a prepaid case", () => {
    const prepaid = { ...base, aggregator: { ...base.aggregator!, billing_method: "prepaid" } };
    expect(computeAdhocCharge({ ...prepaid, bill_to: "aggregator" }, charge).billTo).toBe("aggregator");
    expect(computeAdhocCharge({ ...prepaid, bill_to: "client" }, charge).billTo).toBe("client");
  });

  it("refuses a prepaid case with no bill_to rather than guessing", () => {
    const prepaid = { ...base, aggregator: { ...base.aggregator!, billing_method: "prepaid" }, bill_to: null };
    expect(() => computeAdhocCharge(prepaid, charge)).toThrow(AdhocChargeError);
  });

  it("lets an override bill the client on a partner-billed case", () => {
    // Mail overage the client caused, on a postpaid case.
    const r = computeAdhocCharge(base, { ...charge, billToOverride: "client" });
    expect(r.billTo).toBe("client");
    expect(r.buyerGstin).toBe("33AAACG1111A1Z5");
  });

  it("an override also unblocks a prepaid case with no bill_to", () => {
    const prepaid = { ...base, aggregator: { ...base.aggregator!, billing_method: "prepaid" }, bill_to: null };
    expect(computeAdhocCharge(prepaid, { ...charge, billToOverride: "client" }).billTo).toBe("client");
  });
});

describe("computeAdhocCharge — the money", () => {
  it("adds 18% GST, split CGST/SGST in state", () => {
    const r = computeAdhocCharge(base, { description: "x", amount: 1000 });
    expect(r.subtotal).toBe(1000);
    expect(r.gstAmount).toBe(180);
    expect(r.cgst).toBe(90);
    expect(r.sgst).toBe(90);
    expect(r.igst).toBe(0);
    expect(r.total).toBe(1180);
  });

  it("charges IGST when the billed aggregator is out of state", () => {
    const outOfState = { ...base, aggregator: { ...base.aggregator!, same_state_as_twv: false } };
    const r = computeAdhocCharge(outOfState, { description: "x", amount: 1000 });
    expect(r.isInterstate).toBe(true);
    expect(r.igst).toBe(180);
    expect(r.cgst).toBe(0);
  });

  it("never treats a client-billed charge as interstate", () => {
    // Cases carry no state of their own, so a client charge is always in-state.
    const outOfState = { ...base, aggregator: { ...base.aggregator!, same_state_as_twv: false } };
    const r = computeAdhocCharge(outOfState, { description: "x", amount: 1000, billToOverride: "client" });
    expect(r.isInterstate).toBe(false);
    expect(r.cgst).toBe(90);
  });

  it("rounds a fractional amount to paise", () => {
    const r = computeAdhocCharge(base, { description: "x", amount: 33.333 });
    expect(r.subtotal).toBe(33.33);
  });
});

describe("computeAdhocCharge — refusals", () => {
  it("requires a description", () => {
    expect(() => computeAdhocCharge(base, { description: "   ", amount: 100 })).toThrow(/description/i);
  });

  it("requires a positive amount", () => {
    expect(() => computeAdhocCharge(base, { description: "x", amount: 0 })).toThrow(/greater than zero/i);
    expect(() => computeAdhocCharge(base, { description: "x", amount: -50 })).toThrow(/greater than zero/i);
    expect(() => computeAdhocCharge(base, { description: "x", amount: NaN })).toThrow(/greater than zero/i);
  });
});
