import { describe, expect, it } from "vitest";
import { carryItemsAtFee, fitLinesToTotal, termStepRows } from "@/lib/escalation-cycle";
import {
  addMonthsClampedYmd,
  buildCycleSchedule,
  currentAndNextStep,
  cycleToPhases,
  finalCycleRate,
} from "@/lib/escalation-cycle";
import { computePhaseBoundaries } from "@/lib/rate-phase-dates";

const base = { anchorYmd: "2027-01-01", endYmd: "2028-12-31", baseRate: 50000, percent: 10, cycleMonths: 11 };

describe("buildCycleSchedule", () => {
  it("steps every 11 months on a 24-month term and compounds", () => {
    const s = buildCycleSchedule(base);
    expect(s.map((x) => [x.start, x.end, x.rate])).toEqual([
      ["2027-01-01", "2027-11-30", 50000],
      ["2027-12-01", "2028-10-31", 55000],
      ["2028-11-01", "2028-12-31", 60500],
    ]);
  });

  it("steps once at 12 months on a 24-month term", () => {
    const s = buildCycleSchedule({ ...base, cycleMonths: 12 });
    expect(s.map((x) => [x.start, x.end, x.rate])).toEqual([
      ["2027-01-01", "2027-12-31", 50000],
      ["2028-01-01", "2028-12-31", 55000],
    ]);
  });

  it("returns no steps when the term is not longer than one cycle", () => {
    expect(buildCycleSchedule({ ...base, endYmd: "2027-11-30" })).toEqual([]);
    expect(buildCycleSchedule({ ...base, endYmd: "2027-12-31", cycleMonths: 12 })).toEqual([]);
  });

  it("lands steps on the exact anniversary for a mid-month start", () => {
    const s = buildCycleSchedule({ ...base, anchorYmd: "2027-01-15", endYmd: "2028-01-14" });
    expect(s.map((x) => [x.start, x.end])).toEqual([
      ["2027-01-15", "2027-12-14"],
      ["2027-12-15", "2028-01-14"],
    ]);
  });

  it("clamps the anniversary in a short month", () => {
    expect(addMonthsClampedYmd("2027-03-31", 11)).toBe("2028-02-29");
    expect(addMonthsClampedYmd("2027-01-31", 1)).toBe("2027-02-28");
  });

  it("rounds each step on the previous rounded fee, so printed figures chain", () => {
    const s = buildCycleSchedule({ ...base, baseRate: 32956, percent: 10 });
    expect(s.map((x) => x.rate)).toEqual([32956, 36252, 39877]);
  });

  it("a 0% escalation keeps the fee flat", () => {
    expect(buildCycleSchedule({ ...base, percent: 0 }).map((x) => x.rate)).toEqual([50000, 50000, 50000]);
  });

  it("ignores nonsense input", () => {
    expect(buildCycleSchedule({ ...base, baseRate: 0 })).toEqual([]);
    expect(buildCycleSchedule({ ...base, endYmd: "2026-01-01" })).toEqual([]);
  });
});

describe("billing sees the same dates and fees", () => {
  it("the generated phases give billing identical boundaries", () => {
    const steps = buildCycleSchedule(base);
    const boundaries = computePhaseBoundaries(base.anchorYmd, cycleToPhases(steps, 11));
    expect(boundaries.map((b) => [b.start, b.end, b.rate])).toEqual(steps.map((s) => [s.start, s.end, s.rate]));
  });
});

describe("helpers", () => {
  const steps = buildCycleSchedule(base);
  it("finalCycleRate is the last step, or the fallback with none", () => {
    expect(finalCycleRate(steps, 1)).toBe(60500);
    expect(finalCycleRate([], 50000)).toBe(50000);
  });
  it("finds the current and next step", () => {
    expect(currentAndNextStep(steps, "2027-06-01").next?.rate).toBe(55000);
    expect(currentAndNextStep(steps, "2028-11-15").next).toBeNull();
    expect(currentAndNextStep(steps, "2028-11-15").current?.rate).toBe(60500);
  });
});

import { planCyclePhases, type CycleContractFields } from "@/lib/escalation-cycle-server";

const contract: CycleContractFields = {
  status: "draft", start_date: "2027-01-01", end_date: "2028-12-31", phase_start_date: "2027-01-01",
  subtotal: 50000, total_amount: 59000, escalation_percentage: 10, escalation_cycle_months: 11,
  items: [{ escalates: true }, {}],
};

