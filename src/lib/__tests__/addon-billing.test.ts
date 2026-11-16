import { describe, it, expect } from "vitest";
import {
  addonLineForMonth,
  addonTermKind,
  applyAddonChange,
  isAddonLiveOn,
  itemMatchesAddon,
  monthWindow,
  type AddonTerms,
  type StatementSection,
} from "../addon-billing";

const valet: AddonTerms = {
  description: "Valet car parking",
  amount: 7000,
  effective_from: "2026-11-19",
  effective_until: "2027-05-18",
  is_active: true,
};

const DEC = monthWindow("2026-12-01");
const JAN = monthWindow("2027-01-10");

describe("monthWindow", () => {
  it("covers the whole calendar month", () => {
    expect(DEC).toEqual({ first: "2026-12-01", last: "2026-12-31", days: 31 });
    expect(monthWindow("2027-02-15")).toEqual({ first: "2027-02-01", last: "2027-02-28", days: 28 });
  });
});

describe("isAddonLiveOn", () => {
  it("is live inside its dates only while active", () => {
    expect(isAddonLiveOn(valet, "2026-12-15")).toBe(true);
    expect(isAddonLiveOn(valet, "2026-11-18")).toBe(false);
    expect(isAddonLiveOn(valet, "2027-05-19")).toBe(false);
    expect(isAddonLiveOn({ ...valet, is_active: false }, "2026-12-15")).toBe(false);
  });

  it("treats an add-on with no end date as open-ended", () => {
    expect(isAddonLiveOn({ ...valet, effective_until: null }, "2030-01-01")).toBe(true);
  });
});

describe("addonTermKind", () => {
  it("recognises the full term, an early end and custom dates", () => {
    expect(addonTermKind(valet, "2026-11-19", "2027-05-18")).toBe("full");
    expect(addonTermKind({ ...valet, effective_until: null }, "2026-11-19", "2027-05-18")).toBe("full");
    expect(addonTermKind({ ...valet, effective_until: "2027-02-28" }, "2026-11-19", "2027-05-18")).toBe("ended_early");
    expect(addonTermKind({ ...valet, effective_from: "2026-12-01" }, "2026-11-19", "2027-05-18")).toBe("custom");
  });

  it("calls it custom when the term is unknown", () => {
    expect(addonTermKind(valet, null, null)).toBe("custom");
  });
});

describe("addonLineForMonth", () => {
  it("bills a full month at the monthly amount", () => {
    expect(addonLineForMonth(valet, DEC)).toEqual({ description: "Valet car parking", amount: 7000 });
  });

  it("prorates the first partial month by day", () => {
    const first = addonLineForMonth(valet, monthWindow("2026-11-01"));
    expect(first).toMatchObject({ amount: 2800, days_used: 12, days_in_month: 30, monthly_rate: 7000 });
  });

  it("prorates the month it ends in", () => {
    const ended = addonLineForMonth({ ...valet, effective_until: "2027-01-14" }, JAN);
    expect(ended).toMatchObject({ amount: 3161.29, days_used: 14, days_in_month: 31 });
  });

  it("bills nothing outside its dates or while paused", () => {
    expect(addonLineForMonth(valet, monthWindow("2027-06-01"))).toBeNull();
    expect(addonLineForMonth({ ...valet, is_active: false }, DEC)).toBeNull();
  });
});

describe("itemMatchesAddon", () => {
  it("matches a full-month line, a prorated line and a cycle line", () => {
    expect(itemMatchesAddon({ description: "Valet car parking", amount: 7000 }, valet)).toBe(true);
    expect(itemMatchesAddon({ description: "Valet car parking", amount: 2800, monthly_rate: 7000 }, valet)).toBe(true);
    expect(itemMatchesAddon({ description: "Valet car parking | Dec", amount: 7000 }, valet)).toBe(true);
  });

  it("does not match a different add-on or a rent line", () => {
    expect(itemMatchesAddon({ description: "Name board", amount: 7000 }, valet)).toBe(false);
    expect(itemMatchesAddon({ description: "Private cabin", amount: 32956 }, valet)).toBe(false);
    expect(itemMatchesAddon({ description: "Valet car parking", amount: 1500 }, valet)).toBe(false);
  });
});

describe("applyAddonChange", () => {
  const draft = (): StatementSection[] => [
    {
      type: "prepaid_rent",
      label: "Prepaid Rent — Jan 2027",
      items: [
        { description: "Private cabin", amount: 36252 },
        { description: "Valet car parking", amount: 7000 },
      ],
      subtotal: 43252,
    },
  ];

  it("takes the line out when the add-on is paused", () => {
    const result = applyAddonChange(draft(), valet, { ...valet, is_active: false }, JAN);
    expect(result.removed?.amount).toBe(7000);
    expect(result.added).toBeNull();
    expect(result.delta).toBe(-7000);
    expect(result.sections[0].items).toHaveLength(1);
    expect(result.sections[0].subtotal).toBe(36252);
  });

  it("replaces the line with a prorated one when billing ends mid-month", () => {
    const result = applyAddonChange(draft(), valet, { ...valet, effective_until: "2027-01-14" }, JAN);
    expect(result.removed?.amount).toBe(7000);
    expect(result.added?.amount).toBe(3161.29);
    expect(result.delta).toBe(-3838.71);
    expect(result.sections[0].subtotal).toBe(39413.29);
  });

  it("puts a new add-on into the rent section", () => {
    const name: AddonTerms = { ...valet, description: "Name board", amount: 1500 };
    const result = applyAddonChange(draft(), null, name, JAN);
    expect(result.added?.amount).toBe(1500);
    expect(result.delta).toBe(1500);
    expect(result.sections[0].subtotal).toBe(44752);
  });

  it("leaves the draft untouched when nothing changes", () => {
    const original = draft();
    const result = applyAddonChange(original, valet, valet, JAN);
    expect(result.delta).toBe(0);
    expect(result.sections).toEqual(original);
  });

  it("reports when there is no rent section to put a line in", () => {
    const result = applyAddonChange([{ label: "Usage", items: [] }], null, valet, JAN);
    expect(result.placed).toBe(false);
    expect(result.added).toBeNull();
  });

  it("does not change the input", () => {
    const original = draft();
    applyAddonChange(original, valet, { ...valet, is_active: false }, JAN);
    expect(original[0].items).toHaveLength(2);
    expect(original[0].subtotal).toBe(43252);
  });
});
