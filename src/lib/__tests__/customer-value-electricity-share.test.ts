import { describe, expect, it } from "vitest";
import { blendedTariff, electricityMonth, splitBase, summarise, type ElectricityMonthInput } from "@/lib/customer-value/electricity-share";

const base: ElectricityMonthInput = {
  month: "2026-09", centerKwh: 10000, partial: false, unknownDays: 0,
  seats: 10, contractedSeats: 80, tariff: 9, billed: 500,
};

describe("electricityMonth", () => {
  it("splits the center kWh by seats and leaves empty seats as vacant", () => {
    const m = electricityMonth(base, 100);
    expect(m.share).toBeCloseTo(0.1);
    expect(m.kwh).toBe(1000);
    expect(m.othersKwh).toBe(7000);
    expect(m.vacantKwh).toBe(2000);
    expect(m.kwh! + m.othersKwh! + m.vacantKwh!).toBe(10000);
  });

  it("prices at the tariff and shows the shortfall against what he was billed", () => {
    const m = electricityMonth(base, 100);
    expect(m.cost).toBe(9000);
    expect(m.shortfall).toBe(8500);
  });

  it("shows kWh but no rupees when the month has no bill", () => {
    const m = electricityMonth({ ...base, tariff: null }, 100);
    expect(m.kwh).toBe(1000);
    expect(m.cost).toBeNull();
    expect(m.shortfall).toBeNull();
  });

  it("treats nothing billed as zero billed, not unknown", () => {
    const m = electricityMonth({ ...base, billed: null }, 100);
    expect(m.shortfall).toBe(9000);
  });

  it("keeps a month with missing readings as a gap, never zero", () => {
    const m = electricityMonth({ ...base, centerKwh: null }, 100);
    expect(m.kwh).toBeNull();
    expect(m.cost).toBeNull();
  });

  it("has no share when he had no seats", () => {
    expect(electricityMonth({ ...base, seats: 0 }, 100).share).toBeNull();
    expect(electricityMonth({ ...base, seats: null }, 100).kwh).toBeNull();
  });

  it("never lets shares pass 100% when contracted seats exceed capacity", () => {
    expect(splitBase(60, 80)).toBe(80);
    const m = electricityMonth({ ...base, contractedSeats: 80 }, 60);
    expect(m.share).toBeCloseTo(10 / 80);
    expect(m.vacantKwh).toBe(0);
  });
});

describe("summarise", () => {
  it("covers completed months only and counts months without a bill", () => {
    const months = [
      electricityMonth(base, 100),
      electricityMonth({ ...base, month: "2026-08", tariff: null }, 100),
      electricityMonth({ ...base, month: "2026-10", partial: true }, 100),
    ];
    const s = summarise(months)!;
    expect(s.months).toBe(2);
    expect(s.kwh).toBe(2000);
    expect(s.cost).toBe(9000);
    expect(s.billed).toBe(500);
    expect(s.shortfall).toBe(8500);
    expect(s.monthsWithoutBill).toBe(1);
  });

  it("is null with nothing measured", () => {
    expect(summarise([electricityMonth({ ...base, centerKwh: null }, 100)])).toBeNull();
  });
});

describe("blendedTariff", () => {
  it("divides the bill total by utility and generator units", () => {
    expect(blendedTariff([{ landlord_total_amount: "90000", lines: [{ line_type: "utility", units: "9000" }, { line_type: "generator", units: "1000" }, { line_type: "other", units: null }] }])).toBe(9);
  });

  it("pools several bills and skips ones it cannot price", () => {
    expect(blendedTariff([
      { landlord_total_amount: 100, lines: [{ line_type: "utility", units: 10 }] },
      { landlord_total_amount: 0, lines: [{ line_type: "utility", units: 10 }] },
      { landlord_total_amount: 50, lines: [] },
      { landlord_total_amount: 200, lines: [{ line_type: "utility", units: 10 }] },
    ])).toBe(15);
  });

  it("is null when nothing can be priced", () => {
    expect(blendedTariff([])).toBeNull();
  });
});
