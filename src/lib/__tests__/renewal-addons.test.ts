import { describe, it, expect } from "vitest";
import { addonRunsToTermEnd, defaultCarryIds, renewalAddonSeeds, type CarryableAddon } from "../renewal-addons";

const TERM_END = "2027-05-18";

const addon = (over: Partial<CarryableAddon> = {}): CarryableAddon => ({
  id: "a1",
  description: "Valet car parking",
  amount: 7000,
  effective_from: "2026-11-19",
  effective_until: TERM_END,
  is_active: true,
  ...over,
});

describe("addonRunsToTermEnd", () => {
  it("is true for an active add-on that runs to the end of the term", () => {
    expect(addonRunsToTermEnd(addon(), TERM_END)).toBe(true);
    expect(addonRunsToTermEnd(addon({ effective_until: null }), TERM_END)).toBe(true);
    expect(addonRunsToTermEnd(addon({ effective_until: "2027-06-30" }), TERM_END)).toBe(true);
  });

  it("is false for one that was paused or ended early", () => {
    expect(addonRunsToTermEnd(addon({ is_active: false }), TERM_END)).toBe(false);
    expect(addonRunsToTermEnd(addon({ effective_until: "2027-02-28" }), TERM_END)).toBe(false);
  });
});

describe("defaultCarryIds", () => {
  it("ticks only the add-ons that are still running", () => {
    const list = [
      addon({ id: "valet" }),
      addon({ id: "board", description: "Name board", effective_until: "2027-02-28" }),
      addon({ id: "locker", description: "Locker", is_active: false }),
    ];
    expect(defaultCarryIds(list, TERM_END)).toEqual(["valet"]);
  });
});

describe("renewalAddonSeeds", () => {
  const list = [
    addon({ id: "valet" }),
    addon({ id: "board", description: "Name board", amount: 1500, effective_until: "2027-02-28" }),
  ];

  it("carries the defaults, with the amount unchanged and the dates set to the new term", () => {
    expect(renewalAddonSeeds(list, undefined, TERM_END, "c2", "2027-05-19", "2027-11-18", "u1")).toEqual([
      {
        contract_id: "c2",
        description: "Valet car parking",
        amount: 7000,
        effective_from: "2027-05-19",
        effective_until: "2027-11-18",
        is_active: true,
        created_by: "u1",
      },
    ]);
  });

  it("carries exactly what the person ticked, including an add-on that ended early", () => {
    const seeds = renewalAddonSeeds(list, ["board"], TERM_END, "c2", "2027-05-19", "2027-11-18", null);
    expect(seeds.map((s) => s.description)).toEqual(["Name board"]);
    expect(seeds[0].amount).toBe(1500);
    expect(seeds[0].is_active).toBe(true);
  });

  it("carries nothing when nothing is ticked", () => {
    expect(renewalAddonSeeds(list, [], TERM_END, "c2", "2027-05-19", "2027-11-18", null)).toEqual([]);
  });

  it("ignores ids that are not on the contract", () => {
    expect(renewalAddonSeeds(list, ["nope"], TERM_END, "c2", "2027-05-19", "2027-11-18", null)).toEqual([]);
  });
});
