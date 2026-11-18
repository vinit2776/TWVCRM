import { describe, it, expect } from "vitest";
import { buildLedger, chargeDescriptions, soaFyOptions, soaRange, type SoaStatementInput } from "../statement-of-account";

const stmt = (o: Partial<SoaStatementInput> & { id: string }): SoaStatementInput => ({
  status: "finalized", statement_number: `BS-${o.id}`, gst_invoice_number: null, total_amount: 1000,
  voided_at: null, proforma_sent_at: "2026-06-10T05:00:00Z", emailed_at: null, finalized_at: null,
  created_at: "2026-06-09T05:00:00Z", period_start: null, period_end: null, statement_type: null, ...o,
});

describe("statement of account", () => {
  const today = new Date("2026-11-18T06:00:00Z");

  it("derives Indian financial-year ranges", () => {
    expect(soaRange(2026)).toMatchObject({ from: "2026-04-01", to: "2027-03-31", label: "FY 2026-27" });
    expect(soaFyOptions(today).map((r) => r.label).slice(0, 2)).toEqual(["FY 2026-27", "FY 2025-26"]);
    expect(soaFyOptions(new Date("2027-02-01T00:00:00Z"))[0].from).toBe("2026-04-01");
  });

  it("omits voided, discarded, draft and never-sent statements", () => {
    const ledger = buildLedger([
      stmt({ id: "ok" }),
      stmt({ id: "v", status: "voided" }),
      stmt({ id: "d", status: "discarded" }),
      stmt({ id: "dr", status: "draft" }),
      stmt({ id: "vo", voided_at: "2026-06-11T00:00:00Z" }),
      stmt({ id: "unsent", proforma_sent_at: null }),
    ], [], soaRange(2026));
    expect(ledger.rows).toHaveLength(1);
    expect(ledger.closing).toBe(1000);
  });

  it("keeps an unsent statement that has a payment on it", () => {
    const ledger = buildLedger(
      [stmt({ id: "p", proforma_sent_at: null })],
      [{ billing_statement_id: "p", amount: 1000, tds_amount: 0, payment_date: "2026-07-01", payment_mode: "upi", payment_reference: null }],
      soaRange(2026),
    );
    expect(ledger.rows).toHaveLength(2);
    expect(ledger.closing).toBe(0);
  });

  it("drops payments of omitted statements and carries an opening balance", () => {
    const range = soaRange(2026);
    const ledger = buildLedger(
      [stmt({ id: "old", proforma_sent_at: "2026-02-01T05:00:00Z", total_amount: 5000 }), stmt({ id: "gone", status: "voided" })],
      [
        { billing_statement_id: "old", amount: 2000, tds_amount: 0, payment_date: "2026-02-10", payment_mode: "upi", payment_reference: null },
        { billing_statement_id: "old", amount: 1000, tds_amount: 100, payment_date: "2026-07-01", payment_mode: "bank_transfer", payment_reference: "X1" },
        { billing_statement_id: "gone", amount: 999, tds_amount: 0, payment_date: "2026-07-01", payment_mode: "upi", payment_reference: null },
      ],
      range,
    );
    expect(ledger.opening).toBe(3000);
    expect(ledger.rows).toHaveLength(1);
    expect(ledger.closing).toBe(1900);
  });

  it("ages unpaid documents from the invoice date into buckets", () => {
    const now = new Date("2026-11-18T06:00:00Z");
    const ledger = buildLedger(
      [
        stmt({ id: "a", proforma_sent_at: "2026-11-10T05:00:00Z", total_amount: 100 }),
        stmt({ id: "b", proforma_sent_at: "2026-09-20T05:00:00Z", total_amount: 200, gst_invoice_number: "TWV/1" }),
        stmt({ id: "c", proforma_sent_at: "2026-06-01T05:00:00Z", total_amount: 300 }),
        stmt({ id: "d", proforma_sent_at: "2026-06-01T05:00:00Z", total_amount: 400 }),
      ],
      [
        { billing_statement_id: "d", amount: 400, tds_amount: 0, payment_date: "2026-07-01", payment_mode: "upi", payment_reference: null },
        { billing_statement_id: "c", amount: 100, tds_amount: 0, payment_date: "2026-07-01", payment_mode: "upi", payment_reference: null },
      ],
      soaRange(2026), now,
    );
    expect(ledger.outstanding.map((o) => [o.document, o.kind, o.balance, o.bucket])).toEqual([
      ["PI BS-c", "Pending PI", 200, "Over 90 days"],
      ["TWV/1", "GST invoice", 200, "31-60 days"],
      ["PI BS-a", "Pending PI", 100, "0-30 days"],
    ]);
    expect(ledger.agingTotals).toEqual([100, 200, 0, 200]);
  });

  it("measures aging to the FY end for a past year", () => {
    const ledger = buildLedger(
      [stmt({ id: "a", proforma_sent_at: "2026-02-01T05:00:00Z" })], [], soaRange(2025), new Date("2026-11-18T06:00:00Z"),
    );
    expect(ledger.asOf).toBe("2026-03-31");
    expect(ledger.outstanding[0].days).toBe(58);
  });

  it("names the contract or booking and lists the charged lines", () => {
    const ledger = buildLedger(
      [
        stmt({ id: "a", reference: "Contract TWV-C-0039", charges: ["Dedicated desk x2", "Parking", "Printing", "Meeting room", "Locker", "Extra"], period_start: "2026-06-01", period_end: "2026-06-30" }),
        stmt({ id: "b", reference: "Booking BK-0012", charges: ["Conference room, 2 hrs"], proforma_sent_at: "2026-06-12T05:00:00Z" }),
      ],
      [{ billing_statement_id: "a", amount: 1000, tds_amount: 0, payment_date: "2026-07-01", payment_mode: "upi", payment_reference: "R1" }],
      soaRange(2026),
    );
    expect(ledger.rows[0].particulars).toBe("Contract TWV-C-0039 · 2026-06-01 to 2026-06-30\n- Dedicated desk x2\n- Parking\n- Printing\n- Meeting room\n- +2 more");
    expect(ledger.rows[1].particulars).toBe("Booking BK-0012\n- Conference room, 2 hrs");
    expect(ledger.rows.find((r) => r.credit)!.particulars).toContain("Contract TWV-C-0039");
    expect(ledger.outstanding.find((o) => o.reference === "BK-0012")).toBeTruthy();
  });

  it("reads charge descriptions from line items and live usage rows", () => {
    expect(chargeDescriptions(
      [{ type: "prepaid_rent", label: "Rent", items: [{ description: "Rent, 2 seats" }] }, { type: "ad_hoc_charges", items: [{ description: "frozen" }] }, { type: "booking_usage", items: [{ date: "2026-06-02", space: "Room A", time: "10:00-12:00" }] }],
      [{ description: "Printing", is_waived: false }, { description: "Waived", is_waived: true }],
    )).toEqual(["Rent, 2 seats", "2026-06-02 · Room A · 10:00-12:00", "Printing"]);
  });
});
