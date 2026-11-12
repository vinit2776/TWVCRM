import { describe, it, expect } from "vitest";
import { evaluateChain, type ChainInput, CHAIN_LOCK_DELAY_DAYS } from "../procurement/chain-lock";

const DAY = 86_400_000;
const iso = (d: number) => new Date(Date.UTC(2026, 9, 1) + d * DAY).toISOString(); // day 0 = 1 Oct 2026
const at = (d: number) => new Date(Date.UTC(2026, 9, 1) + d * DAY);

// A fully complete goods chain: MR → one PO → one bill, paid, TDS deposited.
const complete = (): ChainInput => ({
  root: { type: "pr", id: "pr1" },
  pr: { status: "po_created", approved_at: iso(1), pr_number: "MR-1" },
  pos: [{
    id: "po1", po_number: "PO-1", po_type: "goods", status: "invoice_approved",
    advance_amount: null, advance_status: "not_required", amc_end_date: null, amc_terminated_at: null,
    items: [{ quantity_ordered: 10, quantity_received: 10 }], lastReceiptAt: iso(3),
  }],
  bills: [{ id: "b1", bill_number: "BILL-1", po_id: "po1", approval_status: "approved", payment_status: "paid", approved_at: iso(5), lastPaymentAt: iso(8) }],
  tds: [{ bill_id: "b1", status: "deposited", reversed_at: null, challanAt: iso(10) }],
  lastReopenAt: null,
  lockEffectiveFrom: "2000-01-01T00:00:00.000Z", // lock long since switched on, unless a test says otherwise
});

