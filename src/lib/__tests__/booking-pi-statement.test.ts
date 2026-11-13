import { describe, it, expect } from "vitest";
import {
  addDaysYmd, bookingNoLongerOwes, bookingPiChaseable, bookingPiDueDate, bookingPaymentMarker, mirroredRowsToRemove,
  paymentsToMirror, statementPaymentStatus, todayIstYmd,
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

describe("statementPaymentStatus", () => {
  it("is unpaid, partial, then paid as money arrives", () => {
    expect(statementPaymentStatus({ total: 1180, paid: 0, bookingPaid: false, tolerance: 23 })).toBe("unpaid");
    expect(statementPaymentStatus({ total: 1180, paid: 500, bookingPaid: false, tolerance: 23 })).toBe("partially_paid");
    expect(statementPaymentStatus({ total: 1180, paid: 1160, bookingPaid: false, tolerance: 23 })).toBe("paid");
  });

  it("follows the booking when it is already paid", () => {
    expect(statementPaymentStatus({ total: 1180, paid: 0, bookingPaid: true, tolerance: 23 })).toBe("paid");
  });

  it("goes back to partial when the total grows after a payment (add-on)", () => {
    // Paid 1,180 against a PI of 1,180, then a 590 add-on lifts the total to 1,770.
    expect(statementPaymentStatus({ total: 1770, paid: 1180, bookingPaid: false, tolerance: 35 })).toBe("partially_paid");
  });
});

describe("bookingNoLongerOwes", () => {
  it("is true for cancelled, no-show, waived, prepaid and posted-to-bill", () => {
    expect(bookingNoLongerOwes({ status: "cancelled", payment_status: "pending" })).toBe(true);
    expect(bookingNoLongerOwes({ status: "no_show", payment_status: "pending" })).toBe(true);
    expect(bookingNoLongerOwes({ status: "confirmed", payment_status: "waived" })).toBe(true);
    expect(bookingNoLongerOwes({ status: "confirmed", payment_status: "posted_to_bill" })).toBe(true);
  });

  it("is false while the booking is live and owing or paid", () => {
    expect(bookingNoLongerOwes({ status: "confirmed", payment_status: "pending" })).toBe(false);
    expect(bookingNoLongerOwes({ status: "checked_out", payment_status: "paid" })).toBe(false);
  });
});

describe("mirroredRowsToRemove", () => {
  it("removes only mirrors whose booking payment is no longer verified", () => {
    const existing = [
      { payment_reference: bookingPaymentMarker("a") },
      { payment_reference: bookingPaymentMarker("b") },
      { payment_reference: "pay_manual" },
      { payment_reference: null },
    ];
    expect(mirroredRowsToRemove(existing, ["a"])).toEqual([{ payment_reference: bookingPaymentMarker("b") }]);
  });
});

describe("bookingPiChaseable", () => {
  const live = { status: "confirmed", payment_status: "pending" };
  const base = { booking: live, emailedAt: "2026-11-13T10:00:00Z", proformaSentAt: null, balance: 1180 };

  it("chases a delivered PI with a balance on a live booking", () => {
    expect(bookingPiChaseable(base)).toBe(true);
  });

  it("never chases a PI the customer was not sent", () => {
    expect(bookingPiChaseable({ ...base, emailedAt: null, proformaSentAt: null })).toBe(false);
  });

  it("stops once nothing is left to pay", () => {
    expect(bookingPiChaseable({ ...base, balance: 0 })).toBe(false);
  });

  it("stops when the booking is cancelled, waived or billed elsewhere", () => {
    expect(bookingPiChaseable({ ...base, booking: { status: "cancelled", payment_status: "pending" } })).toBe(false);
    expect(bookingPiChaseable({ ...base, booking: { status: "confirmed", payment_status: "waived" } })).toBe(false);
    expect(bookingPiChaseable({ ...base, booking: null })).toBe(false);
  });
});
