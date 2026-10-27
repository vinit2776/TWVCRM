import { describe, it, expect } from "vitest";
import { canSeeElectricityRebilling, stripRebilling } from "@/lib/electricity-visibility";

describe("canSeeElectricityRebilling", () => {
  it("allows accounts, admin and manager", () => {
    for (const r of ["accounts", "admin", "manager"]) expect(canSeeElectricityRebilling(r)).toBe(true);
  });
  it("refuses everyone else, including a missing role", () => {
    for (const r of ["office_admin", "sales_rep", "fms", "floor_manager", "", null, undefined]) {
      expect(canSeeElectricityRebilling(r as string | null | undefined)).toBe(false);
    }
  });
});

describe("stripRebilling", () => {
  it("drops customer_ columns and empties customer_bills, keeps payable data", () => {
    const out = stripRebilling({
      id: "a",
      landlord_total_amount: 100,
      customer_total: 150,
      customer_subtotal: 120,
      customer_bills: [{ id: "x" }],
      vendor_bill: { id: "v" },
    });
    expect(out).toEqual({ id: "a", landlord_total_amount: 100, vendor_bill: { id: "v" }, customer_bills: [] });
  });
});
