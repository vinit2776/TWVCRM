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

type Row = Record<string, unknown>;

/** In-memory stand-in for the few tables completion touches. */
function makeClient(caseRow: Row, statement: Row, extra: Record<string, Row[]> = {}) {
  const db: Record<string, Row[]> = {
    cases: [{ ...caseRow }],
    billing_statements: [{ ...statement }],
    case_documents: [],
    case_compliance_checks: [],
    ...extra,
  };
  let nextId = 1;
  const client = {
    from(table: string) {
      const eqs: [string, unknown][] = [];
      const neqs: [string, unknown][] = [];
      let op: { kind: "select" } | { kind: "update"; values: Row } | { kind: "insert"; rows: Row[] } = { kind: "select" };
      const matches = (r: Row) => eqs.every(([k, v]) => r[k] === v) && neqs.every(([k, v]) => r[k] !== v);
      const run = () => {
        const rows = db[table] ?? (db[table] = []);
        if (op.kind === "insert") {
          const inserted = op.rows.map((r) => ({ ...r, id: `new-${nextId++}`, case_number: r.case_number ?? `TWV-CASE-${nextId}` }));
          rows.push(...inserted);
          return inserted;
        }
        const hit = rows.filter(matches);
        if (op.kind === "update") {
          const values = op.values;
          for (const r of hit) Object.assign(r, values);
        }
        return hit.map((r) => ({ ...r }));
      };
      const builder: Row = {
        select: () => builder,
        eq: (col: string, val: unknown) => (eqs.push([col, val]), builder),
        neq: (col: string, val: unknown) => (neqs.push([col, val]), builder),
        update: (values: Row) => ((op = { kind: "update", values }), builder),
        insert: (rows: Row | Row[]) => ((op = { kind: "insert", rows: Array.isArray(rows) ? rows : [rows] }), builder),
        maybeSingle: async () => ({ data: run()[0] ?? null, error: null }),
        single: async () => ({ data: run()[0] ?? null, error: null }),
        then: (resolve: (v: unknown) => void) => resolve({ data: run(), error: null }),
      };
      return builder;
    },
  };
  return { client: client as never, db };
}

