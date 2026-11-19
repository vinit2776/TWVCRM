import { describe, expect, it } from "vitest";
import { cycleLabel, groupInboxRows, needsAccounts, rowCycle } from "../inbox-grouping";
import type { InboxRow } from "../tally-handoff";

type Partial_ = Record<string, unknown>;
const row = (o: Partial_): InboxRow =>
  ({ handoff_state: "ready_to_send", has_discrepancy: false, cancellation_requested_at: null, statement_total_amount: 100, period_start: null, line_items: { statement_type: "rent" }, contract: { lead: { gst_number: "G1" } }, ...o }) as unknown as InboxRow;
const name = (r: InboxRow) => (r as unknown as { n: string }).n;

describe("rowCycle", () => {
  it("is the period's month for recurring invoices", () => {
    expect(rowCycle(row({ period_start: "2026-11-01" }))).toBe("2026-11");
  });
  it("is null for reimbursements and ad hoc invoices even though they carry a date", () => {
    expect(rowCycle(row({ period_start: "2026-11-18", line_items: { statement_type: "reimbursement" } }))).toBeNull();
    expect(rowCycle(row({ period_start: "2026-11-18", invoice: { id: "x" } }))).toBeNull();
  });
});

describe("needsAccounts", () => {
  it("is false only while the customer holds the invoice", () => {
    expect(needsAccounts(row({ handoff_state: "gst_sent_awaiting_payment" }))).toBe(false);
    expect(needsAccounts(row({ handoff_state: "ready_to_send" }))).toBe(true);
    expect(needsAccounts(row({ handoff_state: "gst_sent_awaiting_payment", has_discrepancy: true }))).toBe(true);
  });
});

describe("groupInboxRows", () => {
  const rows = [
    row({ n: "Zed Co", handoff_state: "gst_sent_awaiting_payment", period_start: "2026-10-01" }),
    row({ n: "Acme", handoff_state: "gst_sent_awaiting_payment", period_start: "2026-11-01" }),
    row({ n: "Mid Ltd", handoff_state: "ready_to_send", period_start: "2026-10-01", statement_total_amount: 250 }),
    row({ n: "Mid Ltd", handoff_state: "gst_sent_awaiting_payment", period_start: "2026-11-01" }),
  ];
  it("puts customers that need accounts first, then alphabetical", () => {
    const g = groupInboxRows(rows, "customer", name);
    expect(g.map((x) => x.title)).toEqual(["Mid Ltd", "Acme", "Zed Co"]);
    expect(g[0].needs).toBe(1);
    expect(g[0].total).toBe(350);
    expect(g[0].subtitle).toBe("G1");
  });
  it("lists what needs accounts first inside a customer", () => {
    const mid = groupInboxRows(rows, "customer", name)[0];
    expect(mid.rows.map((r) => r.handoff_state)).toEqual(["ready_to_send", "gst_sent_awaiting_payment"]);
  });
  it("orders cycles newest first with one-offs last", () => {
    const withOneOff = [...rows, row({ n: "Delta", line_items: { statement_type: "reimbursement" }, period_start: "2026-11-18" })];
    const g = groupInboxRows(withOneOff, "cycle", name);
    expect(g.map((x) => x.key)).toEqual(["2026-11", "2026-10", "one_off"]);
    expect(g[2].title).toBe("No billing cycle · one-off");
  });
});

describe("cycleLabel", () => {
  it("formats short and long", () => {
    expect(cycleLabel("2026-11", true)).toBe("NOV 2026");
    expect(cycleLabel("2026-11", false)).toBe("November 2026");
  });
});
