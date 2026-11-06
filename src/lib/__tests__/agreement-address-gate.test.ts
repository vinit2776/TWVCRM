import { describe, it, expect } from "vitest";
import { agreementAddressGate } from "../agreement-address-gate";

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
