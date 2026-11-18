import { describe, expect, it } from "vitest";
import { invoiceReasonFor } from "../invoice-reason";

const r = (statement_type: string | null, extra: Record<string, unknown> = {}) =>
  invoiceReasonFor({ line_items: { statement_type }, ...extra });

describe("invoiceReasonFor", () => {
  it("maps contract statements by type", () => {
    expect(r("rent", { contract: {} })?.label).toBe("Monthly rent");
    expect(r("usage", { contract: {} })?.label).toBe("Usage and services");
    expect(r("combined", { contract: {} })?.label).toBe("Rent + usage");
    expect(r("electricity", { contract: {} })?.group).toBe("recurring");
  });
  it("recognises reimbursement and Virtual Office", () => {
    expect(r("reimbursement", { contract: {} })).toMatchObject({ label: "Reimbursement", group: "one_off" });
    expect(r("vo_renewal")?.group).toBe("virtual_office");
    expect(r("vo_aggregator_consolidated")?.label).toBe("Virtual Office · Aggregator");
  });
  it("calls an ad-hoc invoice ad hoc whatever its statement_type", () => {
    expect(r("combined", { invoice: {} })?.label).toBe("Ad hoc invoice");
  });
  it("calls a proposal-owned statement without a contract the first month", () => {
    expect(r("rent", { proposal: {} })?.label).toBe("First month (pro-rata)");
    expect(r("rent", { proposal: {}, contract: {} })?.label).toBe("Monthly rent");
  });
  it("gives no stamp when nothing identifies it", () => {
    expect(r(null)).toBeNull();
    expect(r("mystery")).toBeNull();
  });
});
