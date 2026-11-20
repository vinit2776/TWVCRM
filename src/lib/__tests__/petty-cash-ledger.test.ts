import { describe, it, expect } from "vitest";
import { reconcile, LEDGER_KIND_LABELS } from "../petty-cash-ledger";

describe("reconcile", () => {
  it("matches when rows add up to the balance", () => {
    expect(reconcile([3200, -450, 5000, -1450], 6300)).toMatchObject({ ledgerTotal: 6300, matches: true, difference: 0 });
  });
  it("reports the gap when they do not", () => {
    expect(reconcile([1000, -200], 900)).toMatchObject({ ledgerTotal: 800, matches: false, difference: 100 });
  });
  it("is not fooled by floating point", () => {
    expect(reconcile([0.1, 0.2], 0.3).matches).toBe(true);
  });
  it("an empty statement matches a zero balance only", () => {
    expect(reconcile([], 0).matches).toBe(true);
    expect(reconcile([], 10).matches).toBe(false);
  });
});

describe("labels", () => {
  it("has a plain label for every kind", () => {
    expect(Object.values(LEDGER_KIND_LABELS).every((l) => l.length > 3)).toBe(true);
  });
});
