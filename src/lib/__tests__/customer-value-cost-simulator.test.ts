import { describe, expect, it } from "vitest";
import { lateFactor, simulate, type CostParams, type SimBase } from "@/lib/customer-value/cost-simulator";

// 10 seats at 10,000 = 100,000 rent, plus 20,000 of usage.
const base: SimBase = {
  months: 6, seats: 10, revenue: 120_000, rentPerSeat: 10_000,
  electricityCost: 8_000, concessions: 2_000, staffMinutes: 600, avgDaysLate: 10, personDays: 200,
  tenureMonths: 12, centerLease: 900_000, centerSeats: 100,
};
const full: CostParams = {
  hourlyStaffCost: 300, costOfCapitalPct: 18, pantryPerPersonDay: 20, acquisitionCost: 24_000,
  housekeepingPerSeat: 500, maintenancePerSeat: 300, frontDeskPerSeat: 200, internetPerSeat: 100, overheadPct: 5,
};
const line = (r: ReturnType<typeof simulate>, key: string) => r.lines.find((l) => l.key === key)!;

describe("simulate: cost lines", () => {
  const r = simulate(base, full);

  it("costs each line from the measured quantity and the entered rate", () => {
    expect(line(r, "electricity")).toMatchObject({ amount: 8_000, status: "live" });
    expect(line(r, "concessions")).toMatchObject({ amount: 2_000, status: "live" });
    expect(line(r, "staff_time")).toMatchObject({ amount: 3_000, status: "part_live" }); // 10 h x 300
    expect(line(r, "late_payment").amount).toBe(Math.round(120_000 * 0.18 * (10 / 365)));
    expect(line(r, "pantry").amount).toBe(4_000);
    expect(line(r, "acquisition").amount).toBe(2_000);
    expect(line(r, "rent_share")).toMatchObject({ amount: 90_000, status: "live" }); // 900,000 / 100 x 10
    expect(line(r, "housekeeping").amount).toBe(5_000);
    expect(line(r, "internet").amount).toBe(1_000);
    expect(line(r, "overhead").amount).toBe(6_000);
  });

  it("computes the margins", () => {
    const variable = 8_000 + 2_000 + 3_000 + line(r, "late_payment").amount + 4_000 + 2_000;
    expect(r.variableCost).toBe(variable);
    expect(r.marginAfterVariable).toBe(120_000 - variable);
    expect(r.fixedCost).toBe(90_000 + 5_000 + 3_000 + 2_000 + 1_000 + 6_000);
    expect(r.fullyLoadedMargin).toBe(r.marginAfterVariable - r.fixedCost);
    expect(r.marginAfterVariablePct).toBeCloseTo(r.marginAfterVariable / 120_000);
  });

  it("puts the margin last in where each rupee goes, and the parts add up to revenue", () => {
    expect(r.whereItGoes.at(-1)?.key).toBe("margin");
    expect(r.whereItGoes.reduce((n, w) => n + w.amount, 0)).toBeGreaterThan(119_990);
    expect(r.whereItGoes.reduce((n, w) => n + w.amount, 0)).toBeLessThan(120_010);
  });
});

describe("simulate: missing inputs", () => {
  it("leaves a line with no input at zero and says why, never inventing a figure", () => {
    const r = simulate(base, {});
    expect(line(r, "staff_time")).toMatchObject({ status: "needs_input", amount: 0, reason: "No hourly staff cost entered" });
    expect(line(r, "late_payment").status).toBe("needs_input");
    expect(line(r, "overhead").status).toBe("needs_input");
    expect(r.missing).toEqual(expect.arrayContaining(["staff_time", "late_payment", "pantry", "acquisition", "housekeeping", "overhead"]));
    expect(r.variableCost).toBe(10_000);
  });

  it("does not cost a line whose measurement is unavailable even if the rate is entered", () => {
    const r = simulate({ ...base, electricityCost: null, staffMinutes: null, personDays: null, avgDaysLate: null, centerLease: null }, full);
    for (const k of ["electricity", "staff_time", "pantry", "late_payment", "rent_share"]) expect(line(r, k).status).toBe("needs_input");
    expect(line(r, "rent_share").amount).toBe(0);
  });

  it("cannot spread an acquisition cost over an unknown tenure", () => {
    expect(line(simulate({ ...base, tenureMonths: null }, full), "acquisition").status).toBe("needs_input");
  });
});

