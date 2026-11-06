import { describe, it, expect } from "vitest";
import { agreementAddressGate, agreementAddressIsStale, caseAddressText } from "../agreement-address-gate";

describe("agreementAddressGate", () => {
  it("blocks empty, null and the placeholder", () => {
    expect(agreementAddressGate(null).blocked).toBe(true);
    expect(agreementAddressGate("   ").blocked).toBe(true);
    expect(agreementAddressGate("To be provided").blocked).toBe(true);
  });
  it("blocks an address with no 6-digit pincode", () => {
    const r = agreementAddressGate("No. 148, C Block, Vepery, Chennai, Tamil Nadu");
    expect(r.blocked).toBe(true);
    expect(r.reason).toMatch(/pincode/);
  });
  it("blocks a pincode that is part of a longer number", () => {
    expect(agreementAddressGate("Flat 1234567, Chennai").blocked).toBe(true);
  });
  it("allows a full address with pincode", () => {
    expect(agreementAddressGate("No. 148, C Block, Vepery, Chennai, Tamil Nadu, 600007").blocked).toBe(false);
  });
});

describe("agreementAddressIsStale", () => {
  it("is stale when the case has an address the agreement lacks", () => {
    expect(agreementAddressIsStale("A, Chennai 600007", "To be provided")).toBe(true);
    expect(agreementAddressIsStale("A, Chennai 600007", "Old address")).toBe(true);
  });
  it("is not stale when they match ignoring spacing and case", () => {
    expect(agreementAddressIsStale("A,  Chennai 600007", "a, chennai 600007")).toBe(false);
  });
  it("is not stale when the case has no address", () => {
    expect(agreementAddressIsStale("", "To be provided")).toBe(false);
  });
});

describe("caseAddressText", () => {
  it("joins the filled parts in print order", () => {
    expect(caseAddressText({ client_address: "A", client_city: null, client_state: "TN", client_pincode: "600007" })).toBe("A, TN, 600007");
    expect(caseAddressText({})).toBe("");
  });
});
