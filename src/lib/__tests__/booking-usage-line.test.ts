import { describe, it, expect } from "vitest";
import { usageLine, formatRs, overageWorkings, monthYearLabel } from "../booking-usage-line";

const base = {
  unit_price: 1000,
  booking_charge_kind: "pooled_usage",
  facility_name: "Conference Room",
};

describe("usageLine", () => {
  it("shows hours billed so qty x rate = amount (free quota applied)", () => {
    const l = usageLine({
      ...base, description: "x", quantity: 5.5, total: 2500, charge_date: "2026-07-01",
      booking: { booking_number: "TWV-B-0124", check_in_at: "2026-07-01T09:09:31Z", check_out_at: "2026-07-01T14:36:15Z" },
    });
    expect(l.quantity).toBe(2.5);
    expect(l.quantity * l.unitPrice).toBe(l.amount);
    expect(l.description).toBe("Conference Room: 1 Jul, TWV-B-0124");
    expect(l.workings).toBe("2:39 pm to 8:06 pm: 5.5 h used, 3 h free = 2.5 h billed x Rs. 1,000 per hour");
  });

  it("reports zero free hours once the quota is used up", () => {
    const l = usageLine({
      ...base, description: "x", quantity: 4.5, total: 4500, charge_date: "2026-07-06",
      booking: { booking_number: "TWV-B-0136" },
    });
    expect(l.quantity).toBe(4.5);
    expect(l.description).toBe("Conference Room: 6 Jul, TWV-B-0136");
    expect(l.workings).toBe("4.5 h used, 0 h free = 4.5 h billed x Rs. 1,000 per hour");
  });

  it("repairs the 4 x 1000 = 1000 print bug", () => {
    const l = usageLine({ ...base, description: "x", quantity: 4, total: 1000, charge_date: "2026-10-08", booking: { booking_number: "TWV-B-0256" } });
    expect(l.quantity).toBe(1);
    expect(l.amount).toBe(1000);
  });

  it("leaves non-booking and legacy charges untouched", () => {
    const manual = usageLine({ description: "Ad-hoc", quantity: 3, unit_price: 200, total: 600, charge_date: "2026-07-01" });
    expect(manual).toEqual({ description: "Ad-hoc", workings: "3 x Rs. 200", quantity: 3, unitPrice: 200, amount: 600 });
    const legacy = usageLine({ ...base, booking_charge_kind: "quota_overage", description: "Overage", quantity: 2, total: 2000, charge_date: "2026-07-01", booking: { booking_number: "B" } });
    expect(legacy.description).toBe("Overage");
  });
});

import { bookingChargeView, bookingChargeTotals } from "../booking-usage-line";

describe("bookingChargeView", () => {
  const row = {
    description: "x", quantity: 5.5, unit_price: 1000, total: 2500, charge_date: "2026-07-01",
    booking_charge_kind: "pooled_usage",
    booking: { id: "b1", booking_number: "TWV-B-0124", check_in_at: "2026-07-01T09:09:31Z", check_out_at: "2026-07-01T14:36:15Z" },
    contract_facility: { name: "Conference Room" },
  };

  it("builds a title, detail and billed hours for a live booking charge", () => {
    const v = bookingChargeView(row)!;
    expect(v.title).toBe("Conference Room · 1 Jul");
    expect(v.detail).toBe("2:39 pm to 8:06 pm · used 5.5 h, free 3 h");
    expect(v.billedHours).toBe(2.5);
    expect(v.bookingId).toBe("b1");
  });

  it("uses the waive-time snapshot for a waived charge", () => {
    const v = bookingChargeView({ ...row, quantity: 5, total: 0, unit_price: 0, status: "waived", is_waived: true, original_unit_price: 1000, original_total: 5000 })!;
    expect(v.billedHours).toBe(5);
    expect(v.freeHours).toBe(0);
    expect(v.unitPrice).toBe(1000);
  });

  it("keeps billed hours for a charge waived from the statement (amount retained)", () => {
    const v = bookingChargeView({ ...row, quantity: 4.5, total: 1350, unit_price: 300, is_waived: true })!;
    expect(v.billedHours).toBe(4.5);
    expect(v.freeHours).toBe(0);
  });

  it("shows a system-waived within-quota charge as all free", () => {
    const v = bookingChargeView({ ...row, quantity: 1, total: 0, unit_price: 1000, status: "waived" })!;
    expect(v.billedHours).toBe(0);
    expect(v.freeHours).toBe(1);
  });

  it("returns null for non-booking charges", () => {
    expect(bookingChargeView({ description: "Ad-hoc", quantity: 1, unit_price: 100, total: 100 })).toBeNull();
    expect(bookingChargeView({ ...row, booking_charge_kind: "quota_overage" })).toBeNull();
  });

  it("totals used, free and billed hours", () => {
    const a = bookingChargeView(row)!;
    const b = bookingChargeView({ ...row, quantity: 4.5, total: 4500, booking: { id: "b2", booking_number: "TWV-B-0136" } })!;
    expect(bookingChargeTotals([a, b])).toEqual({ count: 2, usedHours: 10, freeHours: 3, billedHours: 7 });
  });
});


describe("workings text", () => {
  it("formats rupees as plain text with Indian grouping", () => {
    expect(formatRs(1000)).toBe("Rs. 1,000");
    expect(formatRs(12.5)).toBe("Rs. 12.5");
    expect(formatRs(1250000)).toBe("Rs. 12,50,000");
  });
  it("spells out metered usage for print and facilities", () => {
    expect(overageWorkings({ used: 158, free: 70, over: 88, rate: 5, unit: "page" })).toBe("158 pages used, 70 free = 88 over x Rs. 5 per page");
    expect(overageWorkings({ used: 4, free: 0, over: 4, rate: 15, unit: "page" })).toBe("4 pages used, 0 free = 4 over x Rs. 15 per page");
    expect(overageWorkings({ used: 1, free: 0, over: 1, rate: 15, unit: "page" })).toBe("1 page used, 0 free = 1 over x Rs. 15 per page");
    expect(overageWorkings({ used: 12, free: 4, over: 8, rate: 700, unit: "hr" })).toBe("12 hrs used, 4 free = 8 over x Rs. 700 per hr");
  });
  it("labels the usage month", () => {
    expect(monthYearLabel(2026, 9)).toBe("September 2026");
  });
});
