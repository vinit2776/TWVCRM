import { describe, expect, it } from "vitest";
import {
  buildNocLetter, canIssueNoc, canOrderNoc, canOrderOnContract, computeFee, dotDate, isNocExpired, isVoidable,
  nocLetterText, nocMarkers, nocReference, nocValidUntil, NOC_CLAUSES, validateOrder, type NocLetterInput,
} from "../rules";

const base: NocLetterInput = {
  purpose: "roc", companyName: "ANIQA GLITZ PRIVATE LIMITED", address: "Kamala Arcade, Anna Salai, Chennai 600006",
  agreementDate: "2026-08-13", endDate: "2027-08-31", tenureMonths: 12,
  signatoryName: "Naval Chordia", signatoryDesignation: "Director",
};

describe("the NOC letter", () => {
  it("names only its own purpose, never both", () => {
    const roc = nocLetterText(buildNocLetter({ ...base, purpose: "roc" }));
    const gst = nocLetterText(buildNocLetter({ ...base, purpose: "gst" }));
    expect(roc).toContain("ROC Registration");
    expect(roc).not.toMatch(/GST/i);
    expect(gst).toContain("GST Registration");
    expect(gst).not.toMatch(/ROC/i);
  });

  it("prints the purpose in the subject and the consent line, and nowhere else", () => {
    const text = nocLetterText(buildNocLetter({ ...base, purpose: "gst" }));
    expect(text.match(/GST Registration/g)).toHaveLength(2);
  });

  it("fills the dates, company and period from the contract in the template's format", () => {
    const l = buildNocLetter(base);
    expect(l.agreementLine).toContain("agreement on 13.08.2026 with ANIQA GLITZ PRIVATE LIMITED");
    expect(l.agreementLine).toContain("for the period of 12 months ending at 31.08.2027");
    expect(l.consentLine).toContain("for ANIQA GLITZ PRIVATE LIMITED.");
  });

  it("prints the address twice, as the template does", () => {
    const text = nocLetterText(buildNocLetter(base));
    expect(text.match(/Kamala Arcade, Anna Salai, Chennai 600006/g)).toHaveLength(2);
  });

  it("carries the three approved paragraphs word for word", () => {
    const text = nocLetterText(buildNocLetter(base));
    for (const c of NOC_CLAUSES) expect(text).toContain(c);
    expect(NOC_CLAUSES).toHaveLength(3);
    expect(NOC_CLAUSES[2]).toContain("immediately pursuant to the expiry or termination of the agreement");
  });

  it("does not mention address proof: it is not part of the certificate for now", () => {
    expect(nocLetterText(buildNocLetter(base))).not.toMatch(/address proof/i);
  });

  it("leaves the date as a placeholder on a draft and prints it once issued", () => {
    expect(buildNocLetter(base).signature.find((s) => s.label === "Date:")?.value).toBe("[on issue]");
    expect(buildNocLetter({ ...base, issueDate: "2026-11-24" }).signature.find((s) => s.label === "Date:")?.value).toBe("24.11.2026");
  });

  it("uses a plain phrase when the tenure is unknown", () => {
    expect(buildNocLetter({ ...base, tenureMonths: null }).agreementLine).toContain("for the period of the agreed period ending at");
  });

  it("formats dates dd.mm.yyyy", () => {
    expect(dotDate("2026-09-06")).toBe("06.09.2026");
    expect(dotDate(null)).toBe("[date]");
  });
});

describe("fee", () => {
  it("adds GST to the fee", () => {
    expect(computeFee(20000, 18)).toEqual({ excludingGst: 20000, tax: 3600, total: 23600 });
  });
});

describe("validity", () => {
  it("is the contract's end date, so an extension lengthens it", () => {
    expect(nocValidUntil("2027-08-31")).toBe("2027-08-31");
    expect(isNocExpired("2027-08-31", "2027-08-31")).toBe(false);
    expect(isNocExpired("2027-08-31", "2027-09-01")).toBe(true);
  });

  it("is never carried into a renewal: a new contract has no NOC, so no marker", () => {
    expect(nocMarkers([], "2028-08-31", "2027-10-01")).toEqual([]);
  });
});

describe("markers", () => {
  it("shows an issued NOC, including one issued after the agreement started", () => {
    const m = nocMarkers([{ status: "issued", purpose: "roc", locationName: "Perungudi" }], "2027-08-31", "2026-11-24");
    expect(m).toEqual([{ tone: "issued", text: "NOC issued · ROC · Perungudi" }]);
  });

  it("shows an ordered but unissued NOC calmly, so nobody assumes it is done", () => {
    const m = nocMarkers([{ status: "sent", purpose: "gst", locationName: "Guindy" }], "2027-08-31", "2026-11-24");
    expect(m[0].tone).toBe("pending");
    expect(m[0].text).toContain("not issued");
  });

  it("shows nothing for a void order, and expires with the contract", () => {
    expect(nocMarkers([{ status: "void", purpose: "roc" }], "2027-08-31", "2026-11-24")).toEqual([]);
    expect(nocMarkers([{ status: "issued", purpose: "roc" }], "2027-08-31", "2027-09-02")[0].tone).toBe("expired");
    expect(nocMarkers([{ status: "draft", purpose: "roc" }], "2027-08-31", "2027-09-02")).toEqual([]);
  });
});

describe("who and when", () => {
  it("lets admin, manager and sales rep order, and only admin and manager issue", () => {
    for (const r of ["admin", "manager", "sales_rep"]) expect(canOrderNoc(r)).toBe(true);
    for (const r of ["accounts", "fms", "coordinator", null]) expect(canOrderNoc(r as string | null)).toBe(false);
    expect(canIssueNoc("sales_rep")).toBe(false);
    expect(canIssueNoc("manager")).toBe(true);
  });

  it("voids only before payment", () => {
    expect(isVoidable("draft")).toBe(true);
    expect(isVoidable("accepted")).toBe(true);
    expect(isVoidable("paid")).toBe(false);
    expect(isVoidable("issued")).toBe(false);
  });

  it("NEVER blocks a contract from activating: ordering is allowed on a not-yet-active contract, and nothing here gates status", () => {
    for (const s of ["sent", "viewed", "accepted", "active", "renewal_in_progress"]) expect(canOrderOnContract(s)).toBe(true);
    for (const s of ["draft", "terminated", "expired", "rejected"]) expect(canOrderOnContract(s)).toBe(false);
  });

  it("builds the reference", () => {
    expect(nocReference("TWV-C-0125", 1)).toBe("TWV-C-0125/NOC-1");
  });
});

describe("order validation", () => {
  const ok = { purpose: "roc", locationId: "loc-1", companyName: "ANIQA GLITZ PRIVATE LIMITED" };
  it("accepts a complete order", () => expect(validateOrder(ok)).toEqual([]));
  it("requires purpose, centre and name", () => {
    expect(validateOrder({}).length).toBe(3);
    expect(validateOrder({ ...ok, purpose: "both" })[0]).toContain("ROC registration or GST registration");
  });
  it("checks the CIN shape but allows it blank", () => {
    expect(validateOrder({ ...ok, cin: "" })).toEqual([]);
    expect(validateOrder({ ...ok, cin: "U45400TN1987PTC014408" })).toEqual([]);
    expect(validateOrder({ ...ok, cin: "12345" })[0]).toContain("CIN");
  });
});
