import { describe, it, expect } from "vitest";
import { depositIsChaseable } from "@/lib/receivables";

const LINK = "plink_ABC123";

describe("depositIsChaseable", () => {
  it("chases an accepted proposal, link or no link", () => {
    expect(depositIsChaseable({ status: "accepted" })).toBe(true);
    expect(depositIsChaseable({ status: "accepted", deposit_razorpay_link_id: LINK })).toBe(true);
  });

  it("chases a sent or viewed proposal once a payment link has gone out", () => {
    // The case that prompted this: PROP-0056 and PROP-0062 sat sent, link
    // issued, due date lapsed in April, and nothing chased them.
    expect(depositIsChaseable({ status: "sent", deposit_razorpay_link_id: LINK })).toBe(true);
    expect(depositIsChaseable({ status: "viewed", deposit_razorpay_link_id: LINK })).toBe(true);
  });

  it("stays quiet on a sent proposal with no link — nothing concrete was asked for", () => {
    expect(depositIsChaseable({ status: "sent" })).toBe(false);
    expect(depositIsChaseable({ status: "viewed", deposit_razorpay_link_id: null })).toBe(false);
  });

  it("never chases a draft, even with a link generated early", () => {
    // A link on a draft is a reason to cancel it, not to dun someone who has
    // been sent nothing.
    expect(depositIsChaseable({ status: "draft", deposit_razorpay_link_id: LINK })).toBe(false);
  });

  it("never chases a rejected or expired proposal", () => {
    expect(depositIsChaseable({ status: "rejected", deposit_razorpay_link_id: LINK })).toBe(false);
    expect(depositIsChaseable({ status: "expired", deposit_razorpay_link_id: LINK })).toBe(false);
  });

  it("stops chasing once the link is cancelled, whatever the status", () => {
    expect(depositIsChaseable({
      status: "accepted", deposit_razorpay_link_id: LINK, deposit_link_cancelled_at: "2026-08-20T00:00:00Z",
    })).toBe(false);
    expect(depositIsChaseable({
      status: "sent", deposit_razorpay_link_id: LINK, deposit_link_cancelled_at: "2026-08-20T00:00:00Z",
    })).toBe(false);
  });

  it("keeps the old string form working for any caller not yet updated", () => {
    expect(depositIsChaseable("accepted")).toBe(true);
    expect(depositIsChaseable("sent")).toBe(false);
    expect(depositIsChaseable(null)).toBe(false);
    expect(depositIsChaseable(undefined)).toBe(false);
  });
});
