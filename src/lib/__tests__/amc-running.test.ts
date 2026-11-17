import { describe, it, expect } from "vitest";
import { cycleSchedule, maxSettledCycles, runningFigures, runningScheduleProblem, startedBefore } from "../procurement/amc-running";
import { amcStepsFor, validateAmcStep, type AmcStepInput } from "../procurement/amc-wizard-steps";

describe("cycleSchedule", () => {
  it("splits the Blue Star year into two half-years that tile the contract", () => {
    expect(cycleSchedule("2026-03-30", "2027-03-29", "half_yearly")).toEqual([
      { n: 1, from: "2026-03-30", to: "2026-09-29" },
      { n: 2, from: "2026-09-30", to: "2027-03-29" },
    ]);
  });
  it("clamps month ends and keeps periods contiguous", () => {
    const s = cycleSchedule("2026-01-31", "2026-04-30", "monthly");
    expect(s.map((p) => p.from)).toEqual(["2026-01-31", "2026-02-28", "2026-03-31"]);
    expect(s[0].to).toBe("2026-02-27");
    expect(s[2].to).toBe("2026-04-30");
  });
  it("honours an explicit cycle count and returns nothing for bad dates", () => {
    expect(cycleSchedule("2026-04-01", "2027-03-31", "quarterly", 2)).toHaveLength(2);
    expect(cycleSchedule("", "2027-03-31", "yearly")).toEqual([]);
  });
});

describe("what can be marked as already paid", () => {
  const sched = cycleSchedule("2026-03-30", "2027-03-29", "half_yearly");
  it("a contract is running only once its start date has passed", () => {
    expect(startedBefore("2026-03-30", "2026-11-05")).toBe(true);
    expect(startedBefore("2026-11-05", "2026-11-05")).toBe(false);
    expect(startedBefore("", "2026-11-05")).toBe(false);
  });
  it("only finished cycles can be ticked", () => {
    expect(maxSettledCycles(sched, "2026-11-05")).toBe(1);
    expect(maxSettledCycles(sched, "2026-06-01")).toBe(0);
  });
  it("the last cycle is never settled, even after the contract ended", () => {
    expect(maxSettledCycles(sched, "2028-01-01")).toBe(1);
  });
});

describe("runningFigures", () => {
  it("splits the Blue Star contract into paid and to-approve", () => {
    expect(runningFigures(20700, 2, 1)).toEqual({ full: 41400, paid: 20700, remaining: 20700 });
  });
  it("is the whole contract when nothing is settled, and never settles everything", () => {
    expect(runningFigures(5000, 3, 0)).toEqual({ full: 15000, paid: 0, remaining: 15000 });
    expect(runningFigures(5000, 3, 9)).toEqual({ full: 15000, paid: 10000, remaining: 5000 });
  });
  it("treats junk costs as zero", () => {
    expect(runningFigures(Number.NaN, 2, 1)).toEqual({ full: 0, paid: 0, remaining: 0 });
  });
});

describe("runningScheduleProblem", () => {
  it("accepts assets that share a schedule", () => {
    expect(runningScheduleProblem([{ billingCycle: "half_yearly", count: 2 }, { billingCycle: "half_yearly", count: 2 }])).toBeNull();
    expect(runningScheduleProblem([{ billingCycle: "yearly", count: 1 }])).toBeNull();
  });
  it("refuses mixed frequencies or counts", () => {
    expect(runningScheduleProblem([{ billingCycle: "half_yearly", count: 2 }, { billingCycle: "yearly", count: 1 }])).toMatch(/same billing/);
    expect(runningScheduleProblem([{ billingCycle: "monthly", count: 12 }, { billingCycle: "monthly", count: 6 }])).toMatch(/same billing/);
  });
});

describe("the already-running wizard step", () => {
  const ok: AmcStepInput = {
    companyId: "c1", serviceName: "HVAC", startDate: "2026-03-30", endDate: "2027-03-29",
    unlimitedVisits: false, visitsCovered: "4",
    lines: [{ assetId: "a1", perCycleCost: "1", cycleCountOverride: "" }], contactName: "R", helpline: "1",
  };
  it("only appears for a contract that has begun", () => {
    expect(amcStepsFor(false).map((s) => s.key)).not.toContain("running");
    const keys = amcStepsFor(true).map((s) => s.key);
    expect(keys.indexOf("running")).toBe(keys.indexOf("billing") + 1);
  });
  it("blocks Next only when the schedule problem is set", () => {
    const steps = amcStepsFor(true);
    const i = steps.findIndex((s) => s.key === "running");
    expect(validateAmcStep(i, ok, steps)).toBeNull();
    expect(validateAmcStep(i, { ...ok, running: { scheduleProblem: "Make them match" } }, steps)).toBe("Make them match");
  });
  it("step numbers still resolve against the list passed in", () => {
    const steps = amcStepsFor(false);
    expect(validateAmcStep(steps.findIndex((s) => s.key === "contacts"), { ...ok, helpline: "" }, steps)).toMatch(/contact/i);
  });
});
