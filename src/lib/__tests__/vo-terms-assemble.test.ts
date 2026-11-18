import { describe, expect, it } from "vitest";
import {
  assembleVoTerms,
  composeSpecialClause,
  holdoverApprovedIn,
  parseTermsMode,
  type LibraryClause,
} from "@/lib/vo-terms-assemble";

const ALL = ["individual", "proprietorship", "partnership", "llp", "pvt_ltd", "public_ltd", "trust", "society", "huf", "other"];
const APPROVED = "2026-11-01T00:00:00Z";

function c(over: Partial<LibraryClause> & { code: string }): LibraryClause {
  return {
    id: `id-${over.code}`,
    clause_id: `cl-${over.code}`,
    version: 1,
    body: `Body ${over.code}.`,
    documents: ["proposal", "agreement", "renewal"],
    purposes: ["gst_new", "gst_existing"],
    company_types: ALL,
    min_term_months: null,
    is_current: true,
    approved_at: APPROVED,
    ...over,
  };
}

const base = {
  document: "proposal" as const,
  purpose: "gst_new",
  companyType: "pvt_ltd",
  termMonths: 12,
  billing: { kind: "direct" as const, name: "Acme Pvt Ltd" },
};

describe("parseTermsMode", () => {
  it("is off unless exactly on", () => {
    expect(parseTermsMode("on")).toBe("on");
    expect(parseTermsMode(" ON ")).toBe("on");
    for (const v of ["off", "", "true", null, undefined, 1]) expect(parseTermsMode(v)).toBe("off");
  });
});

describe("assembleVoTerms", () => {
  it("includes only approved clauses, in code order, and warns about unapproved ones", () => {
    const r = assembleVoTerms({
      ...base,
      clauses: [
        c({ code: "T10", body: "Ten." }),
        c({ code: "T02", body: "Two." }),
        c({ code: "T03", body: "Three.", approved_at: null, title: "Payment" }),
      ],
    });
    expect(r.clauses.map((x) => x.code)).toEqual(["T02", "T10"]);
    expect(r.text).toBe("Two.\n\nTen.");
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toMatchObject({ code: "T03", kind: "unapproved" });
    expect(r.warnings[0].message).toContain("Payment");
  });

  it("never includes an unapproved clause, even when it is the only one", () => {
    const r = assembleVoTerms({ ...base, clauses: [c({ code: "T01", approved_at: null })] });
    expect(r.clauses).toEqual([]);
    expect(r.text).toBe("");
    expect(r.snapshot.clauses).toEqual([]);
  });

  it("filters by document, company type, purpose and minimum term", () => {
    const r = assembleVoTerms({
      ...base,
      termMonths: 12,
      clauses: [
        c({ code: "T01", documents: ["renewal"] }),
        c({ code: "T05", company_types: ["pvt_ltd"] }),
        c({ code: "T06", company_types: ["llp"] }),
        c({ code: "T07", purposes: ["gst_existing"] }),
        c({ code: "T12", min_term_months: 24 }),
      ],
    });
    expect(r.clauses.map((x) => x.code)).toEqual(["T05"]);
    // Inapplicable clauses are not "missing", so no warning even if they were unapproved.
    expect(r.warnings).toEqual([]);
  });

  it("applies a minimum-term clause for multi-year terms", () => {
    const r = assembleVoTerms({ ...base, termMonths: 36, clauses: [c({ code: "T12", min_term_months: 24 })] });
    expect(r.clauses.map((x) => x.code)).toEqual(["T12"]);
  });

  it("renders term, fee, dates and party names", () => {
    const r = assembleVoTerms({
      ...base,
      document: "agreement",
      termMonths: 24,
      fee: 36000,
      startDate: "2026-12-01",
      endDate: "2028-11-30",
      customerName: "Acme Pvt Ltd",
      billing: { kind: "aggregator", name: "Partner Co" },
      clauses: [
        c({ code: "T03", body: "{customer_name} pays {fee} for {term} months from {start_date} to {end_date}, billed to {billed_party}." }),
      ],
    });
    expect(r.clauses[0].text).toBe(
      "Acme Pvt Ltd pays Rs. 36,000 for 24 months from 01 Dec 2026 to 30 Nov 2028, billed to Partner Co.",
    );
    expect(r.warnings).toEqual([]);
    expect(r.snapshot.billing_party).toBe("aggregator");
  });

  it("keeps an unfilled placeholder visible and warns", () => {
    const r = assembleVoTerms({ ...base, clauses: [c({ code: "T10", body: "Fee is {fee_rule}; due {end_date}; {bogus}" })] });
    expect(r.clauses[0].text).toBe("Fee is {fee_rule}; due {end_date}; {bogus}");
    const msgs = r.warnings.map((w) => w.message).join("|");
    expect(msgs).toContain("{fee_rule}");
    expect(msgs).toContain("{end_date}");
    expect(msgs).toContain("{bogus}");
  });

  it("maps the legacy purpose and warns on one with no library", () => {
    const legacy = assembleVoTerms({ ...base, purpose: "gst_registration", clauses: [c({ code: "T01" })] });
    expect(legacy.clauses).toHaveLength(1);
    const none = assembleVoTerms({ ...base, purpose: "mailing", clauses: [c({ code: "T01" })] });
    expect(none.clauses).toEqual([]);
    expect(none.warnings[0].kind).toBe("unmapped_purpose");
  });

  it("snapshots exact ids, versions and rendered text, unaffected by later edits", () => {
    const clauses = [c({ code: "T03", version: 3, body: "Pay for {term} months." })];
    const r = assembleVoTerms({ ...base, clauses });
    expect(r.snapshot.clauses).toEqual([
      { code: "T03", version: 3, version_id: "id-T03", clause_id: "cl-T03", text: "Pay for 12 months." },
    ]);
    clauses[0].body = "Edited later.";
    expect(r.snapshot.clauses[0].text).toBe("Pay for 12 months.");
  });

  it("ignores non-current versions", () => {
    const r = assembleVoTerms({ ...base, clauses: [c({ code: "T01", is_current: false })] });
    expect(r.clauses).toEqual([]);
    expect(r.warnings).toEqual([]);
  });
});

