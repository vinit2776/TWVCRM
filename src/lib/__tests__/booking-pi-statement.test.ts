import { describe, it, expect } from "vitest";
import {
  addDaysYmd, bookingPiDueDate, bookingPaymentMarker, paymentsToMirror, todayIstYmd,
} from "../booking-pi-statement";

describe("due date", () => {
  it("is 7 days after the PI date, crossing month ends", () => {
    expect(addDaysYmd("2026-11-28", 7)).toBe("2026-12-05");
    expect(addDaysYmd("2026-12-28", 7)).toBe("2027-01-04");
  });

  it("uses the IST calendar day, not UTC", () => {
    // 20:00 UTC on 13 Nov is already 14 Nov in IST.
    const now = new Date("2026-11-13T20:00:00Z");
    expect(todayIstYmd(now)).toBe("2026-11-14");
    expect(bookingPiDueDate(now)).toBe("2026-11-21");
  });
});

describe("paymentsToMirror", () => {
  const pay = (id: string, rzp: string | null = null) => ({
    id, amount: 1180, payment_mode: "cash", payment_reference: null,
    razorpay_payment_id: rzp, created_at: "2026-11-13T10:00:00Z",
  });

  it("copies a verified payment that is not on the statement yet", () => {
    expect(paymentsToMirror([pay("a")], [])).toHaveLength(1);
  });

  it("skips one already mirrored by marker", () => {
    const existing = [{ payment_reference: bookingPaymentMarker("a"), razorpay_payment_id: null }];
    expect(paymentsToMirror([pay("a")], existing)).toHaveLength(0);
  });

  it("skips one the webhook already recorded by Razorpay payment id", () => {
    const existing = [{ payment_reference: "pay_X", razorpay_payment_id: "pay_X" }];
    expect(paymentsToMirror([pay("a", "pay_X")], existing)).toHaveLength(0);
  });
});
