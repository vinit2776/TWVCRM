import { describe, it, expect } from "vitest";
import { assetSearchTerms, assetTermFilter } from "@/lib/facility/asset-search";

describe("asset search", () => {
  it("splits what is typed into words", () => {
    expect(assetSearchTerms("hvac 68")).toEqual(["hvac", "68"]);
    expect(assetSearchTerms("  blue   star ")).toEqual(["blue", "star"]);
  });
  it("treats filter syntax as word breaks", () => {
    expect(assetSearchTerms("a,b(c)d*e")).toEqual(["a", "b", "c", "d", "e"]);
    expect(assetSearchTerms("50%")).toEqual(["50"]);
  });
  it("returns nothing for an empty search and caps the number of words", () => {
    expect(assetSearchTerms("   ")).toEqual([]);
    expect(assetSearchTerms("a b c d e f g h")).toHaveLength(6);
  });
  it("matches a word against name, code, serial, MAC, make and model", () => {
    const f = assetTermFilter("68");
    for (const c of ["name", "asset_code", "serial_number", "mac_address", "make", "model"]) {
      expect(f).toContain(`${c}.ilike.%68%`);
    }
  });
});
