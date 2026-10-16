import { describe, it, expect } from "vitest";
import { poStatusAfterWithdraw } from "../procurement/po-status-after-withdraw";

const base = {
  poType: "goods",
  poStatus: "invoice_received",
  statusBeforeBill: null as string | null,
  otherBills: [] as Array<{ approval_status: string }>,
  items: [{ quantity_ordered: 10, quantity_received: 10 }],
};

describe("poStatusAfterWithdraw", () => {
  it("uses the remembered status when there is one", () => {
    // mark_received can force 'received' with short quantities; trust what was stored.
    expect(poStatusAfterWithdraw({ ...base, statusBeforeBill: "received", items: [{ quantity_ordered: 10, quantity_received: 4 }] })).toBe("received");
  });

  it("derives from received quantities on older bills", () => {
    expect(poStatusAfterWithdraw(base)).toBe("received");
    expect(poStatusAfterWithdraw({ ...base, items: [{ quantity_ordered: 10, quantity_received: 4 }] })).toBe("partially_received");
    expect(poStatusAfterWithdraw({ ...base, items: [{ quantity_ordered: 10, quantity_received: 0 }] })).toBe("ordered");
    expect(poStatusAfterWithdraw({ ...base, items: [] })).toBe("ordered");
  });

  it("leaves the PO alone while another live bill remains", () => {
    expect(poStatusAfterWithdraw({ ...base, otherBills: [{ approval_status: "pending" }] })).toBeNull();
    expect(poStatusAfterWithdraw({ ...base, poStatus: "invoice_approved", otherBills: [{ approval_status: "approved" }, { approval_status: "pending" }] })).toBeNull();
  });

  it("ignores rejected and withdrawn siblings", () => {
    expect(poStatusAfterWithdraw({ ...base, statusBeforeBill: "ordered", otherBills: [{ approval_status: "rejected" }, { approval_status: "withdrawn" }] })).toBe("ordered");
  });

  it("leaves service POs and moved-on POs alone", () => {
    expect(poStatusAfterWithdraw({ ...base, poType: "service" })).toBeNull();
    expect(poStatusAfterWithdraw({ ...base, poStatus: "cancelled" })).toBeNull();
    expect(poStatusAfterWithdraw({ ...base, poStatus: "received" })).toBeNull();
  });
});
