import { describe, expect, it } from "vitest";
import { buildCostsBase, type CostsBaseInput, type CostsMonthRow } from "@/lib/customer-value/costs-base";
import type { ElectricityMonth } from "@/lib/customer-value/electricity-share";

const TODAY = "2026-10-19";
const month = (ym: string, over: Partial<CostsMonthRow> = {}): CostsMonthRow => ({
  month: `${ym}-01`, revenue_ex_gst: 100_000, avg_days_late: 5, measured_count: 1, concessions_counted: 1_000,
  seats_paid: 10, seats_used_avg: null, rent_per_seat: 9_000, ...over,
});
const rows = ["2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10"].map((m) => month(m));
const em = (m: string, cost: number | null, partial = false): ElectricityMonth => ({
  month: m, partial, unknownDays: 0, seats: 10, share: 0.1, centerKwh: 1000, kwh: 100, othersKwh: 700, vacantKwh: 200, tariff: 9, cost, billed: null, shortfall: null,
});
const input = (over: Partial<CostsBaseInput> = {}): CostsBaseInput => ({
  rows, today: TODAY, electricityMonths: null, ticketsLinked: 0, staffMinutes: 0, firstContractStart: "2025-10-19", centerLease: 900_000, centerSeats: 100, ...over,
});

describe("buildCostsBase", () => {
  it("averages the last six completed months and leaves out the running one", () => {
    const r = buildCostsBase(input({ rows: [...rows.slice(0, 6), month("2026-10", { revenue_ex_gst: 999_999 })] }))!;
    expect(r.months).toEqual(["2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09"]);
    expect(r.base.months).toBe(6);
    expect(r.base.revenue).toBe(100_000);
    expect(r.base.seats).toBe(10);
    expect(r.base.rentPerSeat).toBe(9_000);
    expect(r.base.concessions).toBe(1_000);
  });

  it("is null with nothing to average, or with no seats", () => {
    expect(buildCostsBase(input({ rows: [month("2026-10")] }))).toBeNull();
    expect(buildCostsBase(input({ rows: [] }))).toBeNull();
    expect(buildCostsBase(input({ rows: rows.map((r) => ({ ...r, seats_paid: null })) }))).toBeNull();
  });

  it("uses only the months that could be measured for each figure and never turns unknown into zero", () => {
    const r = buildCostsBase(input({ rows: [month("2026-08", { rent_per_seat: null, seats_paid: 20 }), month("2026-09", { rent_per_seat: 8_000, seats_paid: 10 })] }))!;
    expect(r.base.seats).toBe(15);
    expect(r.base.rentPerSeat).toBe(8_000);
    expect(buildCostsBase(input({ rows: [month("2026-09", { rent_per_seat: null })] }))!.base.rentPerSeat).toBeNull();
  });

  describe("electricity", () => {
    it("averages the cost of completed, costed months inside the window", () => {
      const r = buildCostsBase(input({ electricityMonths: [em("2026-08", 8_000), em("2026-09", 10_000), em("2026-10", 99_999, true), em("2026-03", 50_000), em("2026-07", null)] }))!;
      expect(r.base.electricityCost).toBe(9_000);
    });

    it("is null when the center cannot be measured or no month has a bill", () => {
      expect(buildCostsBase(input({ electricityMonths: null }))!.base.electricityCost).toBeNull();
      expect(buildCostsBase(input({ electricityMonths: [em("2026-09", null)] }))!.base.electricityCost).toBeNull();
    });
  });

  describe("staff time", () => {
    it("is unknown until a ticket has been tied to this customer", () => {
      expect(buildCostsBase(input({ ticketsLinked: 0, staffMinutes: 0 }))!.base.staffMinutes).toBeNull();
    });

    it("is minutes per month once tickets are tied, and zero minutes is a real zero", () => {
      expect(buildCostsBase(input({ ticketsLinked: 3, staffMinutes: 600 }))!.base.staffMinutes).toBe(100);
      expect(buildCostsBase(input({ ticketsLinked: 1, staffMinutes: 0 }))!.base.staffMinutes).toBe(0);
    });
  });

  describe("days late", () => {
    it("weights by invoices timed and floors each month at zero because early payment costs nothing", () => {
      const r = buildCostsBase(input({ rows: [month("2026-08", { avg_days_late: 10, measured_count: 3 }), month("2026-09", { avg_days_late: -4, measured_count: 1 })] }))!;
      expect(r.base.avgDaysLate).toBeCloseTo(30 / 4);
    });

    it("is null when no invoice could be timed", () => {
      expect(buildCostsBase(input({ rows: [month("2026-09", { avg_days_late: null, measured_count: 0 })] }))!.base.avgDaysLate).toBeNull();
    });
  });

  it("derives person-days only from door data, which is absent today", () => {
    expect(buildCostsBase(input())!.base.personDays).toBeNull();
    expect(buildCostsBase(input({ rows: rows.map((r) => ({ ...r, seats_used_avg: 5 })) }))!.base.personDays).toBe(130);
  });

  it("works out tenure in whole months from the first contract, at least one", () => {
    expect(buildCostsBase(input({ firstContractStart: "2025-10-19" }))!.base.tenureMonths).toBe(12);
    expect(buildCostsBase(input({ firstContractStart: "2025-10-25" }))!.base.tenureMonths).toBe(11);
    expect(buildCostsBase(input({ firstContractStart: "2026-10-10" }))!.base.tenureMonths).toBe(1);
    expect(buildCostsBase(input({ firstContractStart: null }))!.base.tenureMonths).toBeNull();
  });

  it("passes the center lease and seats through unchanged", () => {
    const b = buildCostsBase(input({ centerLease: null, centerSeats: null }))!.base;
    expect(b.centerLease).toBeNull();
    expect(b.centerSeats).toBeNull();
  });
});
