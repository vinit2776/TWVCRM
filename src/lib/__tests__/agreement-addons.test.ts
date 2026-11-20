import { describe, it, expect } from "vitest";
import { addonScheduleText, agreementAddons, escalationClauses } from "../agreement-addons";

const money = (n: number) => `Rs. ${n.toLocaleString("en-IN")}`;
const date = (ymd: string) => ymd;

describe("agreementAddons", () => {
  it("lists only the add-ons that are still billing", () => {
    const list = agreementAddons([
      { description: "Valet", amount: 7000, effective_from: "2026-11-19", is_active: true },
      { description: "Locker", amount: 800, effective_from: "2026-11-19", is_active: false },
      { description: "Board", amount: 1500, effective_from: "2026-11-19" },
    ]);
    expect(list.map((a) => a.description)).toEqual(["Valet", "Board"]);
  });

  it("copes with none", () => {
    expect(agreementAddons(null)).toEqual([]);
    expect(agreementAddons(undefined)).toEqual([]);
  });
});

describe("addonScheduleText", () => {
  it("states amount, term and that it is not escalated", () => {
    const text = addonScheduleText(
      [{ description: "Valet car parking", amount: 7000, effective_from: "2026-11-19", effective_until: "2027-05-18" }],
      "2027-05-18",
      money,
      date
    );
    expect(text).toContain("Valet car parking: Rs. 7,000 + GST per month, 2026-11-19 to 2027-05-18");
    expect(text).toContain("Not subject to escalation");
    expect(text).toContain("withdrawn");
  });

  it("runs an open-ended add-on to the contract end", () => {
    const text = addonScheduleText(
      [{ description: "Locker", amount: 800, effective_from: "2026-11-19", effective_until: null }],
      "2027-05-18",
      money,
      date
    );
    expect(text).toContain("2026-11-19 to 2027-05-18");
  });

  it("puts each add-on on its own line", () => {
    const text = addonScheduleText(
      [
        { description: "Valet", amount: 7000, effective_from: "2026-11-19", effective_until: "2027-05-18" },
        { description: "Board", amount: 1500, effective_from: "2026-11-19", effective_until: "2027-02-28" },
      ],
      "2027-05-18",
      money,
      date
    );
    expect(text.split("\n").filter((l) => l.startsWith("Valet") || l.startsWith("Board"))).toHaveLength(2);
  });
});

describe("escalationClauses", () => {
  it("keeps today's wording when there are no add-ons", () => {
    const c = escalationClauses(10, 6, false);
    expect(c.escalation).toBe("10 % on Monthly Membership Fees and all products and services after expiry of 6.0 months commencing from the Commencement Date.");
    expect(c.autoRenewal).toContain("& all other charges at 10.0 %.");
  });

  it("prints a whole percent as 10.0 and a half percent as 12.5 in the auto-renewal item", () => {
    expect(escalationClauses(10, 6, false).autoRenewal).toContain("charges at 10.0 %.");
    expect(escalationClauses(12.5, 6, false).autoRenewal).toContain("charges at 12.5 %.");
  });

  it("drops 'all products and services' and says add-ons are excluded when there are some", () => {
    const c = escalationClauses(12.5, 6, true);
    expect(c.escalation).toBe("12.5 % on Monthly Membership Fees after expiry of 6.0 months commencing from the Commencement Date. Recurring Add-ons listed in item 8A are not subject to escalation.");
    expect(c.autoRenewal).toContain("Monthly Membership Fees at 12.5 %.");
    expect(c.autoRenewal).not.toContain("all other charges");
    expect(c.autoRenewal).toContain("item 8A");
  });
});

describe("escalationClauses with an escalation cycle", () => {
  it("says the fee steps every N months and points at item 8", () => {
    const c = escalationClauses(10, 24, false, 11);
    expect(c.escalation).toContain("10 % on Monthly Membership Fees on completion of every 11 months");
    expect(c.escalation).toContain("set out in item 8");
    expect(c.escalation).not.toContain("after expiry of");
  });
  it("auto-renews from the last stepped fee, not a fresh escalation", () => {
    const c = escalationClauses(10, 24, false, 11);
    expect(c.autoRenewal).toContain("in force on the last day of the Initial Term");
    expect(c.autoRenewal).toContain("every 11 months at 10.0 %");
  });
  it("keeps add-ons outside the escalation", () => {
    const c = escalationClauses(10, 24, true, 12);
    expect(c.escalation).toContain("Recurring Add-ons listed in item 8A are not subject to escalation.");
    expect(c.autoRenewal).toContain("item 8A");
  });
  it("reads exactly as before with no cycle", () => {
    expect(escalationClauses(10, 24, false, null)).toEqual(escalationClauses(10, 24, false));
    expect(escalationClauses(10, 24, false).escalation).toContain("after expiry of 24.0 months");
  });
});
