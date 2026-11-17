import { describe, it, expect } from "vitest";
import { resolveVendorBillRef } from "@/lib/electricity-vendor-bill";

describe("resolveVendorBillRef", () => {
  it("uses the payable created with the bill", () => {
    expect(resolveVendorBillRef({ vendor_bill_id: "vb-1" })).toEqual({ id: "vb-1", origin: "created" });
  });

  it("finds an uploaded vendor bill that was linked to the bill", () => {
    expect(resolveVendorBillRef({ vendor_bill_id: null, source_vendor_bill_id: "vb-up" })).toEqual({ id: "vb-up", origin: "uploaded" });
  });

  it("falls back to the revised-from payable before an uploaded one", () => {
    expect(resolveVendorBillRef({ vendor_bill_id: null }, "vb-old")).toEqual({ id: "vb-old", origin: "created" });
  });

  it("reports nothing when no payable exists", () => {
    expect(resolveVendorBillRef({})).toEqual({ id: null, origin: null });
    expect(resolveVendorBillRef({ vendor_bill_id: null, source_vendor_bill_id: null }, null)).toEqual({ id: null, origin: null });
  });
});
