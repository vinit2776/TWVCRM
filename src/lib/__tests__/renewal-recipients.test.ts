import { describe, it, expect } from "vitest";
import { renewalRecipients, canEmail } from "@/lib/renewal-recipients";

const CLIENT = {
  client_name: "PRABIN KUMAR",
  client_company_name: "GIG Hospitality Private Limited",
  client_email: "prabin@gig.example",
  client_phone: "9800000001",
};

const AGG = {
  name: "Instaspaces",
  primary_email: "accounts@instaspaces.example",
  primary_phone: "9800000002",
};

describe("renewalRecipients", () => {
  it("routes a direct client to themselves, with no separate heads-up", () => {
    const r = renewalRecipients({ ...CLIENT, aggregator_id: null });
    expect(r.billing.kind).toBe("client");
    expect(r.billing.name).toBe("GIG Hospitality Private Limited");
    expect(r.headsUp).toBeNull();
    expect(r.blocked).toBeNull();
  });

  it("routes a postpaid aggregator case to the aggregator, client gets a heads-up", () => {
    // The 51-case majority. bill_to is null here and must not be consulted.
    const r = renewalRecipients({
      ...CLIENT,
      aggregator_id: "agg-1",
      bill_to: null,
      aggregator: { ...AGG, billing_method: "postpaid" },
    });
    expect(r.billing.kind).toBe("aggregator");
    expect(r.billing.email).toBe("accounts@instaspaces.example");
    expect(r.headsUp?.kind).toBe("client");
    expect(r.headsUp?.email).toBe("prabin@gig.example");
    expect(r.blocked).toBeNull();
  });

  it("honours bill_to = aggregator on a prepaid case", () => {
    const r = renewalRecipients({
      ...CLIENT,
      aggregator_id: "agg-1",
      bill_to: "aggregator",
      aggregator: { ...AGG, billing_method: "prepaid" },
    });
    expect(r.billing.kind).toBe("aggregator");
    expect(r.headsUp?.kind).toBe("client");
  });

  it("honours bill_to = client on a prepaid case, with no duplicate heads-up", () => {
    const r = renewalRecipients({
      ...CLIENT,
      aggregator_id: "agg-1",
      bill_to: "client",
      aggregator: { ...AGG, billing_method: "prepaid" },
    });
    expect(r.billing.kind).toBe("client");
    expect(r.headsUp).toBeNull();
  });

  it("blocks a prepaid case with no bill_to rather than guessing", () => {
    const r = renewalRecipients({
      ...CLIENT,
      aggregator_id: "agg-1",
      bill_to: null,
      aggregator: { ...AGG, billing_method: "prepaid" },
    });
    expect(r.blocked).toContain("bill_to is not set");
  });

  it("never lets a postpaid case fall through to the client as billing party", () => {
    // The specific failure voBillParty() would have produced.
    const r = renewalRecipients({
      ...CLIENT,
      aggregator_id: "agg-1",
      bill_to: null,
      aggregator: { ...AGG, billing_method: "postpaid" },
    });
    expect(r.billing.kind).not.toBe("client");
  });

  it("falls back to the contact name when no company is recorded", () => {
    const r = renewalRecipients({
      client_name: "Vikas Bhardwaj",
      client_company_name: null,
      aggregator_id: null,
    });
    expect(r.billing.name).toBe("Vikas Bhardwaj");
  });

  it("still routes when the chosen party has no email, so the caller can report it", () => {
    const r = renewalRecipients({
      ...CLIENT,
      aggregator_id: "agg-1",
      bill_to: null,
      aggregator: { name: "Caajib", billing_method: "postpaid", primary_email: null },
    });
    expect(r.billing.kind).toBe("aggregator");
    expect(canEmail(r.billing)).toBe(false);
    expect(canEmail(r.headsUp)).toBe(true);
  });
});