describe("evaluateChain", () => {
  it("is closing for the grace period after the last step, then locked", () => {
    const c = complete(); // last step: TDS challan on day 10
    const during = evaluateChain(c, at(10 + CHAIN_LOCK_DELAY_DAYS - 1));
    expect(during.state).toBe("closing");
    expect(during.lockAt).toBe(iso(10 + CHAIN_LOCK_DELAY_DAYS));
    expect(evaluateChain(c, at(10 + CHAIN_LOCK_DELAY_DAYS)).state).toBe("locked");
    expect(evaluateChain(c, at(60)).state).toBe("locked");
  });

  it("stays open while any step is outstanding", () => {
    const unpaid = complete();
    unpaid.bills[0].payment_status = "partially_paid";
    const r = evaluateChain(unpaid, at(60));
    expect(r.state).toBe("open");
    expect(r.conditions.find((c) => c.key === "paid")).toMatchObject({ done: false });
    expect(r.conditions.find((c) => c.key === "paid")!.detail).toContain("part-paid");
  });

  it("is open until TDS is on a challan, and ignores reversed TDS", () => {
    const c = complete();
    c.tds = [{ bill_id: "b1", status: "pending", reversed_at: null, challanAt: null }];
    expect(evaluateChain(c, at(60)).state).toBe("open");
    c.tds = [{ bill_id: "b1", status: "pending", reversed_at: iso(9), challanAt: null }];
    expect(evaluateChain(c, at(60)).state).toBe("locked");
  });

  it("is open if the MR is only partly ordered", () => {
    const c = complete();
    c.pr!.status = "partially_ordered";
    const r = evaluateChain(c, at(60));
    expect(r.state).toBe("open");
    expect(r.conditions[0].detail).toContain("unordered");
  });

  it("needs a bill on every PO", () => {
    const c = complete();
    c.pos.push({ ...c.pos[0], id: "po2", po_number: "PO-2" });
    const r = evaluateChain(c, at(60));
    expect(r.state).toBe("open");
    expect(r.conditions.find((x) => x.key === "approved")!.detail).toContain("PO-2 has no bill yet");
  });

  it("ignores cancelled POs and withdrawn/rejected bills", () => {
    const c = complete();
    c.pos.push({ ...c.pos[0], id: "po2", po_number: "PO-2", status: "cancelled", items: [] });
    c.bills.push({ id: "b2", bill_number: "BILL-2", po_id: "po1", approval_status: "withdrawn", payment_status: "unpaid", approved_at: null, lastPaymentAt: null });
    c.bills.push({ id: "b3", bill_number: "BILL-3", po_id: "po1", approval_status: "rejected", payment_status: "unpaid", approved_at: null, lastPaymentAt: null });
    expect(evaluateChain(c, at(60)).state).toBe("locked");
  });

  it("requires goods to be fully received and any advance to be paid", () => {
    const short = complete();
    short.pos[0].items = [{ quantity_ordered: 10, quantity_received: 6 }];
    expect(evaluateChain(short, at(60)).state).toBe("open");
    const adv = complete();
    adv.pos[0].advance_amount = 5000;
    adv.pos[0].advance_status = "pending";
    expect(evaluateChain(adv, at(60)).state).toBe("open");
    adv.pos[0].advance_status = "processed";
    expect(evaluateChain(adv, at(60)).state).toBe("locked");
  });

  it("closes an AMC only once the contract has ended", () => {
    const c = complete();
    c.pos[0] = { ...c.pos[0], po_type: "service", items: [], amc_end_date: "2027-03-29" };
    expect(evaluateChain(c, at(60)).state).toBe("open");
    c.pos[0].amc_terminated_at = iso(12);
    const r = evaluateChain(c, at(60));
    expect(r.state).toBe("locked");
    expect(r.completeSince).toBe(iso(12)); // termination is the last step
  });

  it("treats a past AMC end date as ended", () => {
    const c = complete();
    c.pos[0] = { ...c.pos[0], po_type: "service", items: [], amc_end_date: "2026-10-05" };
    expect(evaluateChain(c, at(60)).state).toBe("locked");
  });

  it("a reopen restarts the grace period even if nothing new is recorded", () => {
    const c = complete();
    c.lastReopenAt = iso(40);
    expect(evaluateChain(c, at(41)).state).toBe("closing");
    expect(evaluateChain(c, at(41)).reopened).toBe(true);
    expect(evaluateChain(c, at(40 + CHAIN_LOCK_DELAY_DAYS)).state).toBe("locked");
  });

  it("re-closes 7 days after a fix recorded after the reopen", () => {
    const c = complete();
    c.lastReopenAt = iso(40);
    c.bills[0].lastPaymentAt = iso(42); // corrected payment
    expect(evaluateChain(c, at(42 + CHAIN_LOCK_DELAY_DAYS - 1)).state).toBe("closing");
    expect(evaluateChain(c, at(42 + CHAIN_LOCK_DELAY_DAYS)).state).toBe("locked");
  });

  it("an undated legacy chain never locks", () => {
    const c = complete();
    c.pr!.approved_at = null; c.pos[0].lastReceiptAt = null;
    c.bills[0].approved_at = null; c.bills[0].lastPaymentAt = null; c.tds[0].challanAt = null;
    const r = evaluateChain(c, at(500));
    expect(r.state).toBe("open");
    expect(r.exempt).toBe(true);
  });

  describe("lock cut-off", () => {
    it("a chain that completed before the cut-off never locks, however old", () => {
      const c = complete(); // last step day 10
      c.lockEffectiveFrom = iso(30);
      const r = evaluateChain(c, at(500));
      expect(r.state).toBe("open");
      expect(r.exempt).toBe(true);
      expect(r.lockAt).toBeNull();
      expect(r.completeSince).toBe(iso(10));
    });

    it("a chain that completed on or after the cut-off locks normally", () => {
      const c = complete();
      c.lockEffectiveFrom = iso(10); // exactly the completion moment
      expect(evaluateChain(c, at(10 + CHAIN_LOCK_DELAY_DAYS - 1)).state).toBe("closing");
      expect(evaluateChain(c, at(10 + CHAIN_LOCK_DELAY_DAYS)).state).toBe("locked");
    });

    it("an old chain that is fixed after the cut-off starts locking from the fix", () => {
      const c = complete();
      c.lockEffectiveFrom = iso(30);
      c.bills[0].lastPaymentAt = iso(40); // corrected payment after the cut-off
      expect(evaluateChain(c, at(41)).state).toBe("closing");
      expect(evaluateChain(c, at(40 + CHAIN_LOCK_DELAY_DAYS)).state).toBe("locked");
    });

    it("nothing locks while the cut-off is not set", () => {
      const c = complete();
      c.lockEffectiveFrom = null;
      expect(evaluateChain(c, at(500)).state).toBe("open");
      expect(evaluateChain(c, at(500)).exempt).toBe(true);
    });

    it("an incomplete chain is simply open, not exempt", () => {
      const c = complete();
      c.bills[0].payment_status = "unpaid";
      expect(evaluateChain(c, at(500)).exempt).toBe(false);
    });
  });

  it("evaluates a standalone bill chain", () => {
    const c: ChainInput = {
      root: { type: "bill", id: "b1" }, pr: null, pos: [],
      bills: [{ id: "b1", bill_number: "BILL-1", po_id: null, approval_status: "approved", payment_status: "paid", approved_at: iso(1), lastPaymentAt: iso(2) }],
      tds: [], lastReopenAt: null, lockEffectiveFrom: "2000-01-01T00:00:00.000Z",
    };
    expect(evaluateChain(c, at(20)).state).toBe("locked");
    c.bills[0].payment_status = "unpaid";
    expect(evaluateChain(c, at(20)).state).toBe("open");
  });
});
