import { describe, it, expect, vi } from "vitest";
import {
  addMonthsEndAnchored,
  nextRenewalTerm,
  statementCoversNextTerm,
  termMonthsFromPeriod,
} from "@/lib/vo-renewal-term";

vi.mock("@/lib/audit", () => ({ logAudit: vi.fn() }));
import { completeVoRenewal } from "@/lib/vo-renewal-completion";

describe("nextRenewalTerm", () => {
  it("starts the day after the old end and runs whole months", () => {
    expect(nextRenewalTerm("2026-12-18", 12)).toEqual({ start: "2026-12-19", end: "2027-12-18" });
  });

  it("does not overflow a month end (31 Jan + 1 month used to land on 3 Mar)", () => {
    expect(nextRenewalTerm("2027-01-31", 1)).toEqual({ start: "2027-02-01", end: "2027-02-28" });
  });

  it("keeps a month-end term on month ends, including leap years", () => {
    expect(nextRenewalTerm("2027-02-28", 12)).toEqual({ start: "2027-03-01", end: "2028-02-29" });
    expect(nextRenewalTerm("2028-02-29", 12).end).toBe("2029-02-28");
  });

  it("crosses year boundaries for long terms", () => {
    expect(nextRenewalTerm("2026-11-30", 36)).toEqual({ start: "2026-12-01", end: "2029-11-30" });
  });

  it("falls back to 12 months for a missing or invalid tenure", () => {
    expect(nextRenewalTerm("2026-06-15", 0).end).toBe("2027-06-15");
    expect(nextRenewalTerm("2026-06-15", Number.NaN).end).toBe("2027-06-15");
  });
});

describe("addMonthsEndAnchored", () => {
  it("clamps a mid-month day that doesn't exist in the target month", () => {
    expect(addMonthsEndAnchored("2027-01-30", 1)).toBe("2027-02-28");
  });
  it("leaves an ordinary day alone", () => {
    expect(addMonthsEndAnchored("2026-10-20", 6)).toBe("2027-04-20");
  });
});

describe("statementCoversNextTerm", () => {
  it("accepts a statement starting the day after the case ends", () => {
    expect(statementCoversNextTerm("2026-12-19", "2026-12-18")).toBe(true);
  });
  it("accepts older statements that started on the old end date", () => {
    expect(statementCoversNextTerm("2026-12-18", "2026-12-18")).toBe(true);
  });
  it("rejects a statement once the case has rolled past it", () => {
    expect(statementCoversNextTerm("2026-12-19", "2027-12-18")).toBe(false);
  });
  it("rejects missing dates", () => {
    expect(statementCoversNextTerm(null, "2026-12-18")).toBe(false);
    expect(statementCoversNextTerm("2026-12-19", null)).toBe(false);
  });
});

/** Stateful stub: one case row and one statement, with filtered updates. */
function makeClient(caseRow: Record<string, unknown>, statement: Record<string, unknown>) {
  const state = { caseRow: { ...caseRow }, updates: 0 };
  const client = {
    from(table: string) {
      const filters: Record<string, unknown> = {};
      let pending: Record<string, unknown> | null = null;
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: (col: string, val: unknown) => {
          filters[col] = val;
          return builder;
        },
        update: (values: Record<string, unknown>) => {
          pending = values;
          return builder;
        },
        maybeSingle: async () => ({
          data: table === "cases" ? { ...state.caseRow } : { ...statement },
        }),
        then: (resolve: (v: unknown) => void) => {
          // Awaiting update().eq().eq().select() lands here.
          if (table === "cases" && pending) {
            const matches = Object.entries(filters).every(([k, v]) => state.caseRow[k] === v);
            if (matches) {
              state.caseRow = { ...state.caseRow, ...pending };
              state.updates += 1;
            }
            resolve({ data: matches ? [{ id: state.caseRow.id }] : [], error: null });
            return;
          }
          resolve({ data: null, error: null });
        },
      };
      return builder;
    },
  };
  return { client: client as never, state };
}

const CASE = {
  id: "case-1",
  status: "renewal_due",
  start_date: "2025-12-19",
  end_date: "2026-12-18",
  tenure_months: 12,
  rate: 18000,
  aggregator_id: null,
  aggregator: null,
};
const STATEMENT = {
  id: "stmt-1",
  case_id: "case-1",
  statement_type: "vo_renewal",
  period_start: "2026-12-19",
  payment_status: "paid",
  voided_at: null,
  fixed_amount: 19800,
};

describe("completeVoRenewal", () => {
  it("rolls the case to the next continuous term and saves the billed fee", async () => {
    const { client, state } = makeClient(CASE, STATEMENT);
    const outcome = await completeVoRenewal(client, { statementId: "stmt-1", source: "recorded_payment" });
    expect(outcome).toBe("renewed");
    expect(state.caseRow).toMatchObject({
      status: "active",
      start_date: "2026-12-19",
      end_date: "2027-12-18",
      rate: 19800,
    });
  });

  it("renews only once when the same statement settles twice", async () => {
    const { client, state } = makeClient(CASE, STATEMENT);
    await completeVoRenewal(client, { statementId: "stmt-1", source: "razorpay_link" });
    const second = await completeVoRenewal(client, { statementId: "stmt-1", source: "recorded_payment" });
    expect(second).toBe("already_renewed");
    expect(state.updates).toBe(1);
    expect(state.caseRow.end_date).toBe("2027-12-18");
  });

  it("ignores statements that are not renewals, unpaid or voided", async () => {
    for (const s of [
      { ...STATEMENT, statement_type: "vo_case" },
      { ...STATEMENT, payment_status: "partially_paid" },
      { ...STATEMENT, voided_at: "2026-12-01T00:00:00Z" },
    ]) {
      const { client, state } = makeClient(CASE, s);
      const outcome = await completeVoRenewal(client, { statementId: "stmt-1", source: "recorded_payment" });
      expect(outcome).not.toBe("renewed");
      expect(state.updates).toBe(0);
    }
  });

  it("leaves a postpaid partner case's monthly rate alone", async () => {
    const { client, state } = makeClient(
      { ...CASE, aggregator_id: "agg-1", aggregator: { billing_method: "postpaid" } },
      STATEMENT,
    );
    await completeVoRenewal(client, { statementId: "stmt-1", source: "recorded_payment" });
    expect(state.caseRow.end_date).toBe("2027-12-18");
    expect(state.caseRow.rate).toBe(18000);
  });

  it("takes the term length from the bill when Start renewal offered a different one", async () => {
    const { client, state } = makeClient(CASE, { ...STATEMENT, period_end: "2027-06-18", fixed_amount: 9900 });
    await completeVoRenewal(client, { statementId: "stmt-1", source: "razorpay_link" });
    expect(state.caseRow).toMatchObject({
      start_date: "2026-12-19",
      end_date: "2027-06-18",
      tenure_months: 6,
      rate: 9900,
    });
  });
});

describe("termMonthsFromPeriod", () => {
  it("reads whole-month terms back from the period end", () => {
    expect(termMonthsFromPeriod("2026-12-18", "2027-12-18")).toBe(12);
    expect(termMonthsFromPeriod("2026-12-18", "2029-12-18")).toBe(36);
    expect(termMonthsFromPeriod("2027-02-28", "2027-08-31")).toBe(6);
  });
  it("returns null for a period that is not a whole-month term", () => {
    expect(termMonthsFromPeriod("2026-12-18", "2027-12-20")).toBeNull();
    expect(termMonthsFromPeriod("2026-12-18", null)).toBeNull();
  });
});