describe("planCyclePhases", () => {
  it("builds the schedule for an open contract", () => {
    const p = planCyclePhases(contract);
    expect(p.kind).toBe("build");
    if (p.kind === "build") expect(p.steps.map((s) => s.rate)).toEqual([50000, 55000, 60500]);
  });
  it("does nothing without a cycle", () => {
    expect(planCyclePhases({ ...contract, escalation_cycle_months: null }).kind).toBe("none");
  });
  it("is locked once the contract is active, unless activating", () => {
    expect(planCyclePhases({ ...contract, status: "active" }).kind).toBe("locked");
    expect(planCyclePhases({ ...contract, status: "active" }, true).kind).toBe("build");
  });
  it("refuses a fixed (non-escalating) line", () => {
    expect(planCyclePhases({ ...contract, items: [{ escalates: false }] }).kind).toBe("blocked");
  });
  it("follows the phase anchor, not the start date, when they differ", () => {
    const p = planCyclePhases({ ...contract, phase_start_date: "2027-01-15" });
    if (p.kind === "build") expect(p.steps[0].start).toBe("2027-01-15");
  });
});

describe("termStepRows (proposal, counted in months)", () => {
  it("prints the same fees the contract will", () => {
    const rows = termStepRows({ baseRate: 50000, percent: 10, cycleMonths: 11, tenureMonths: 24 });
    expect(rows).toEqual([
      { label: "Months 1 to 11", rate: 50000 },
      { label: "Months 12 to 22", rate: 55000 },
      { label: "Months 23 to 24", rate: 60500 },
    ]);
    const contract = buildCycleSchedule(base).map((s) => s.rate);
    expect(rows.map((r) => r.rate)).toEqual(contract);
  });
  it("is empty for a term no longer than the cycle", () => {
    expect(termStepRows({ baseRate: 50000, percent: 10, cycleMonths: 11, tenureMonths: 11 })).toEqual([]);
  });
});

describe("renewal carries the last stepped fee exactly", () => {
  const items = [{ description: "Seats", quantity: 3, unit_price: 16667, total: 50001 }];
  it("lands on the target to the paisa with the same seats", () => {
    const out = carryItemsAtFee(items, 3, 3, 60500);
    expect(out.reduce((s, l) => s + l.total, 0)).toBeCloseTo(60500, 1); // within a paisa
  });
  it("keeps the stepped per-seat rate when seats change", () => {
    const out = carryItemsAtFee(items, 3, 5, 60500);
    expect(out[0].quantity).toBe(5);
    expect(out[0].total).toBeCloseTo(out[0].unit_price * 5, 2);
  });
  it("leaves lines alone when the target is unusable", () => {
    expect(fitLinesToTotal(items, 0)).toEqual(items);
  });
});

import { computeRenewalSplitRentSegments, type RatePhaseDetail } from "@/lib/billing";

/** What billing would charge a contract on the cycle for one calendar month. */
function billMonth(start: string, end: string, phasesFor: RatePhaseDetail[], first: string, last: string, days: number) {
  const map = new Map<string, RatePhaseDetail[]>([["c1", phasesFor]]);
  return computeRenewalSplitRentSegments("c1", start, end, 50000, 59000, start, 18, undefined, map, first, last, days);
}

describe("billing prices the generated steps", () => {
  const steps = buildCycleSchedule(base);
  const phases: RatePhaseDetail[] = steps.map((s) => ({
    phase_order: s.order, duration_months: 11, monthly_rate: s.rate, end_date: s.end,
  }));

  it("bills each month at the fee in force", () => {
    const m = (first: string, last: string, days: number) => billMonth("2027-01-01", "2028-12-31", phases, first, last, days).amount;
    expect(m("2027-11-01", "2027-11-30", 30)).toBe(50000); // last month of step 1
    expect(m("2027-12-01", "2027-12-31", 31)).toBe(55000); // first month of step 2
    expect(m("2028-10-01", "2028-10-31", 31)).toBe(55000); // last month of step 2
    expect(m("2028-11-01", "2028-11-30", 30)).toBe(60500); // step 3
    expect(m("2028-12-01", "2028-12-31", 31)).toBe(60500);
  });

  it("prorates a month that holds a mid-month step, by day", () => {
    const start = "2027-01-15";
    const end = "2028-01-14";
    const s = buildCycleSchedule({ ...base, anchorYmd: start, endYmd: end });
    const ph: RatePhaseDetail[] = s.map((x) => ({ phase_order: x.order, duration_months: 11, monthly_rate: x.rate, end_date: x.end }));
    // Step 2 starts 15 Dec 2027: 14 days at 50,000 then 17 days at 55,000 in a 31-day month.
    const r = billMonth(start, end, ph, "2027-12-01", "2027-12-31", 31);
    expect(r.segments.map((x) => [x.days, x.rate])).toEqual([[14, 50000], [17, 55000]]);
    expect(r.amount).toBe(Math.round((50000 / 31) * 14) + Math.round((55000 / 31) * 17));
  });

  it("an extended term continues at the last stepped fee", () => {
    const r = billMonth("2027-01-01", "2029-01-31", phases, "2029-01-01", "2029-01-31", 31);
    expect(r.amount).toBe(60500);
  });

  it("a contract with no steps bills the flat fee as before", () => {
    expect(billMonth("2027-01-01", "2027-11-30", [], "2027-06-01", "2027-06-30", 30).amount).toBe(50000);
  });
});
