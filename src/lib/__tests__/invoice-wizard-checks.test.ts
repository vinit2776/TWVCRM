import { describe, it, expect } from "vitest";
import { rentCheck, usageCheck, electricityCheck, type RentRow, type UsageGroup } from "@/lib/invoice-wizard-checks";

const row = (category: string, periodLabel: string): RentRow => ({ contractId: "c1", category, periodLabel });

describe("rentCheck", () => {
  it("warns about missed months, naming them, ahead of anything else", () => {
    const c = rentCheck([
      row("current_cycle", "November 2026 · current cycle"),
      row("rent_gap", "August 2026 · gap"),
      row("rent_gap", "September 2026 · gap"),
    ]);
    expect(c.tone).toBe("warn");
    expect(c.text).toBe("2 months not invoiced: August 2026, September 2026");
  });

  it("uses singular for a single missed month", () => {
    expect(rentCheck([row("rent_gap", "August 2026 · gap")]).text).toBe("1 month not invoiced: August 2026");
  });

  it("points at a draft that is ready to review", () => {
    const c = rentCheck([row("current_cycle", "November 2026 · current cycle")]);
    expect(c).toEqual({ tone: "info", text: "November 2026 draft is ready to review and send" });
  });

  it("says when the month is with accounts", () => {
    expect(rentCheck([row("current_cycle_tally", "October 2026 · with accounts")]).text).toBe("October 2026 is with accounts (Tally Inbox)");
  });

  it("reports an already-sent month as fine", () => {
    expect(rentCheck([row("current_cycle_sent", "October 2026 · sent")])).toEqual({ tone: "ok", text: "October 2026 rent is already sent" });
  });

  it("says nothing is waiting when the contract has no rows, or only renewal rows", () => {
    expect(rentCheck([]).tone).toBe("ok");
    expect(rentCheck([row("renewal_drift", "x"), row("no_renewal", "y")]).text).toBe("Nothing to invoice. Rent is up to date.");
  });
});

const month = (over: Partial<UsageGroup["months"][number]>): UsageGroup["months"][number] => ({
  label: "September 2026", canSend: true, block: null, alreadyInvoiced: null, total: 118, ...over,
});
const group = (months: UsageGroup["months"]): UsageGroup => ({ contractId: "c1", months, total: 0 });

describe("usageCheck", () => {
  it("is informational when nothing is unbilled", () => {
    expect(usageCheck(undefined).text).toBe("No unbilled usage right now");
    expect(usageCheck(group([])).tone).toBe("info");
  });

  it("lists months that can already be sent, with amounts", () => {
    const c = usageCheck(group([month({}), month({ label: "August 2026", total: 1003 })]));
    expect(c.text).toBe("Already waiting: September 2026 ₹118, August 2026 ₹1,003");
  });

  it("warns when a month is locked in accounting, before anything else", () => {
    const c = usageCheck(group([month({}), month({ label: "July 2026", canSend: false, block: "accounting_locked" })]));
    expect(c.tone).toBe("warn");
    expect(c.text).toContain("July 2026 is locked in accounting");
  });

  it("explains that the current month can't be sent yet", () => {
    const c = usageCheck(group([month({ label: "October 2026", canSend: false, block: "open_month" })]));
    expect(c.text).toBe("October 2026 usage can be sent once the month ends");
  });
});

describe("electricityCheck", () => {
  it("warns when electricity billing isn't set up", () => {
    const c = electricityCheck(false, [], "October 2026");
    expect(c.tone).toBe("warn");
    expect(c.text).toContain("isn't set up");
  });

  it("warns about double-billing when the month is already invoiced", () => {
    const c = electricityCheck(true, [{ status: "invoiced", bill_month: 10, bill_year: 2026 }], "October 2026");
    expect(c.tone).toBe("warn");
    expect(c.text).toContain("already invoiced");
  });

  it("notes a draft bill, and the absence of any bill", () => {
    expect(electricityCheck(true, [{ status: "draft", bill_month: 10, bill_year: 2026 }], "October 2026").text).toBe("A draft bill for October 2026 already exists");
    expect(electricityCheck(true, [], "October 2026").text).toBe("No October 2026 bill captured yet");
  });
});
