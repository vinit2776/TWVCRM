import { describe, it, expect } from "vitest";
import { addonsClauseText, classifyAddons, feeScheduleRows, type AddendumAddon } from "../addendum-addons";

const money = (n: number) => `Rs. ${n.toLocaleString("en-IN", { minimumFractionDigits: n % 1 ? 2 : 0 })}`;
const date = (ymd: string) => ymd;

const valetOld: AddendumAddon = { description: "Valet car parking", amount: 7000, effective_from: "2026-11-19", effective_until: "2027-05-18" };
const boardOld: AddendumAddon = { description: "Name board", amount: 1500, effective_from: "2026-11-19", effective_until: "2027-05-18" };
const lockerOld: AddendumAddon = { description: "Locker", amount: 800, effective_from: "2026-11-19", effective_until: "2027-02-28" };
const valetNew: AddendumAddon = { description: "valet car parking ", amount: 7000, effective_from: "2027-05-19", effective_until: "2027-11-18" };
const bikeNew: AddendumAddon = { description: "Bike slot", amount: 500, effective_from: "2027-05-19", effective_until: "2027-11-18" };

describe("classifyAddons", () => {
  it("separates continued, added and not-continued add-ons", () => {
    const c = classifyAddons([valetOld, boardOld, lockerOld], [valetNew, bikeNew], "2027-05-18");
    expect(c.continued.map((a) => a.description.trim())).toEqual(["valet car parking"]);
    expect(c.added.map((a) => a.description)).toEqual(["Bike slot"]);
    // The locker had already stopped in February, so it is not news; the board ran to the end and is dropped.
    expect(c.ended.map((a) => a.description)).toEqual(["Name board"]);
  });

  it("returns nothing for a renewal with no add-ons on either side", () => {
    expect(classifyAddons([], [], "2027-05-18")).toEqual({ continued: [], added: [], ended: [] });
  });
});

describe("addonsClauseText", () => {
  it("says what continues, what is new and what stops", () => {
    const c = classifyAddons([valetOld, boardOld], [valetNew, bikeNew], "2027-05-18");
    const text = addonsClauseText(c, "2027-05-18", money, date, "2027-11-18") ?? "";
    expect(text).toContain("Continued at the same monthly amount, not escalated: valet car parking");
    expect(text).toContain("Added for the renewal term, not subject to escalation: Bike slot");
    expect(text).toContain("Not continued after 2027-05-18: Name board.");
    expect(text).toContain("withdrawn");
  });

  it("says nothing when there is nothing to say", () => {
    expect(addonsClauseText({ continued: [], added: [], ended: [] }, "2027-05-18", money, date, "2027-11-18")).toBeNull();
  });
});

describe("feeScheduleRows", () => {
  const items = [{ description: "Private cabin", quantity: 4, unit_price: 9063, total: 36252 }];
  const base = {
    items,
    subtotal: 36252,
    taxPercentage: 18,
    taxAmount: 6525.36,
    totalAmount: 42777.36,
    renewalEnd: "2027-11-18",
    formatMoney: money,
    formatDate: date,
  };

  it("keeps the old table exactly when there are no add-ons", () => {
    const rows = feeScheduleRows({ ...base, addons: [] });
    expect(rows).toEqual([
      ["1", "Private cabin", "4", "Rs. 9,063", "Rs. 36,252"],
      ["", "", "", "Subtotal", "Rs. 36,252"],
      ["", "", "", "GST @ 18%", "Rs. 6,525.36"],
      ["", "", "", "Total (incl. tax)", "Rs. 42,777.36"],
    ]);
  });

  it("shows the fee and the add-ons as two sections, and totals both", () => {
    const rows = feeScheduleRows({ ...base, addons: [valetNew] });
    const first = (r: (typeof rows)[number]) => (typeof r[0] === "string" ? r[0] : r[0].content);
    expect(first(rows[0])).toBe("Monthly membership fee (escalating)");
    expect(first(rows[2])).toBe("Recurring add-ons (not escalated)");
    expect(rows[3]).toEqual(["2", "valet car parking \n2027-05-19 to 2027-11-18", "1", "Rs. 7,000", "Rs. 7,000"]);
    // 36,252 + 7,000 = 43,252; GST 18% = 7,785.36; total 51,037.36, as in the real 0161 addendum
    expect(rows[4]).toEqual(["", "", "", "Subtotal", "Rs. 43,252"]);
    expect(rows[5]).toEqual(["", "", "", "GST @ 18%", "Rs. 7,785.36"]);
    expect(rows[6]).toEqual(["", "", "", "Total (incl. tax)", "Rs. 51,037.36"]);
  });

  it("keeps Qty x Rate = Amount on every add-on line", () => {
    const rows = feeScheduleRows({ ...base, addons: [valetNew, bikeNew] });
    const addonRows = rows.filter((r) => typeof r[0] === "string" && ["2", "3"].includes(r[0] as string));
    expect(addonRows).toHaveLength(2);
    for (const r of addonRows) expect(r[3]).toBe(r[4]);
  });
});
