import { describe, it, expect } from "vitest";
import { cyclesBetween, contractTotal, billingProgress, cycleFromUnit, CYCLE_ITEM_UNIT, serviceBillingStep } from "../procurement/amc-billing";

describe("cyclesBetween", () => {
  it("a standard financial year is 12 monthly cycles", () => {
    expect(cyclesBetween("2026-04-01", "2027-03-31", "monthly")).toBe(12);
  });

  it("the same year is 4 quarterly, 2 half-yearly, or 1 yearly cycle", () => {
    expect(cyclesBetween("2026-04-01", "2027-03-31", "quarterly")).toBe(4);
    expect(cyclesBetween("2026-04-01", "2027-03-31", "half_yearly")).toBe(2);
    expect(cyclesBetween("2026-04-01", "2027-03-31", "yearly")).toBe(1);
  });

  it("counts an anniversary-dated end as a full period", () => {
    // Vendors write both forms; Mar 30 → Mar 29 and Mar 30 → Mar 30 are both 12 months.
    expect(cyclesBetween("2026-03-30", "2027-03-29", "monthly")).toBe(12);
    expect(cyclesBetween("2026-03-30", "2027-03-30", "monthly")).toBe(12);
  });

  it("handles a short mid-term contract", () => {
    expect(cyclesBetween("2026-06-04", "2026-07-03", "monthly")).toBe(1);
    expect(cyclesBetween("2026-04-01", "2026-09-30", "monthly")).toBe(6);
  });

  it("handles a multi-year contract", () => {
    expect(cyclesBetween("2026-04-01", "2029-03-31", "monthly")).toBe(36);
    expect(cyclesBetween("2026-04-01", "2029-03-31", "yearly")).toBe(3);
  });

  it("returns null for missing or inverted dates so callers can fall back", () => {
    expect(cyclesBetween(null, "2027-03-31", "monthly")).toBeNull();
    expect(cyclesBetween("2026-04-01", null, "monthly")).toBeNull();
    expect(cyclesBetween("2027-03-31", "2026-04-01", "monthly")).toBeNull();
    expect(cyclesBetween("not-a-date", "2027-03-31", "monthly")).toBeNull();
  });

  it("never returns zero cycles for a valid range", () => {
    expect(cyclesBetween("2026-04-01", "2026-04-15", "yearly")).toBe(1);
  });
});

describe("contractTotal", () => {
  it("multiplies per-cycle cost by cycle count", () => {
    expect(contractTotal(5000, 12)).toBe(60000);
    expect(contractTotal(15000, 4)).toBe(60000);
  });

  it("a yearly contract is the one-cycle case — value passes through unchanged", () => {
    // This is why existing yearly AMCs need no migration.
    expect(contractTotal(26460, 1)).toBe(26460);
  });

  it("guards against NaN reaching a currency field", () => {
    expect(contractTotal(NaN, 12)).toBe(0);
    expect(contractTotal(5000, NaN)).toBe(0);
    expect(contractTotal(-5000, 12)).toBe(0);
  });
});

describe("billingProgress", () => {
  it("reports billed cycles and the remaining rupee value", () => {
    const p = billingProgress(4, 12, 5000);
    expect(p).toEqual({ billed: 4, total: 12, remainingAmount: 40000, isComplete: false });
  });

  it("flags a fully billed contract", () => {
    expect(billingProgress(12, 12, 5000)?.isComplete).toBe(true);
  });

  it("does not go negative when over-billed", () => {
    const p = billingProgress(14, 12, 5000);
    expect(p?.remainingAmount).toBe(0);
    expect(p?.isComplete).toBe(true);
  });

  it("is absent for single-cycle contracts, which have nothing to track", () => {
    expect(billingProgress(0, 1, 26460)).toBeNull();
    expect(billingProgress(0, null, 26460)).toBeNull();
  });
});

describe("cycleFromUnit", () => {
  it("maps the AMC line item's unit back to its billing frequency", () => {
    expect(cycleFromUnit("month")).toBe("monthly");
    expect(cycleFromUnit("quarter")).toBe("quarterly");
    expect(cycleFromUnit("half_year")).toBe("half_yearly");
    expect(cycleFromUnit("year")).toBe("yearly");
  });

  it("falls back to yearly for legacy or missing units", () => {
    // Every AMC raised before monthly billing existed stored unit "year"; anything
    // unrecognised is safest read as a single-cycle contract.
    expect(cycleFromUnit(null)).toBe("yearly");
    expect(cycleFromUnit(undefined)).toBe("yearly");
    expect(cycleFromUnit("nos")).toBe("yearly");
  });
});

describe("CYCLE_ITEM_UNIT", () => {
  it("stores the item_unit enum value, not the display noun", () => {
    // "half-year" is a label; the DB enum only accepts "half_year". Writing the
    // label would be rejected by the item_unit type.
    expect(CYCLE_ITEM_UNIT.half_yearly).toBe("half_year");
    expect(CYCLE_ITEM_UNIT.monthly).toBe("month");
    expect(CYCLE_ITEM_UNIT.quarterly).toBe("quarter");
    expect(CYCLE_ITEM_UNIT.yearly).toBe("year");
  });

  it("round-trips through cycleFromUnit for every cycle", () => {
    for (const cycle of ["monthly", "quarterly", "half_yearly", "yearly"] as const) {
      expect(cycleFromUnit(CYCLE_ITEM_UNIT[cycle])).toBe(cycle);
    }
  });
});

describe("serviceBillingStep", () => {
  it("a fresh 12-month contract starts by asking for a service report", () => {
    const s = serviceBillingStep(0, 0, 12);
    expect(s.nextAction).toBe("log_report");
    expect(s.allBilled).toBe(false);
    expect(s.cyclesRemaining).toBe(12);
  });

  it("an open report switches the next action to the invoice", () => {
    // Report filed but not yet invoiced — this is what enables the invoice button.
    const s = serviceBillingStep(1, 0, 12);
    expect(s.nextAction).toBe("upload_invoice");
  });

  it("mid-contract, it asks for the next cycle's report once the last is invoiced", () => {
    const s = serviceBillingStep(4, 4, 12);
    expect(s.nextAction).toBe("log_report");
    expect(s.cyclesRemaining).toBe(8);
  });

  it("a fully billed contract asks for nothing further", () => {
    const s = serviceBillingStep(12, 12, 12);
    expect(s.nextAction).toBe("none");
    expect(s.allBilled).toBe(true);
    expect(s.cyclesRemaining).toBe(0);
  });

  it("never reports negative remaining cycles if over-billed", () => {
    expect(serviceBillingStep(13, 13, 12).cyclesRemaining).toBe(0);
  });

  it("a single-cycle yearly contract behaves the same way", () => {
    expect(serviceBillingStep(0, 0, 1).nextAction).toBe("log_report");
    expect(serviceBillingStep(1, 0, 1).nextAction).toBe("upload_invoice");
    expect(serviceBillingStep(1, 1, 1).allBilled).toBe(true);
  });

  it("treats an unknown cycle count as not-yet-billed rather than complete", () => {
    // Legacy service POs predate cycle_count; they must not read as "fully billed".
    const s = serviceBillingStep(0, 0, null);
    expect(s.allBilled).toBe(false);
    expect(s.nextAction).toBe("log_report");
  });
});
