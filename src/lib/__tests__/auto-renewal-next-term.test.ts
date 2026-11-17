import { describe, expect, it } from "vitest";
import { canActivateNow, decideNextTerm, parseRollMode, rentMatchesNotice } from "@/lib/auto-renewal-next-term";

const base = { today: "2026-12-01", endDate: "2026-12-31", held: false, hasRenewal: false, rateNoticeSent: true };

describe("parseRollMode", () => {
  it("never reads an unknown value as live", () => {
    expect(parseRollMode("live")).toBe("live");
    expect(parseRollMode(undefined)).toBe("dry_run");
    expect(parseRollMode("on")).toBe("dry_run");
  });
});

describe("decideNextTerm", () => {
  it("prepares once the rate notice is out and the 45-day window is open", () => {
    expect(decideNextTerm(base)).toEqual({ prepare: true });
    expect(decideNextTerm({ ...base, today: "2026-11-16" })).toEqual({ prepare: true });
  });
  it("waits for the window", () => {
    expect(decideNextTerm({ ...base, today: "2026-11-15" })).toEqual({ prepare: false, reason: "too_early" });
  });
  it("never before the customer has been told the rate", () => {
    expect(decideNextTerm({ ...base, rateNoticeSent: false })).toEqual({ prepare: false, reason: "notice_not_sent" });
  });
  it("never for a held contract, or when a renewal already exists", () => {
    expect(decideNextTerm({ ...base, held: true })).toEqual({ prepare: false, reason: "held" });
    expect(decideNextTerm({ ...base, hasRenewal: true })).toEqual({ prepare: false, reason: "already_exists" });
  });
  it("never after the term has ended", () => {
    expect(decideNextTerm({ ...base, today: "2027-01-02" })).toEqual({ prepare: false, reason: "term_ended" });
  });
});

describe("rentMatchesNotice", () => {
  it("allows rounding but nothing else", () => {
    expect(rentMatchesNotice(16500, 16500)).toBe(true);
    expect(rentMatchesNotice(16500.2, 16500)).toBe(true);
    expect(rentMatchesNotice(16000, 16500)).toBe(false);
  });
});

describe("canActivateNow", () => {
  it("opens on the roll date", () => {
    expect(canActivateNow("2026-12-31", "2027-01-01")).toBe(false);
    expect(canActivateNow("2027-01-01", "2027-01-01")).toBe(true);
  });
});
