import { describe, it, expect } from "vitest";
import { buildBookingPi, bookingPiNumber, piBalanceDue } from "../booking-pi";

describe("buildBookingPi", () => {
  it("splits the room line from add-ons so lines add up to the stored total", () => {
    const pi = buildBookingPi({
      booking_number: "BK-0412",
      space_name: "Meeting room 2",
      duration_hours: 2,
      total_amount: 2000,
      gst_rate: 18,
      gst_amount: 360,
      total_amount_with_gst: 2950,
      addons: [
        { description: "Projector", quantity: 1, unit_price: 500, amount: 500, gst_rate: 18, gst_amount: 90, total_with_gst: 590 },
      ],
    });
    expect(pi.lines[0]).toMatchObject({ description: "Meeting room 2", quantity: 2, rate: 1000, amount: 2000, gst_amount: 360 });
    expect(pi.subtotal).toBe(2500);
    expect(pi.gst).toBe(450);
    expect(pi.total).toBe(2950);
  });

  it("falls back to quantity 1 when the duration is missing", () => {
    const pi = buildBookingPi({
      booking_number: null, space_name: "Day pass", duration_hours: null,
      total_amount: 500, gst_rate: 18, gst_amount: 90, total_amount_with_gst: 590, addons: [],
    });
    expect(pi.lines[0]).toMatchObject({ quantity: 1, rate: 500, amount: 500 });
    expect(pi.total).toBe(590);
  });
});

describe("bookingPiNumber", () => {
  it("is traceable to the booking number", () => {
    expect(bookingPiNumber("BK-0412", "abc")).toBe("PI-BK-0412");
    expect(bookingPiNumber(null, "abcdef1234")).toBe("PI-ABCDEF12");
  });
});

describe("piBalanceDue", () => {
  it("never goes negative", () => {
    expect(piBalanceDue(2360, 0)).toBe(2360);
    expect(piBalanceDue(2360, 3000)).toBe(0);
  });
});
