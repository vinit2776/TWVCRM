import { describe, expect, it } from "vitest";
import { extractGstins, normalizePartyName, partyGstinInText, partyNameInText } from "../invoice-party-check";

describe("normalizePartyName", () => {
  it("treats legal-form variants as equal", () => {
    expect(normalizePartyName("ABC Pvt. Ltd.")).toBe(normalizePartyName("abc private limited"));
  });
  it("normalizes ampersands", () => {
    expect(normalizePartyName("Shah & Sons")).toBe("shah and sons");
  });
});

describe("partyNameInText", () => {
  const text = "Buyer: ABC TECHNOLOGIES PRIVATE LIMITED\nGSTIN 27ABCDE1234F1Z5";
  it("finds a name regardless of legal form", () => {
    expect(partyNameInText(text, ["ABC Technologies Pvt Ltd"])).toBe(true);
  });
  it("finds a name wrapped over lines", () => {
    expect(partyNameInText("ABC\nTECHNOLOGIES PRIVATE LIMITED", ["ABC Technologies"])).toBe(true);
  });
  it("flags a different customer", () => {
    expect(partyNameInText(text, ["XYZ Consulting LLP"])).toBe(false);
  });
  it("accepts any candidate", () => {
    expect(partyNameInText(text, ["XYZ Consulting", "ABC Technologies"])).toBe(true);
  });
  it("is unknown without candidates or text", () => {
    expect(partyNameInText(text, [null, ""])).toBeNull();
    expect(partyNameInText("   ", ["ABC"])).toBeNull();
  });
});

describe("partyGstinInText", () => {
  const text = "Seller 29AAAAA0000A1Z5 Buyer 27ABCDE1234F1Z5";
  it("finds the customer GSTIN among the seller's", () => {
    expect(extractGstins(text)).toHaveLength(2);
    expect(partyGstinInText(text, "27abcde1234f1z5")).toBe(true);
  });
  it("flags a GSTIN that is not printed", () => {
    expect(partyGstinInText(text, "07ZZZZZ9999Z1Z1")).toBe(false);
  });
  it("is unknown when the customer has none or the text shows none", () => {
    expect(partyGstinInText(text, null)).toBeNull();
    expect(partyGstinInText("no tax ids here", "27ABCDE1234F1Z5")).toBeNull();
  });
});
