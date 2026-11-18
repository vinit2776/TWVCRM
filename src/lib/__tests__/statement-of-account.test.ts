import { describe, it, expect } from "vitest";
import { buildLedger, soaFyOptions, soaRange, type SoaStatementInput } from "../statement-of-account";

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
});
