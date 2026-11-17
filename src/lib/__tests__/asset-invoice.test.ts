import { describe, it, expect } from "vitest";
import { isInvoiceDoc, assetIdsWithInvoice } from "@/lib/facility/asset-invoice";

describe("isInvoiceDoc", () => {
  it("recognises the new kind and the older invoice labels", () => {
    expect(isInvoiceDoc({ doc_kind: "invoice", label: "Other" })).toBe(true);
    expect(isInvoiceDoc({ label: "Purchase Invoice" })).toBe(true);
    expect(isInvoiceDoc({ label: "Tax Invoice" })).toBe(true);
  });
  it("does not treat other documents as invoices", () => {
    expect(isInvoiceDoc({ label: "Warranty Card" })).toBe(false);
    expect(isInvoiceDoc({ doc_kind: null, label: "AMC Contract" })).toBe(false);
  });
});

describe("assetIdsWithInvoice", () => {
  const fake = (result: { data: unknown; error: unknown }) =>
    ({ from: () => ({ select: () => ({ in: () => ({ or: () => Promise.resolve(result) }) }) }) }) as never;

  it("returns the assets that have an invoice", async () => {
    const out = await assetIdsWithInvoice(fake({ data: [{ asset_id: "a" }, { asset_id: "b" }], error: null }), ["a", "b", "c"]);
    expect([...(out ?? [])].sort()).toEqual(["a", "b"]);
  });
  it("returns null on a failed lookup so nothing is falsely flagged", async () => {
    expect(await assetIdsWithInvoice(fake({ data: null, error: { message: "boom" } }), ["a"])).toBeNull();
  });
  it("returns an empty set without querying when there are no assets", async () => {
    expect((await assetIdsWithInvoice(fake({ data: [], error: null }), []))?.size).toBe(0);
  });
});
