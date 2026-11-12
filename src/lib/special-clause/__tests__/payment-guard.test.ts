import { describe, it, expect } from "vitest";
import { unsupportedTerms } from "../unsupported-terms";
import { draftSpecialClause, type ClauseContext } from "../ai";

const context: ClauseContext = { clauseNumber: 37, facts: {}, fixedClauseTopics: ["fees"] };
const request =
  "The customer can use the Cabin 4 meeting room for 10 free hours each month.\n\nClarifications: Unused hours are forfeited at month-end. Hours beyond 10 are charged at the standard meeting room rate.";

// The real production draft that slipped past the model reviewer.
const slipped =
  "37. Meeting Room Allocation. During the Term, the Member shall be entitled to use Cabin 4 meeting room for ten (10) hours in each calendar month at no charge to the Member. Any use in excess of ten (10) hours in a calendar month shall be charged at the Company's standard meeting room hire rate applicable from time to time, to be billed separately and paid within the time prescribed for membership fees.";

describe("unsupportedTerms", () => {
  it("flags billing and payment-timing wording the author never used", () => {
    const out = unsupportedTerms(slipped, request);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("billed separately");
  });

  it("lets through wording the request itself used", () => {
    expect(unsupportedTerms("Hours beyond ten shall be billed monthly.", "Hours beyond 10 are billed monthly.")).toEqual([]);
    expect(unsupportedTerms("Charges are payable within 7 days.", "Pay within 7 days of the invoice.")).toEqual([]);
  });

  it("treats paid, payable and payment as the same idea", () => {
    expect(unsupportedTerms("The fee is payable monthly.", "They will make a payment each month.")).toEqual([]);
  });

  it("ignores clauses with no payment or timing words", () => {
    expect(unsupportedTerms("The Member may use Cabin 4 for ten hours each month.", "10 hours a month in Cabin 4")).toEqual([]);
  });

  it("flags booking-in-advance and notice terms", () => {
    expect(unsupportedTerms("The Member shall book in advance, giving prior notice.", "10 hours a month").length).toBeGreaterThan(0);
  });
});

const draftJson = (text: string, extra: object = {}) =>
  JSON.stringify({ questions: [], restated_intent: "r", clause_text: text, kept: ["10 hours"], added: [], ...extra });
const verdict = (extra: object = {}) =>
  JSON.stringify({ ok: true, problems: [], unlisted_additions: [], topics_checked: ["fees"], ...extra });

describe("strict mode catches what the reviewer missed", () => {
  it("redrafts when the guard finds a payment term even though the reviewer approved", async () => {
    let n = 0;
    const prompts: string[] = [];
    const r = await draftSpecialClause({ intent: request, reason: "test", context }, async (_s, user) => {
      n++;
      prompts.push(user);
      if (n === 1) return draftJson(slipped);
      if (n === 2) return draftJson("37. Meeting Room Allocation. The Member may use Cabin 4 for ten (10) hours each calendar month at no charge.");
      return verdict();
    });
    expect(prompts[1]).toContain("billed separately");
    expect(r.status).toBe("drafted");
    if (r.status === "drafted") expect(r.clause_text).not.toContain("billed");
  });
});

describe("relaxed mode (author skipped the questions)", () => {
  it("does not return questions; drafts and discloses additions to the approver", async () => {
    const systems: string[] = [];
    let n = 0;
    const r = await draftSpecialClause({ intent: "10 free hours a month in Cabin 4", reason: "test", context, relaxed: true }, async (system) => {
      systems.push(system);
      n++;
      if (n === 1) return draftJson(slipped, { added: ["no carry-forward"] });
      return verdict({ unlisted_additions: ["advance booking"] });
    });
    expect(systems[0]).toContain("RELAXED MODE");
    expect(systems[1]).toContain("RELAXED MODE");
    expect(r.status).toBe("drafted");
    if (r.status !== "drafted") throw new Error("expected drafted");
    expect(r.clause_text).toBe(slipped);
    expect(r.report.relaxed).toBe(true);
    expect(r.report.added).toEqual(expect.arrayContaining(["no carry-forward", "advance booking"]));
    expect(r.report.added.some((a) => a.includes("billed separately"))).toBe(true);
  });

  it("pushes the model to draft if it still asks questions", async () => {
    let n = 0;
    const prompts: string[] = [];
    const r = await draftSpecialClause({ intent: "10 free hours a month in Cabin 4", reason: "test", context, relaxed: true }, async (_s, user) => {
      n++;
      prompts.push(user);
      if (n === 1) return JSON.stringify({ questions: ["Carry forward?"], clause_text: "" });
      if (n === 2) return draftJson("37. Meeting Room Allocation. The Member may use Cabin 4 for ten (10) hours each calendar month.");
      return verdict();
    });
    expect(prompts[1]).toContain("Do not ask questions");
    expect(r.status).toBe("drafted");
  });

  it("still enforces meaning: a reviewer problem triggers a redraft", async () => {
    let n = 0;
    const r = await draftSpecialClause({ intent: "10 free hours a month in Cabin 4", reason: "test", context, relaxed: true }, async () => {
      n++;
      if (n === 1) return draftJson("v1");
      if (n === 2) return verdict({ ok: false, problems: ["says 12 hours"] });
      if (n === 3) return draftJson("v2");
      return verdict();
    });
    expect(r.status).toBe("drafted");
    if (r.status === "drafted") expect(r.clause_text).toBe("v2");
  });
});
