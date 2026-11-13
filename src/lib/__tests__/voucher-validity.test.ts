import { describe, it, expect } from "vitest";
import {
  MAX_UNIFI_VOUCHER_DAYS,
  MAX_UNIFI_VOUCHER_MINUTES,
  voucherValidUntil,
  voucherNeedsRenewalLater,
  voucherDaysRemaining,
} from "@/lib/voucher-validity";
import { calcVoucherMinutes, unifiFailureReason } from "@/lib/unifi";

// 2026-11-13 10:00 IST
const NOW = new Date("2026-11-13T04:30:00Z");

describe("voucherValidUntil", () => {
  it("keeps the contract end date when it is within the cap", () => {
    expect(voucherValidUntil("2027-06-30", NOW)).toBe("2027-06-30");
  });
  it("caps a longer contract at one year from today (IST)", () => {
    expect(voucherValidUntil("2030-01-01", NOW)).toBe("2027-11-13");
  });
});

describe("voucherNeedsRenewalLater", () => {
  it("is false inside the cap and true beyond it", () => {
    expect(voucherNeedsRenewalLater("2027-11-13", NOW)).toBe(false);
    expect(voucherNeedsRenewalLater("2027-11-14", NOW)).toBe(true);
  });
});

describe("voucherDaysRemaining", () => {
  it("counts calendar days, 0 on the last day, negative once past", () => {
    expect(voucherDaysRemaining("2026-11-13", NOW)).toBe(0);
    expect(voucherDaysRemaining("2026-12-13", NOW)).toBe(30);
    expect(voucherDaysRemaining("2026-11-10", NOW)).toBe(-3);
  });
  it("uses the IST date, not UTC, just after IST midnight", () => {
    // 2026-11-13 00:30 IST is still 2026-11-12 in UTC
    expect(voucherDaysRemaining("2026-11-14", new Date("2026-11-12T19:00:00Z"))).toBe(1);
  });
});

describe("calcVoucherMinutes cap", () => {
  it("never exceeds the UniFi cap, however far the end date is", () => {
    expect(calcVoucherMinutes("2035-01-01")).toBe(MAX_UNIFI_VOUCHER_MINUTES);
    expect(MAX_UNIFI_VOUCHER_MINUTES).toBe(MAX_UNIFI_VOUCHER_DAYS * 1440);
  });
  it("still returns at least 1 minute for a past date", () => {
    expect(calcVoucherMinutes("2000-01-01", 0)).toBe(1);
  });
});

describe("unifiFailureReason", () => {
  it("extracts the console's status and message only", () => {
    const err = new Error("[unifi] POST /cmd/hotspot → 400: api.err.IncorrectNumberRange");
    expect(unifiFailureReason(err)).toBe("400: api.err.IncorrectNumberRange");
  });
  it("falls back for non-UniFi errors", () => {
    expect(unifiFailureReason(new Error("fetch failed"))).toBe("no response from the UniFi console");
    expect(unifiFailureReason("x")).toBe("no response from the UniFi console");
  });
});
