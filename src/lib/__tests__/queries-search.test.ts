import { describe, expect, it } from "vitest";
import { buildSearchBlob, matchesSearchTokens, searchTokens } from "@/lib/queries/search";

const blob = buildSearchBlob([
  "Acme Ltd",
  "BS-0563",
  17700,
  "Priya Shah",
  "Floor manager",
  "Booking",
  "Whose walk-in was this?",
  "Café Rahul",
]);
const hit = (q: string) => matchesSearchTokens(blob, searchTokens(q));

describe("queries search", () => {
  it("finds by customer, reference, person and role", () => {
    expect(hit("acme")).toBe(true);
    expect(hit("bs-0563")).toBe(true);
    expect(hit("priya")).toBe(true);
    expect(hit("floor manager")).toBe(true);
  });
  it("matches amounts however they are typed", () => {
    expect(hit("17,700")).toBe(true);
    expect(hit("₹17700")).toBe(true);
    expect(hit("rs. 17,700")).toBe(true);
    expect(hit("18,000")).toBe(false);
  });
  it("needs every word, in any field", () => {
    expect(hit("acme 17700 priya")).toBe(true);
    expect(hit("acme 99999")).toBe(false);
  });
  it("ignores case and accents", () => {
    expect(hit("CAFE")).toBe(true);
  });
  it("matches message text", () => {
    expect(hit("walk-in")).toBe(true);
  });
});
