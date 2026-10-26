import { describe, it, expect } from "vitest";
import {
  BOOKING_LATE_CLOSE_OUT,
  closeOutDecision,
  daysBetween,
  daysPastBooking,
  findReason,
  validateCloseOut,
} from "../process-registry";

// 26 Oct 2026, 10:00 IST
const NOW = new Date("2026-10-26T04:30:00Z");

describe("daysPastBooking", () => {
  it("is 0 on the day, in IST", () => {
    expect(daysPastBooking("2026-10-26", NOW)).toBe(0);
  });
  it("counts whole days after", () => {
    expect(daysPastBooking("2026-10-23", NOW)).toBe(3);
  });
  it("never goes negative for a future date", () => {
    expect(daysPastBooking("2026-10-30", NOW)).toBe(0);
  });
  it("uses the IST date, not UTC, just after midnight IST", () => {
    // 00:30 IST on 27 Oct is still 26 Oct in UTC
    expect(daysPastBooking("2026-10-26", new Date("2026-10-26T19:00:00Z"))).toBe(1);
  });
});

describe("daysBetween", () => {
  it("handles month boundaries", () => {
    expect(daysBetween("2026-10-30", "2026-11-02")).toBe(3);
  });
});

describe("closeOutDecision", () => {
  const base = { customer_type: "walk_in" };
  it("allows a confirmed booking from an earlier day", () => {
    expect(closeOutDecision({ ...base, status: "confirmed", booking_date: "2026-10-23" }, NOW))
      .toEqual({ allowed: true, daysLate: 3 });
  });
  it("sends a same-day booking to the normal flow", () => {
    const d = closeOutDecision({ ...base, status: "confirmed", booking_date: "2026-10-26" }, NOW);
    expect(d.allowed).toBe(false);
  });
  it("leaves a checked-in booking alone for a day, then allows it", () => {
    expect(closeOutDecision({ ...base, status: "checked_in", booking_date: "2026-10-25" }, NOW).allowed).toBe(false);
    expect(closeOutDecision({ ...base, status: "checked_in", booking_date: "2026-10-24" }, NOW).allowed).toBe(true);
  });
  it("refuses contract-holder bookings", () => {
    expect(closeOutDecision({ customer_type: "contract_holder", status: "confirmed", booking_date: "2026-10-01" }, NOW).allowed).toBe(false);
  });
  it("refuses finished bookings", () => {
    expect(closeOutDecision({ ...base, status: "checked_out", booking_date: "2026-10-01" }, NOW).allowed).toBe(false);
    expect(closeOutDecision({ ...base, status: "no_show", booking_date: "2026-10-01" }, NOW).allowed).toBe(false);
  });
});

describe("validateCloseOut", () => {
  it("accepts a normal request", () => {
    const r = validateCloseOut({ outcome: "used", reason_code: "payment_confusion", comment: "", accountable_user_id: "u1" });
    expect(r.ok).toBe(true);
  });
  it("needs an outcome and a known reason", () => {
    expect(validateCloseOut({ reason_code: "staff_forgot" }).ok).toBe(false);
    expect(validateCloseOut({ outcome: "used", reason_code: "bogus" }).ok).toBe(false);
  });
  it("needs a real comment for Other", () => {
    expect(validateCloseOut({ outcome: "used", reason_code: "other", comment: "short" }).ok).toBe(false);
    expect(validateCloseOut({ outcome: "used", reason_code: "other", comment: "walk-in paid at another desk" }).ok).toBe(true);
  });
  it("treats a blank accountable user as none", () => {
    const r = validateCloseOut({ outcome: "no_show", reason_code: "staff_forgot", accountable_user_id: "  " });
    expect(r.ok && r.value.accountable_user_id).toBe(null);
  });
});

describe("reasons", () => {
  it("marks system problems as not counting against the person", () => {
    expect(findReason(BOOKING_LATE_CLOSE_OUT, "system_problem")?.countsAgainstPerson).toBe(false);
    expect(findReason(BOOKING_LATE_CLOSE_OUT, "staff_forgot")?.countsAgainstPerson).toBe(true);
  });
});
