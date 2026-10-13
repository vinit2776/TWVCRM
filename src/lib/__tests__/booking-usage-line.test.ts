import { describe, it, expect } from "vitest";
import { usageLine } from "../booking-usage-line";

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
    expect(l.description).toBe("Conference Room: 1 Jul, TWV-B-0124, 2:39 pm to 8:06 pm (used 5.5 h, free 3 h)");
  });

  it("reports zero free hours once the quota is used up", () => {
    const l = usageLine({
      ...base, description: "x", quantity: 4.5, total: 4500, charge_date: "2026-07-06",
      booking: { booking_number: "TWV-B-0136" },
    });
    expect(l.quantity).toBe(4.5);
    expect(l.description).toBe("Conference Room: 6 Jul, TWV-B-0136 (used 4.5 h, free 0 h)");
  });

  it("repairs the 4 x 1000 = 1000 print bug", () => {
    const l = usageLine({ ...base, description: "x", quantity: 4, total: 1000, charge_date: "2026-10-08", booking: { booking_number: "TWV-B-0256" } });
    expect(l.quantity).toBe(1);
    expect(l.amount).toBe(1000);
  });

  it("leaves non-booking and legacy charges untouched", () => {
    const manual = usageLine({ description: "Ad-hoc", quantity: 3, unit_price: 200, total: 600, charge_date: "2026-07-01" });
    expect(manual).toEqual({ description: "Ad-hoc", quantity: 3, unitPrice: 200, amount: 600 });
    const legacy = usageLine({ ...base, booking_charge_kind: "quota_overage", description: "Overage", quantity: 2, total: 2000, charge_date: "2026-07-01", booking: { booking_number: "B" } });
    expect(legacy.description).toBe("Overage");
  });
});
