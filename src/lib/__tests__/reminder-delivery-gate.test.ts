import { describe, it, expect } from "vitest";
import { hasReachedCustomer } from "../payment-reminder";

/**
 * The dunning ladder must never chase a customer for an invoice that never
 * left the building. A statement is finalized and due-dated BEFORE it is
 * dispatched, so `status` proves nothing about delivery — only the per-path
 * delivery stamps do.
 */
describe("hasReachedCustomer", () => {
  it("Proforma First — delivered once proforma_sent_at is stamped", () => {
    expect(hasReachedCustomer({ proforma_sent_at: "2026-08-17T10:00:00Z" })).toBe(true);
  });

  it("GST Direct (CRM-issued) — delivered once emailed_at is stamped", () => {
    expect(hasReachedCustomer({ emailed_at: "2026-08-17T10:00:00Z" })).toBe(true);
  });

  it("Tally-issued — delivered once tally_delivered_at is stamped", () => {
    expect(hasReachedCustomer({ tally_delivered_at: "2026-08-17T10:00:00Z" })).toBe(true);
  });

  it("a raised-but-never-sent statement is NOT delivered", () => {
    // The exact shape a failed dispatch leaves behind: finalized, due-dated,
    // sitting in AR, with no stamp from any channel.
    expect(hasReachedCustomer({
      proforma_sent_at: null,
      emailed_at: null,
      tally_delivered_at: null,
    })).toBe(false);
  });

  it("missing fields are treated as undelivered, not assumed sent", () => {
    expect(hasReachedCustomer({})).toBe(false);
  });

  it("empty strings do not count as delivery", () => {
    expect(hasReachedCustomer({ proforma_sent_at: "", emailed_at: "", tally_delivered_at: "" })).toBe(false);
  });

  it("any one stamp is enough — paths are alternatives, not requirements", () => {
    expect(hasReachedCustomer({ proforma_sent_at: null, emailed_at: "2026-08-17T10:00:00Z" })).toBe(true);
    expect(hasReachedCustomer({ emailed_at: null, tally_delivered_at: "2026-08-17T10:00:00Z" })).toBe(true);
  });
});
