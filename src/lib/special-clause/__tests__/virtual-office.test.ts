import { describe, it, expect } from "vitest";
import { agreementClauseGate } from "../gate";
import { stripSpecialConditionsHeading } from "../membership";
import { draftSpecialClause } from "../ai";
import { mergeLeaveLicenseVariables, generateLeaveLicensePdf } from "@/lib/leave-license-generator";
import { mergeVariables, generateAgreementPdf } from "@/lib/agreement-generator";

const clause = "Special Conditions. The Licensee may collect mail from the Premises on Saturdays by prior appointment.";

describe("agreementClauseGate", () => {
  const ok = { caseStatus: "approved", caseText: clause, agreementText: clause };
  it("lets agreements through when there is no clause on either side", () => {
    expect(agreementClauseGate({ caseStatus: null, caseText: null, agreementText: null }).blocked).toBe(false);
  });
  it("passes when the stored copy carries exactly the approved text (whitespace aside)", () => {
    expect(agreementClauseGate(ok).blocked).toBe(false);
    expect(agreementClauseGate({ ...ok, agreementText: `  ${clause.replace(/ /g, "  ")} ` }).blocked).toBe(false);
  });
  it("blocks unapproved clauses regardless of the PDF", () => {
    expect(agreementClauseGate({ ...ok, caseStatus: "pending_approval" }).blocked).toBe(true);
    expect(agreementClauseGate({ ...ok, caseStatus: "changes_requested" }).blocked).toBe(true);
  });
  it("blocks a stale PDF: approved clause missing, or a withdrawn clause still printed", () => {
    expect(agreementClauseGate({ ...ok, agreementText: null }).reason).toMatch(/doesn't match/);
    expect(agreementClauseGate({ caseStatus: null, caseText: null, agreementText: clause }).blocked).toBe(true);
    expect(agreementClauseGate({ ...ok, agreementText: "an older wording" }).blocked).toBe(true);
  });
});

describe("stripSpecialConditionsHeading", () => {
  it("removes any number and title lead-in, leaves plain text alone", () => {
    expect(stripSpecialConditionsHeading("11. Special Conditions. The Licensee…")).toBe("The Licensee…");
    expect(stripSpecialConditionsHeading("Special Conditions: The Licensee…")).toBe("The Licensee…");
    expect(stripSpecialConditionsHeading("The Licensee…")).toBe("The Licensee…");
  });
});

describe("virtual office drafting", () => {
  it("tells the model not to number the clause", async () => {
    const prompts: string[] = [];
    await draftSpecialClause(
      { intent: "Mail collection on Saturdays", reason: "Customer works weekdays", context: { clauseNumber: null, facts: {}, fixedClauseTopics: ["mail handling"] } },
      async (_s, user) => { prompts.push(user); return JSON.stringify({ questions: ["Which Saturdays?"], clause_text: "" }); },
    );
    expect(prompts[0]).toContain("none (do not number or title the clause)");
  });
});

const llParams = {
  agreementNumber: "TWV-VO-1", agreementDate: "2026-10-21", clientName: "A Person", clientCompanyName: "Acme Pvt Ltd",
  clientEntityType: "pvt_ltd" as const, clientAddress: "1 Road, Chennai", locationName: "Test", locationAddress: "Chennai",
  purpose: "gst_registration" as const, rate: 10000, tenureMonths: 12, startDate: "2026-11-01", securityDeposit: 0,
};

describe("virtual office agreement PDFs", () => {
  it("L&L prints an approved clause as clause 11 and nothing when absent", () => {
    const base = mergeLeaveLicenseVariables(llParams);
    const withClause = generateLeaveLicensePdf({ ...base, special_clause_text: clause }).output();
    expect(withClause).toContain("11. SPECIAL CONDITIONS");
    expect(withClause).toContain("Saturdays");
    expect(generateLeaveLicensePdf(base).output()).not.toContain("SPECIAL CONDITIONS");
  });

  it("proposal prints the clause before the signatures and nothing when absent", () => {
    const base = mergeVariables(llParams);
    const withClause = generateAgreementPdf("vo_gst_registration", { ...base, special_clause_text: clause }).output();
    expect(withClause).toContain("SPECIAL CONDITIONS:");
    expect(withClause).toContain("Saturdays");
    expect(generateAgreementPdf("vo_gst_registration", base).output()).not.toContain("SPECIAL CONDITIONS");
  });
});
