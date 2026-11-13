import { describe, it, expect } from "vitest";
import {
  canVoTransition,
  customerResponseBlockedReason,
  effectiveExpiry,
  isVoProposalExpired,
  termFee,
  validateVoTerm,
  voReissueBlockedReason,
  voWithdrawBlockedReason,
  voExpiryFrom,
} from "../vo-proposal";

const SENT = "2026-11-01T00:00:00.000Z";

describe("validateVoTerm", () => {
  it.each([11, 12, 24, 36, 48])("accepts %i", (m) => expect(validateVoTerm(m)).toBeNull());
  it.each([0, 6, 13, 60, 12.5, "12", null])("rejects %s", (m) => expect(validateVoTerm(m)).not.toBeNull());
});

describe("termFee", () => {
  it("is the rate itself up to 12 months", () => {
    expect(termFee(12000, 11)).toBe(12000);
    expect(termFee(12000, 12)).toBe(12000);
  });
  it("treats the rate as annual above 12 months", () => {
    expect(termFee(12000, 24)).toBe(24000);
    expect(termFee(12000, 36)).toBe(36000);
    expect(termFee(12000, 48)).toBe(48000);
  });
});

describe("transitions", () => {
  it("allows customer responses from sent and viewed", () => {
    for (const to of ["accepted", "changes_requested", "declined"]) {
      expect(canVoTransition("sent", to)).toBe(true);
      expect(canVoTransition("viewed", to)).toBe(true);
    }
  });
  it("lets a dead proposal only be superseded", () => {
    for (const from of ["withdrawn", "declined", "expired"]) {
      expect(canVoTransition(from, "superseded")).toBe(true);
      expect(canVoTransition(from, "accepted")).toBe(false);
    }
  });
  it("treats accepted and superseded as terminal", () => {
    expect(canVoTransition("accepted", "withdrawn")).toBe(false);
    expect(canVoTransition("superseded", "sent")).toBe(false);
  });
});

describe("expiry", () => {
  it("is 7 days after sending", () => {
    expect(voExpiryFrom(SENT).toISOString()).toBe("2026-11-08T00:00:00.000Z");
  });
  it("is enforced only for the virtual_office kind", () => {
    const std = { kind: "standard", sent_at: SENT };
    expect(effectiveExpiry(std)).toBeNull();
    expect(isVoProposalExpired(std, new Date("2027-01-01"))).toBe(false);
  });
  it("prefers expires_at and falls back to sent_at + 7 days", () => {
    const now = new Date("2026-11-05T00:00:00.000Z");
    expect(isVoProposalExpired({ kind: "virtual_office", sent_at: SENT }, now)).toBe(false);
    expect(isVoProposalExpired({ kind: "virtual_office", sent_at: SENT, expires_at: "2026-11-04T00:00:00.000Z" }, now)).toBe(true);
    expect(isVoProposalExpired({ kind: "virtual_office" }, now)).toBe(false);
  });
});

describe("customerResponseBlockedReason", () => {
  const now = new Date("2026-11-05T00:00:00.000Z");
  const vo = { kind: "virtual_office", status: "sent", sent_at: SENT };
  it("allows a live sent or viewed proposal", () => {
    expect(customerResponseBlockedReason(vo, now)).toBeNull();
    expect(customerResponseBlockedReason({ ...vo, status: "viewed" }, now)).toBeNull();
  });
  it("blocks an expired offer even if the cron has not run", () => {
    expect(customerResponseBlockedReason(vo, new Date("2026-11-09T00:00:00.000Z"))).toMatch(/expired/);
  });
  it("blocks withdrawn, superseded, answered and standard proposals", () => {
    expect(customerResponseBlockedReason({ ...vo, status: "withdrawn" }, now)).toMatch(/withdrawn/);
    expect(customerResponseBlockedReason({ ...vo, status: "superseded" }, now)).toMatch(/newer/);
    expect(customerResponseBlockedReason({ ...vo, status: "accepted" }, now)).toMatch(/already/);
    expect(customerResponseBlockedReason({ ...vo, kind: "standard" }, now)).not.toBeNull();
  });
});

describe("staff action guards", () => {
  const vo = { kind: "virtual_office", status: "sent" };
  it("withdraws only live VO proposals with no money", () => {
    expect(voWithdrawBlockedReason(vo)).toBeNull();
    expect(voWithdrawBlockedReason({ ...vo, status: "accepted" })).not.toBeNull();
    expect(voWithdrawBlockedReason({ ...vo, payment_status: "paid" })).not.toBeNull();
    expect(voWithdrawBlockedReason({ ...vo, kind: "standard" })).not.toBeNull();
  });
  it("reissues from live and dead states but not accepted or superseded", () => {
    for (const status of ["sent", "viewed", "changes_requested", "withdrawn", "declined", "expired"]) {
      expect(voReissueBlockedReason({ ...vo, status })).toBeNull();
    }
    expect(voReissueBlockedReason({ ...vo, status: "accepted" })).not.toBeNull();
    expect(voReissueBlockedReason({ ...vo, status: "superseded" })).not.toBeNull();
    expect(voReissueBlockedReason({ ...vo, kind: "standard" })).not.toBeNull();
    expect(voReissueBlockedReason({ ...vo, deposit_credit_amount: 10 })).not.toBeNull();
  });
});