describe("composeSpecialClause", () => {
  it("returns the clause untouched when there are no terms (mode off)", () => {
    expect(composeSpecialClause("Special.", null)).toBe("Special.");
    expect(composeSpecialClause("Special.", "  ")).toBe("Special.");
    expect(composeSpecialClause(null, null)).toBeNull();
    expect(composeSpecialClause("", undefined)).toBeNull();
  });
  it("appends terms after the special clause", () => {
    expect(composeSpecialClause("Special.", "Terms.")).toBe("Special.\n\nTerms.");
    expect(composeSpecialClause(null, "Terms.")).toBe("Terms.");
  });
});

describe("holdoverApprovedIn", () => {
  it("needs T13 current and approved", () => {
    expect(holdoverApprovedIn([c({ code: "T13" })])).toBe(true);
    expect(holdoverApprovedIn([c({ code: "T13", approved_at: null })])).toBe(false);
    expect(holdoverApprovedIn([c({ code: "T13", is_current: false })])).toBe(false);
    expect(holdoverApprovedIn([c({ code: "T01" })])).toBe(false);
    expect(holdoverApprovedIn([])).toBe(false);
  });
});

describe("agreementClauseGate with library terms", () => {
  it("expects the clause followed by the frozen terms", async () => {
    const { agreementClauseGate } = await import("@/lib/special-clause/gate");
    const ok = agreementClauseGate({
      caseStatus: "approved", caseText: "Special.", agreementText: "Special.\n\nTerms.", termsText: "Terms.",
    });
    expect(ok.blocked).toBe(false);
    const noClause = agreementClauseGate({ caseStatus: null, caseText: null, agreementText: "Terms.", termsText: "Terms." });
    expect(noClause.blocked).toBe(false);
    const stale = agreementClauseGate({ caseStatus: "approved", caseText: "Special.", agreementText: "Special.", termsText: "Terms." });
    expect(stale.blocked).toBe(true);
  });
  it("is unchanged without terms", async () => {
    const { agreementClauseGate } = await import("@/lib/special-clause/gate");
    expect(agreementClauseGate({ caseStatus: "approved", caseText: "S.", agreementText: "S." }).blocked).toBe(false);
    expect(agreementClauseGate({ caseStatus: null, caseText: null, agreementText: null }).blocked).toBe(false);
  });
});
