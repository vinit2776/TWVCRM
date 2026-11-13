import { describe, expect, it } from "vitest";
import {
  assembleTerms,
  diffSnapshots,
  fillPlaceholders,
  isApproved,
  type VoClauseVersion,
} from "@/lib/vo-terms";

const ALL = ["individual", "proprietorship", "partnership", "llp", "pvt_ltd", "public_ltd", "trust", "society", "huf", "other"];

function clause(over: Partial<VoClauseVersion> & { code: string }): VoClauseVersion {
  return {
    version: 1,
    body: "Body.",
    documents: ["proposal", "agreement", "renewal"],
    purposes: ["gst_new", "gst_existing"],
    company_types: ALL,
    min_term_months: null,
    is_current: true,
    approved_at: null,
    ...over,
  };
}

const base = { document: "proposal", purpose: "gst_new", companyType: "pvt_ltd", termMonths: 12, values: {} };

describe("fillPlaceholders", () => {
  it("fills known placeholders", () => {
    expect(fillPlaceholders("{term} months at {fee_rule}", { term: 12, fee_rule: "the same fee" })).toEqual({
      text: "12 months at the same fee",
      errors: [],
    });
  });

  it("reports an unknown placeholder and keeps it visible", () => {
    const r = fillPlaceholders("Pay {amount} now", { term: 12 });
    expect(r.text).toBe("Pay {amount} now");
    expect(r.errors).toEqual(["Unknown placeholder {amount}"]);
  });

  it("reports an unfilled placeholder instead of blanking it", () => {
    for (const values of [{}, { fee_rule: null }, { fee_rule: "  " }]) {
      const r = fillPlaceholders("Fee is {fee_rule}", values);
      expect(r.text).toBe("Fee is {fee_rule}");
      expect(r.errors).toEqual(["No value for placeholder {fee_rule}"]);
    }
  });
});

describe("isApproved", () => {
  it("is true only when approved_at is set", () => {
    expect(isApproved({ approved_at: "2026-01-01T00:00:00Z" })).toBe(true);
    expect(isApproved({ approved_at: null })).toBe(false);
    expect(isApproved({})).toBe(false);
  });
});

describe("assembleTerms", () => {
  it("filters by document", () => {
    const clauses = [clause({ code: "T01", documents: ["proposal"] }), clause({ code: "T10", documents: ["renewal"] })];
    expect(assembleTerms({ ...base, clauses }).lines.map((l) => l.code)).toEqual(["T01"]);
    expect(assembleTerms({ ...base, document: "renewal", clauses }).lines.map((l) => l.code)).toEqual(["T10"]);
  });

  it("filters by purpose; a clause with both purposes applies to either", () => {
    const clauses = [
      clause({ code: "T05", purposes: ["gst_new"] }),
      clause({ code: "T07", purposes: ["gst_existing"] }),
      clause({ code: "T08" }),
    ];
    expect(assembleTerms({ ...base, clauses }).lines.map((l) => l.code)).toEqual(["T05", "T08"]);
    expect(assembleTerms({ ...base, purpose: "gst_existing", clauses }).lines.map((l) => l.code)).toEqual(["T07", "T08"]);
  });

  it("filters by company type", () => {
    const clauses = [
      clause({ code: "T05", company_types: ["pvt_ltd", "public_ltd"] }),
      clause({ code: "T06", company_types: ["llp"] }),
    ];
    expect(assembleTerms({ ...base, clauses }).lines.map((l) => l.code)).toEqual(["T05"]);
    expect(assembleTerms({ ...base, companyType: "llp", clauses }).lines.map((l) => l.code)).toEqual(["T06"]);
  });

  it("shows a 24+ month clause only at 24, 36 and 48 months", () => {
    const clauses = [clause({ code: "T12", min_term_months: 24 })];
    for (const m of [6, 11, 12, 23]) expect(assembleTerms({ ...base, termMonths: m, clauses }).lines).toHaveLength(0);
    for (const m of [24, 36, 48]) expect(assembleTerms({ ...base, termMonths: m, clauses }).lines).toHaveLength(1);
  });

  it("ignores non-current versions", () => {
    const clauses = [clause({ code: "T01", version: 1, is_current: false }), clause({ code: "T01", version: 2 })];
    const r = assembleTerms({ ...base, clauses });
    expect(r.snapshot).toEqual([{ code: "T01", version: 2 }]);
    expect(r.excluded).toBe(0);
  });

  it("orders by code and counts excluded clauses", () => {
    const clauses = [
      clause({ code: "T10" }),
      clause({ code: "T02" }),
      clause({ code: "T09", documents: ["renewal"] }),
    ];
    const r = assembleTerms({ ...base, clauses });
    expect(r.lines.map((l) => l.code)).toEqual(["T02", "T10"]);
    expect(r.excluded).toBe(1);
  });

  it("fills the term from termMonths and flags a missing fee rule", () => {
    const clauses = [clause({ code: "T10", body: "Fee {fee_rule} for {term} months." })];
    const bad = assembleTerms({ ...base, termMonths: 24, clauses });
    expect(bad.errors).toEqual(["T10: No value for placeholder {fee_rule}"]);
    const ok = assembleTerms({ ...base, termMonths: 24, clauses, values: { fee_rule: "unchanged" } });
    expect(ok.errors).toEqual([]);
    expect(ok.lines[0].text).toBe("Fee unchanged for 24 months.");
  });

  it("reports an unknown placeholder with the clause code", () => {
    const r = assembleTerms({ ...base, clauses: [clause({ code: "T03", body: "{oops}" })] });
    expect(r.errors).toEqual(["T03: Unknown placeholder {oops}"]);
  });
});

describe("diffSnapshots", () => {
  it("finds changed, added and removed codes", () => {
    const a = [{ code: "T01", version: 1 }, { code: "T02", version: 1 }, { code: "T03", version: 1 }];
    const b = [{ code: "T01", version: 1 }, { code: "T02", version: 2 }, { code: "T04", version: 1 }];
    expect(diffSnapshots(a, b)).toEqual({ changed: ["T02"], added: ["T04"], removed: ["T03"] });
  });

  it("is empty for identical snapshots", () => {
    const a = [{ code: "T01", version: 1 }];
    expect(diffSnapshots(a, [...a])).toEqual({ changed: [], added: [], removed: [] });
  });
});
