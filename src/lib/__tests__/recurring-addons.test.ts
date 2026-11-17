import { describe, it, expect } from "vitest";
import {
  addonsMonthlyTotal,
  escalationNote,
  cleanAddons,
  followTermDates,
  prorateMonthly,
  seedContractAddons,
} from "../recurring-addons";

describe("cleanAddons", () => {
  it("drops blank rows and trims descriptions", () => {
    expect(
      cleanAddons([
        { description: "  Valet car parking ", amount: 7000 },
        { description: "", amount: 500 },
        { description: "Locker", amount: 0 },
      ])
    ).toEqual([{ description: "Valet car parking", amount: 7000 }]);
  });

  it("copes with null and undefined", () => {
    expect(cleanAddons(null)).toEqual([]);
    expect(cleanAddons(undefined)).toEqual([]);
  });
});

describe("addonsMonthlyTotal", () => {
  it("sums only real add-ons", () => {
    expect(
      addonsMonthlyTotal([
        { description: "Valet car parking", amount: 7000 },
        { description: "Name board", amount: 1500.5 },
        { description: "", amount: 99 },
      ])
    ).toBe(8500.5);
  });
});

describe("prorateMonthly", () => {
  it("prorates by day for a partial first month", () => {
    // 19 Nov start: 12 of 30 days
    expect(prorateMonthly(7000, 12, 30)).toBe(2800);
  });

  it("charges the whole amount for a full month", () => {
    expect(prorateMonthly(7000, 30, 30)).toBe(7000);
  });

  it("rounds to the paisa", () => {
    expect(prorateMonthly(1000, 10, 31)).toBe(322.58);
  });
});

describe("seedContractAddons", () => {
  it("dates every add-on to the contract term", () => {
    const rows = seedContractAddons(
      [{ description: "Valet car parking", amount: 7000 }],
      "c-1",
      "2026-11-19",
      "2027-05-18",
      "u-1"
    );
    expect(rows).toEqual([
      {
        contract_id: "c-1",
        description: "Valet car parking",
        amount: 7000,
        effective_from: "2026-11-19",
        effective_until: "2027-05-18",
        is_active: true,
        created_by: "u-1",
      },
    ]);
  });

  it("seeds nothing when the proposal has no add-ons", () => {
    expect(seedContractAddons([], "c-1", "2026-11-19", "2027-05-18", null)).toEqual([]);
    expect(seedContractAddons(null, "c-1", "2026-11-19", "2027-05-18", null)).toEqual([]);
  });
});

describe("followTermDates", () => {
  const from = { start: "2026-11-19", end: "2027-05-18" };

  it("moves an add-on that sits on the default term", () => {
    expect(
      followTermDates(
        { effective_from: "2026-11-19", effective_until: "2027-05-18" },
        from,
        { start: "2026-12-01", end: "2027-05-30" }
      )
    ).toEqual({ effective_from: "2026-12-01", effective_until: "2027-05-30" });
  });

  it("follows an extension of the end date only", () => {
    expect(
      followTermDates(
        { effective_from: "2026-11-19", effective_until: "2027-05-18" },
        from,
        { start: "2026-11-19", end: "2027-05-25" }
      )
    ).toEqual({ effective_from: "2026-11-19", effective_until: "2027-05-25" });
  });

  it("leaves an add-on whose dates were edited for the customer", () => {
    expect(
      followTermDates(
        { effective_from: "2026-12-01", effective_until: "2027-02-28" },
        from,
        { start: "2026-11-25", end: "2027-05-24" }
      )
    ).toBeNull();
  });

  it("moves the start but keeps an early end date", () => {
    expect(
      followTermDates(
        { effective_from: "2026-11-19", effective_until: "2027-02-28" },
        from,
        { start: "2026-11-25", end: "2027-05-24" }
      )
    ).toEqual({ effective_from: "2026-11-25", effective_until: "2027-02-28" });
  });

  it("returns null when the term did not move", () => {
    expect(followTermDates({ effective_from: "2026-11-19", effective_until: "2027-05-18" }, from, from)).toBeNull();
  });
});

describe("escalationNote", () => {
  it("states the agreed number", () => {
    expect(escalationNote(12.5, false)).toBe("Escalation of 12.5% applies to the monthly fee at each renewal.");
  });

  it("says add-ons are excluded when there are any", () => {
    expect(escalationNote(10, true)).toBe(
      "Escalation of 10% applies to the monthly fee at each renewal. Recurring add-ons are not subject to escalation."
    );
  });

  it("prints nothing when the proposal carries no figure", () => {
    expect(escalationNote(undefined, false)).toBeNull();
    expect(escalationNote(null, true)).toBeNull();
  });
});
