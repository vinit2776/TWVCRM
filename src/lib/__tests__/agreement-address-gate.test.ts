import { describe, it, expect } from "vitest";
import { agreementAddressGate, agreementAddressIsStale, caseAddressText, cleanAddressText, unprintableAddressChars } from "../agreement-address-gate";

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

describe("cleanAddressText", () => {
  it("puts a multi-line address on one line with no trailing comma", () => {
    expect(cleanAddressText("No. 148, C Block\nBarracks Road ,\r\nChennai - 600007,\n")).toBe("No. 148, C Block Barracks Road, Chennai - 600007");
  });
  it("swaps curly punctuation and long dashes for plain ones", () => {
    expect(cleanAddressText("‘A’ Block – “Rose”")).toBe("'A' Block - \"Rose\"");
  });
  it("is what caseAddressText prints", () => {
    expect(caseAddressText({ client_address: "1 Main Road\n", client_city: "Chennai", client_state: null, client_pincode: "600007" })).toBe("1 Main Road, Chennai, 600007");
  });
});

describe("unprintable characters in an address", () => {
  it("names letters from another script and blocks the agreement", () => {
    expect(unprintableAddressChars("Dist: Chennai.ка Vepery 600007")).toEqual(["к", "а"]);
    const r = agreementAddressGate("Dist: Chennai.ка Vepery 600007");
    expect(r.blocked).toBe(true);
    expect(r.reason).toMatch(/cannot print/);
  });
  it("accepts accented Latin letters and curly punctuation", () => {
    expect(unprintableAddressChars("Café Lane, ‘A’ Block, 600007")).toEqual([]);
  });
});

describe("agreementAddressIsStale with line breaks", () => {
  it("treats a multi-line case address and its one-line print as the same", () => {
    expect(agreementAddressIsStale("1 Main Road\nChennai 600007\n", "1 Main Road Chennai 600007")).toBe(false);
  });
});