const CASE = {
  id: "case-1",
  case_number: "TWV-CASE-0001",
  status: "renewal_due",
  is_renewal: false,
  parent_case_id: null,
  client_name: "Acme",
  purpose: "business_address",
  start_date: "2025-12-19",
  end_date: "2026-12-18",
  tenure_months: 12,
  rate: 18000,
  aggregator_id: null,
  aggregator: null,
  renewal_notices_enabled: false,
  renewal_billing_statement_id: "stmt-1",
  ll_agreement_id: "ll-1",
  email_thread_id: "thread-1",
  metadata: { source: "intake" },
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
  it("creates the next continuous term as its own case and marks this one renewed", async () => {
    const { client, db } = makeClient(CASE, STATEMENT);
    const outcome = await completeVoRenewal(client, { statementId: "stmt-1", source: "recorded_payment" });
    expect(outcome).toBe("renewed");
    expect(db.cases[0]).toMatchObject({ status: "renewed", start_date: "2025-12-19", end_date: "2026-12-18", rate: 18000 });
    expect(db.cases).toHaveLength(2);
    expect(db.cases[1]).toMatchObject({
      status: "active",
      is_renewal: true,
      parent_case_id: "case-1",
      client_name: "Acme",
      purpose: "business_address",
      start_date: "2026-12-19",
      end_date: "2027-12-18",
      tenure_months: 12,
      rate: 19800,
      renewal_notices_enabled: false,
      metadata: { source: "intake", renewed_from_case_id: "case-1", renewal_billing_statement_id: "stmt-1" },
    });
    expect(db.cases[1].case_number).not.toBe("TWV-CASE-0001");
    for (const column of ["aggregator", "ll_agreement_id", "email_thread_id", "renewal_billing_statement_id"]) {
      expect(db.cases[1]).not.toHaveProperty(column);
    }
  });

  it("moves the paid bill onto the new term's case", async () => {
    const { client, db } = makeClient(CASE, STATEMENT);
    await completeVoRenewal(client, { statementId: "stmt-1", source: "razorpay_link" });
    expect(db.billing_statements[0].case_id).toBe(db.cases[1].id);
  });

  it("carries KYC documents and compliance checks over", async () => {
    const { client, db } = makeClient(CASE, STATEMENT, {
      case_documents: [{ id: "doc-1", case_id: "case-1", document_id: "file-1", status: "approved", created_at: "x" }],
      case_compliance_checks: [{ id: "chk-1", case_id: "case-1", check_name: "PAN", status: "passed" }],
    });
    await completeVoRenewal(client, { statementId: "stmt-1", source: "recorded_payment" });
    const newId = db.cases[1].id;
    expect(db.case_documents).toHaveLength(2);
    expect(db.case_documents[1]).toMatchObject({ case_id: newId, document_id: "file-1", status: "approved" });
    expect(db.case_documents[1].id).not.toBe("doc-1");
    expect(db.case_compliance_checks[1]).toMatchObject({ case_id: newId, check_name: "PAN", status: "passed" });
  });

  it("points later terms at the first case, one level deep", async () => {
    const { client, db } = makeClient({ ...CASE, id: "case-2", is_renewal: true, parent_case_id: "root" }, { ...STATEMENT, case_id: "case-2" });
    await completeVoRenewal(client, { statementId: "stmt-1", source: "recorded_payment" });
    expect(db.cases[1].parent_case_id).toBe("root");
  });

  it("creates one new term when the same statement settles twice", async () => {
    const { client, db } = makeClient(CASE, STATEMENT);
    await completeVoRenewal(client, { statementId: "stmt-1", source: "razorpay_link" });
    const second = await completeVoRenewal(client, { statementId: "stmt-1", source: "recorded_payment" });
    expect(second).toBe("already_renewed");
    expect(db.cases).toHaveLength(2);
  });

  it("does nothing for a case that is already renewed", async () => {
    const { client, db } = makeClient({ ...CASE, status: "renewed" }, STATEMENT);
    const outcome = await completeVoRenewal(client, { statementId: "stmt-1", source: "recorded_payment" });
    expect(outcome).toBe("already_renewed");
    expect(db.cases).toHaveLength(1);
  });

  it("ignores statements that are not renewals, unpaid or voided", async () => {
    for (const s of [
      { ...STATEMENT, statement_type: "vo_case" },
      { ...STATEMENT, payment_status: "partially_paid" },
      { ...STATEMENT, voided_at: "2026-12-01T00:00:00Z" },
    ]) {
      const { client, db } = makeClient(CASE, s);
      const outcome = await completeVoRenewal(client, { statementId: "stmt-1", source: "recorded_payment" });
      expect(outcome).not.toBe("renewed");
      expect(db.cases).toHaveLength(1);
      expect(db.cases[0].status).toBe("renewal_due");
    }
  });

  it("leaves a postpaid partner case's monthly rate alone", async () => {
    const { client, db } = makeClient(
      { ...CASE, aggregator_id: "agg-1", aggregator: { billing_method: "postpaid" } },
      STATEMENT,
    );
    await completeVoRenewal(client, { statementId: "stmt-1", source: "recorded_payment" });
    expect(db.cases[1]).toMatchObject({ end_date: "2027-12-18", rate: 18000, aggregator_id: "agg-1" });
  });

  it("takes the term length from the bill when Start renewal offered a different one", async () => {
    const { client, db } = makeClient(CASE, { ...STATEMENT, period_end: "2027-06-18", fixed_amount: 9900 });
    await completeVoRenewal(client, { statementId: "stmt-1", source: "razorpay_link" });
    expect(db.cases[1]).toMatchObject({
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
