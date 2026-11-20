import { describe, expect, it } from "vitest";
import { voCaseRepriceBlockedReason } from "@/lib/vo-case-reprice";

const ok = { status: "docs_received", hasLiveInvoice: false, agreementStatuses: ["draft"], cardPurpose: "gst_new" };

describe("voCaseRepriceBlockedReason", () => {
  it("allows a case still being prepared", () => {
    expect(voCaseRepriceBlockedReason(ok)).toBeNull();
    expect(voCaseRepriceBlockedReason({ ...ok, status: "internal_approved", agreementStatuses: [] })).toBeNull();
  });
  it.each(["invoiced", "paid", "active", "renewal_due", "lapsed"])("blocks %s", (status) => {
    expect(voCaseRepriceBlockedReason({ ...ok, status })).toMatch(/cannot be re-priced/);
  });
  it("blocks when an invoice exists", () => {
    expect(voCaseRepriceBlockedReason({ ...ok, hasLiveInvoice: true })).toMatch(/invoice/i);
  });
  it.each(["sent_to_client", "client_approved", "signing", "executed"])("blocks once the agreement is %s", (s) => {
    expect(voCaseRepriceBlockedReason({ ...ok, agreementStatuses: ["draft", s] })).toMatch(/agreement/);
  });
  it("blocks a purpose with no card", () => {
    expect(voCaseRepriceBlockedReason({ ...ok, cardPurpose: null })).toMatch(/rate card/);
  });
});
