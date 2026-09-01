import { describe, it, expect } from "vitest";
import { invoiceParty, type InvoiceCaseLike } from "@/lib/invoice-party";

const partnerCase: InvoiceCaseLike = {
  client_name: "KAMALESHAN F",
  client_company_name: "GLOTRENDZ PRIVATE LIMITED",
  client_email: "glotrendz.admin@example",
  client_phone: "9791114696",
  client_gst_number: "33AAACG1111A1Z5",
  aggregator_id: "agg-1",
  bill_to: null,
  aggregator: {
    name: "Instaspaces",
    billing_method: "postpaid",
    primary_email: "accounts@instaspaces.example",
    primary_phone: "9800000002",
    gst_number: "07AAACI2222B1Z5",
  },
};

describe("invoiceParty — cases", () => {
  it("bills the aggregator on a postpaid case, and names the client it concerns", () => {
    const p = invoiceParty({ case: partnerCase })!;
    expect(p.source).toBe("case-aggregator");
    expect(p.name).toBe("Instaspaces");
    expect(p.email).toBe("accounts@instaspaces.example");
    expect(p.gstin).toBe("07AAACI2222B1Z5");
    expect(p.onBehalfOf).toBe("GLOTRENDZ PRIVATE LIMITED");
  });

  it("bills the client on a direct case", () => {
    const p = invoiceParty({
      case: { ...partnerCase, aggregator_id: null, aggregator: null },
    })!;
    expect(p.source).toBe("case-client");
    expect(p.name).toBe("GLOTRENDZ PRIVATE LIMITED");
    expect(p.gstin).toBe("33AAACG1111A1Z5");
    expect(p.onBehalfOf).toBeNull();
  });

  it("honours the override to bill the client on a partner-billed case", () => {
    const p = invoiceParty({ case: partnerCase, billClientOverride: true })!;
    expect(p.source).toBe("case-client");
    expect(p.name).toBe("GLOTRENDZ PRIVATE LIMITED");
    expect(p.gstin).toBe("33AAACG1111A1Z5");
  });

  it("honours bill_to on a prepaid case", () => {
    const prepaid = { ...partnerCase, aggregator: { ...partnerCase.aggregator!, billing_method: "prepaid" } };
    expect(invoiceParty({ case: { ...prepaid, bill_to: "aggregator" } })!.source).toBe("case-aggregator");
    expect(invoiceParty({ case: { ...prepaid, bill_to: "client" } })!.source).toBe("case-client");
  });

  it("blocks a prepaid case with no bill_to rather than guessing", () => {
    const prepaid = {
      ...partnerCase,
      bill_to: null,
      aggregator: { ...partnerCase.aggregator!, billing_method: "prepaid" },
    };
    expect(invoiceParty({ case: prepaid })!.blocked).toContain("bill_to");
  });
});

describe("invoiceParty — leads", () => {
  it("uses the company where there is one", () => {
    const p = invoiceParty({
      lead: { first_name: "Prabin", last_name: "Kumar", company: "GIG Hospitality", email: "a@b.example" },
    })!;
    expect(p.source).toBe("lead");
    expect(p.name).toBe("GIG Hospitality");
  });

  it("falls back to the person's name, and to mobile when phone is absent", () => {
    const p = invoiceParty({ lead: { first_name: "Prabin", last_name: "Kumar", mobile: "9999900000" } })!;
    expect(p.name).toBe("Prabin Kumar");
    expect(p.phone).toBe("9999900000");
  });

  it("prefers the case when both are somehow present", () => {
    // A VO client may also exist as a lead; the case is the authority.
    const p = invoiceParty({ case: partnerCase, lead: { company: "Some Lead" } })!;
    expect(p.source).toBe("case-aggregator");
  });

  it("returns null when there is neither", () => {
    expect(invoiceParty({})).toBeNull();
  });
});
