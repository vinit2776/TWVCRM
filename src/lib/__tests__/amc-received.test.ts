import { describe, it, expect } from "vitest";
import { amcNotReceived } from "@/lib/procurement/amc-received";

describe("amcNotReceived", () => {
  it("warns until the item is received", () => {
    for (const status of ["pending", "ordered", "partially_received"]) {
      expect(amcNotReceived({ status })).toBe(true);
    }
  });
  it("never applies to a service PO, which has no goods to receive", () => {
    expect(amcNotReceived({ status: "ordered", po_type: "service" })).toBe(false);
    expect(amcNotReceived({ status: "ordered", po_type: "goods" })).toBe(true);
  });
  it("is quiet once received, billed, or when terminated", () => {
    for (const status of ["received", "invoice_received", "invoice_approved"]) {
      expect(amcNotReceived({ status })).toBe(false);
    }
    expect(amcNotReceived({ status: "ordered", amc_terminated_at: "2026-11-01T00:00:00Z" })).toBe(false);
  });
});

import { assetGaps, assetsNeedingDetails, linesWithoutAsset, purchaseReceived, receiptHref } from "@/lib/procurement/amc-received";

describe("asset details", () => {
  it("lists what an asset lacks", () => {
    expect(assetGaps({ id: "a", name: "AC", serial_number: "S1", location_id: "l" })).toEqual([]);
    expect(assetGaps({ id: "a", name: " ", serial_number: null, location_id: null })).toEqual(["name", "serial number", "location"]);
  });
  it("flags an asset still at the Procured stage, but not an older asset with no stage", () => {
    const base = { id: "a", name: "AC", serial_number: "S", location_id: "l" };
    expect(assetGaps({ ...base, lifecycle_stage: "procured" })).toEqual(["receipt at the location (stage is still Procured)"]);
    expect(assetGaps({ ...base, lifecycle_stage: "operational" })).toEqual([]);
    expect(assetGaps({ ...base, lifecycle_stage: null })).toEqual([]);
  });
  it("lists each incomplete asset once", () => {
    const a = { id: "a", name: "AC", serial_number: null, location_id: "l" };
    const out = assetsNeedingDetails([a, a, { id: "b", name: "UPS", serial_number: "S", location_id: "l" }]);
    expect(out).toHaveLength(1);
    expect(out[0].gaps).toEqual(["serial number"]);
  });
});

describe("delivery challan receipt", () => {
  const base = { id: "a", name: "AC", serial_number: "S", location_id: "l", procurement_po_id: "p" };
  it("warns until a challan is logged or the PO is received", () => {
    expect(assetGaps({ ...base, purchase_po: { id: "po1", po_number: "PO-1", status: "ordered", dc_count: 0 } })).toEqual(["delivery challan not received on PO-1"]);
    expect(assetGaps({ ...base, purchase_po: { id: "po1", po_number: "PO-1", status: "ordered", dc_count: 1 } })).toEqual([]);
    expect(assetGaps({ ...base, purchase_po: { id: "po1", po_number: "PO-1", status: "received", dc_count: 0 } })).toEqual([]);
  });
  it("purchaseReceived treats invoice stages as received", () => {
    expect(purchaseReceived({ id: "p", po_number: "P", status: "invoice_approved", dc_count: 0 })).toBe(true);
    expect(purchaseReceived({ id: "p", po_number: "P", status: "partially_received", dc_count: 0 })).toBe(false);
  });
  it("falls back to the Procured stage only when there is no purchase PO", () => {
    expect(assetGaps({ id: "a", name: "AC", serial_number: "S", location_id: "l", lifecycle_stage: "procured" })).toHaveLength(1);
    expect(assetGaps({ ...base, lifecycle_stage: "procured", purchase_po: { id: "p", po_number: "P", status: "received", dc_count: 1 } })).toEqual([]);
  });
});

describe("linesWithoutAsset", () => {
  it("names lines that are not assets", () => {
    expect(linesWithoutAsset([{ item_name: "AC", linked_asset_id: "a" }, { item_name: "Toner" }, { item_name: " " }])).toEqual(["Toner", "Unnamed line"]);
  });
});

describe("receiptHref", () => {
  it("points to the purchase PO only while the challan is missing", () => {
    const a = { id: "a", procurement_po_id: "po1" };
    expect(receiptHref({ ...a, purchase_po: { id: "po1", po_number: "PO-1", status: "ordered", dc_count: 0 } })).toBe("/procurement/orders/po1");
    expect(receiptHref({ ...a, purchase_po: { id: "po1", po_number: "PO-1", status: "ordered", dc_count: 1 } })).toBeNull();
    expect(receiptHref(a)).toBeNull();
  });
});
