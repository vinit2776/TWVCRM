import { describe, it, expect } from "vitest";
import { buildAgreementEmail, parseCcList } from "@/lib/case-agreement-email";

const client = {
  client_name: "Ravi Kumar",
  client_company_name: "Acme Labs Pvt Ltd",
  client_email: "ravi@acmelabs.in",
  location: { name: "Nungambakkam LGF" },
  case_number: "TWV-CASE-0099",
};

describe("buildAgreementEmail", () => {
  it("writes to the client on a direct case", () => {
    const e = buildAgreementEmail(client);
    expect(e.to).toBe("ravi@acmelabs.in");
    expect(e.toKind).toBe("client");
    expect(e.onBehalfOf).toBeNull();
    expect(e.subject).toContain("Your Leave & License Agreement");
    expect(e.blocked).toBeNull();
  });

  it("writes to the aggregator on a postpaid case, naming the client", () => {
    const e = buildAgreementEmail({
      ...client,
      aggregator_id: "agg-1",
      aggregator: { name: "Qdesq", billing_method: "postpaid", primary_email: "ops@qdesq.com" },
    });
    expect(e.to).toBe("ops@qdesq.com");
    expect(e.toKind).toBe("aggregator");
    expect(e.onBehalfOf).toBe("Acme Labs Pvt Ltd");
    // A partner holding many cases needs to know which one this is.
    expect(e.subject).toContain("Acme Labs Pvt Ltd");
    expect(e.html).toContain("Acme Labs Pvt Ltd");
  });

  it("honours bill_to on a prepaid aggregator case", () => {
    const prepaid = {
      ...client,
      aggregator_id: "agg-1",
      aggregator: { name: "Quicku", billing_method: "prepaid", primary_email: "accounts@spacen.in" },
    };
    expect(buildAgreementEmail({ ...prepaid, bill_to: "aggregator" as const }).to)
      .toBe("accounts@spacen.in");
    expect(buildAgreementEmail({ ...prepaid, bill_to: "client" as const }).to)
      .toBe("ravi@acmelabs.in");
  });

  it("blocks when the routed party has no address", () => {
    const e = buildAgreementEmail({
      ...client,
      client_email: null,
      aggregator_id: "agg-1",
      aggregator: { name: "NSS IT", billing_method: "postpaid", primary_email: null },
    });
    expect(e.to).toBeNull();
    expect(e.blocked).toContain("No email address on record");
  });

  it("escapes a client name so it cannot inject markup into the body", () => {
    const e = buildAgreementEmail({ ...client, client_company_name: "<script>x</script> Ltd" });
    expect(e.html).not.toContain("<script>");
    expect(e.html).toContain("&lt;script&gt;");
  });
});

describe("parseCcList", () => {
  it("splits on commas, semicolons and newlines, and de-duplicates", () => {
    const { emails, invalid } = parseCcList("a@b.com, c@d.com; a@b.com\ne@f.com");
    expect(emails).toEqual(["a@b.com", "c@d.com", "e@f.com"]);
    expect(invalid).toEqual([]);
  });

  it("reports malformed addresses instead of silently dropping them", () => {
    const { emails, invalid } = parseCcList("good@x.com, notanemail, also bad@");
    expect(emails).toEqual(["good@x.com"]);
    expect(invalid).toEqual(["notanemail", "also bad@"]);
  });

  it("treats an empty box as no CC", () => {
    expect(parseCcList("").emails).toEqual([]);
    expect(parseCcList(undefined).emails).toEqual([]);
  });
});