describe("simulate: confidence", () => {
  it("is the share of the costed total that rests on measured data", () => {
    const r = simulate(base, {});
    // electricity 8,000 + concessions 2,000 + rent share 90,000, all measured.
    expect(r.confidence).toBe(1);
    const r2 = simulate(base, full);
    const measured = 8_000 + 2_000 + 90_000;
    expect(r2.confidence).toBeCloseTo(measured / r2.lines.reduce((n, l) => n + l.amount, 0), 3);
    expect(r2.confidence!).toBeLessThan(1);
  });

  it("is null when nothing is costed", () => {
    const r = simulate({ ...base, electricityCost: null, concessions: 0, centerLease: null }, {});
    expect(r.confidence).toBeNull();
  });
});

describe("simulate: what-if", () => {
  it("scales seat-driven costs with seats and leaves ticket time, acquisition and concessions alone", () => {
    const r = simulate(base, full, { seats: 20 });
    expect(r.seats).toBe(20);
    expect(line(r, "electricity").amount).toBe(16_000);
    expect(line(r, "rent_share").amount).toBe(180_000);
    expect(line(r, "housekeeping").amount).toBe(10_000);
    expect(line(r, "pantry").amount).toBe(8_000);
    expect(line(r, "staff_time").amount).toBe(3_000);
    expect(line(r, "acquisition").amount).toBe(2_000);
    expect(line(r, "concessions").amount).toBe(2_000);
    expect(r.revenue).toBe(220_000); // 20 x 10,000 + 20,000 usage
  });

  it("changes revenue with the rent but keeps usage revenue", () => {
    const r = simulate(base, full, { rentPerSeat: 12_000 });
    expect(r.revenue).toBe(140_000);
    expect(line(r, "overhead").amount).toBe(7_000);
    expect(line(r, "rent_share").amount).toBe(90_000);
  });

  it("cannot change rent when the contract's rent per seat is unknown, only scales revenue by seats", () => {
    const r = simulate({ ...base, rentPerSeat: null }, full, { seats: 20, rentPerSeat: 99_999 });
    expect(r.rentPerSeat).toBeNull();
    expect(r.revenue).toBe(240_000);
    expect(r.breakEvenAfterVariable).toBeNull();
  });

  it("ignores a nonsensical what-if (zero or negative seats)", () => {
    expect(simulate(base, full, { seats: 0 }).seats).toBe(10);
    expect(simulate(base, full, { seats: -3 }).seats).toBe(10);
  });
});

describe("simulate: break-even", () => {
  it("is the rent per seat at which the margin is zero", () => {
    const r = simulate(base, full);
    const atBreakEven = simulate(base, full, { rentPerSeat: r.breakEvenFullyLoaded! });
    expect(Math.abs(atBreakEven.fullyLoadedMargin)).toBeLessThan(25);
    expect(r.breakEvenFullyLoaded!).toBeGreaterThan(r.breakEvenAfterVariable!);
  });

  it("finds the zero crossing after variable costs when they exceed other revenue", () => {
    const heavy = { ...base, electricityCost: 60_000 };
    const r = simulate(heavy, full);
    expect(r.breakEvenAfterVariable!).toBeGreaterThan(0);
    const at = simulate(heavy, full, { rentPerSeat: r.breakEvenAfterVariable! });
    expect(Math.abs(at.marginAfterVariable)).toBeLessThan(25);
  });

  it("says rent can drop to nothing when usage revenue already covers variable costs", () => {
    const r = simulate(base, full);
    expect(r.breakEvenAfterVariable).toBe(0);
    expect(simulate(base, full, { rentPerSeat: 0 }).marginAfterVariable).toBeGreaterThanOrEqual(0);
  });

  it("never goes below zero", () => {
    const r = simulate({ ...base, revenue: 500_000, electricityCost: 0, concessions: 0, centerLease: null }, {});
    expect(r.breakEvenAfterVariable).toBe(0);
  });
});

describe("lateFactor", () => {
  it("turns days late into a cost of capital per rupee, and counts early as zero", () => {
    expect(lateFactor(365, 18)).toBeCloseTo(0.18);
    expect(lateFactor(-5, 18)).toBe(0);
    expect(lateFactor(null, 18)).toBeNull();
    expect(lateFactor(10, undefined)).toBeNull();
  });
});
