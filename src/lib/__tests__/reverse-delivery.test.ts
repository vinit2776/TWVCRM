import { describe, it, expect } from "vitest";
import {
  resolveStockLocationId,
  resolveStockItemId,
  isReceiptLive,
  validateReversalRequest,
} from "../procurement/reverse-delivery";

describe("resolveStockLocationId", () => {
  it("prefers the value stored on the receipt when present", () => {
    expect(resolveStockLocationId("receipt-loc", "po-loc", "pr-loc")).toBe("receipt-loc");
  });

  it("falls back to the PO's location_id when the receipt has none (legacy receipt)", () => {
    expect(resolveStockLocationId(null, "po-loc", "pr-loc")).toBe("po-loc");
    expect(resolveStockLocationId(undefined, "po-loc", "pr-loc")).toBe("po-loc");
  });

  it("falls back to the linked Purchase Request's location_id when neither the receipt nor the PO has one", () => {
    expect(resolveStockLocationId(null, null, "pr-loc")).toBe("pr-loc");
  });

  it("returns null when nothing in the fallback chain resolves", () => {
    expect(resolveStockLocationId(null, null, null)).toBeNull();
    expect(resolveStockLocationId(undefined, undefined, undefined)).toBeNull();
  });
});

describe("resolveStockItemId", () => {
  it("prefers the value stored on the receipt item when present", () => {
    expect(resolveStockItemId("receipt-item", "po-item", "pr-item")).toBe("receipt-item");
  });

  it("falls back to the PO item's item_id when the receipt item has none (legacy receipt item)", () => {
    expect(resolveStockItemId(null, "po-item", "pr-item")).toBe("po-item");
    expect(resolveStockItemId(undefined, "po-item", "pr-item")).toBe("po-item");
  });

  it("falls back to the linked Purchase Request item's item_id when neither the receipt item nor the PO item has one", () => {
    expect(resolveStockItemId(null, null, "pr-item")).toBe("pr-item");
  });

  it("returns null when nothing in the fallback chain resolves", () => {
    expect(resolveStockItemId(null, null, null)).toBeNull();
    expect(resolveStockItemId(undefined, undefined, undefined)).toBeNull();
  });
});

describe("isReceiptLive", () => {
  it("is live when reversed_at is null or undefined", () => {
    expect(isReceiptLive(null)).toBe(true);
    expect(isReceiptLive(undefined)).toBe(true);
  });

  it("is not live once reversed_at is set", () => {
    expect(isReceiptLive("2026-08-20T00:00:00.000Z")).toBe(false);
  });
});

describe("validateReversalRequest", () => {
  it("allows a delete of a live receipt with no reversedBy/reason", () => {
    expect(
      validateReversalRequest({
        disposition: "delete",
        currentReversedAt: null,
      })
    ).toEqual({ ok: true });
  });

  it("allows a retain of a live receipt when both reversedBy and reason are present", () => {
    expect(
      validateReversalRequest({
        disposition: "retain",
        reversedBy: "user-1",
        reason: "PO cancelled",
        currentReversedAt: null,
      })
    ).toEqual({ ok: true });
  });

  it("rejects a retain with no reversedBy", () => {
    const result = validateReversalRequest({
      disposition: "retain",
      reason: "PO cancelled",
      currentReversedAt: null,
    });
    expect(result.ok).toBe(false);
  });

  it("rejects a retain with a blank reason", () => {
    const result = validateReversalRequest({
      disposition: "retain",
      reversedBy: "user-1",
      reason: "   ",
      currentReversedAt: null,
    });
    expect(result.ok).toBe(false);
  });

  it("rejects a retain with no reason at all", () => {
    const result = validateReversalRequest({
      disposition: "retain",
      reversedBy: "user-1",
      currentReversedAt: null,
    });
    expect(result.ok).toBe(false);
  });

  it("THE MOST DANGEROUS BUG: refuses to reverse an already-reversed receipt, for delete", () => {
    const result = validateReversalRequest({
      disposition: "delete",
      currentReversedAt: "2026-08-19T10:00:00.000Z",
    });
    expect(result).toEqual({
      ok: false,
      error: "This delivery receipt has already been reversed",
    });
  });

  it("THE MOST DANGEROUS BUG: refuses to reverse an already-reversed receipt, for retain — even with valid reversedBy/reason", () => {
    const result = validateReversalRequest({
      disposition: "retain",
      reversedBy: "user-1",
      reason: "PO cancelled again?!",
      currentReversedAt: "2026-08-19T10:00:00.000Z",
    });
    expect(result).toEqual({
      ok: false,
      error: "This delivery receipt has already been reversed",
    });
  });

  it("checks the already-reversed guard before the reversedBy/reason guard", () => {
    // An already-reversed receipt with a retain request that's ALSO missing
    // reversedBy/reason must still report the double-reversal error, not the
    // half-populated-reversal error — the double-reversal is the dangerous one.
    const result = validateReversalRequest({
      disposition: "retain",
      currentReversedAt: "2026-08-19T10:00:00.000Z",
    });
    expect(result).toEqual({
      ok: false,
      error: "This delivery receipt has already been reversed",
    });
  });
});
