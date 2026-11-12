import { describe, it, expect, beforeAll } from "vitest";
import { specialClauseGate, canApproveSpecialClause, canAuthorSpecialClause } from "../gate";
import { issueReviewToken, verifyReviewToken } from "../token";
import { stripClauseHeading } from "../membership";
import { draftSpecialClause, type ClauseContext } from "../ai";

const context: ClauseContext = { clauseNumber: 37, facts: { rent: "85000" }, fixedClauseTopics: ["termination"] };
const input = { intent: "10 free hours a month in Cabin 4", reason: "In lieu of rent discount", context };

describe("specialClauseGate", () => {
  it("lets contracts without a clause, or with an approved one, through", () => {
    expect(specialClauseGate(null).blocked).toBe(false);
    expect(specialClauseGate(undefined).blocked).toBe(false);
    expect(specialClauseGate("approved").blocked).toBe(false);
  });
  it("blocks pending and changes_requested, and says why", () => {
    const pending = specialClauseGate("pending_approval", "21 Oct");
    expect(pending.blocked).toBe(true);
    expect(pending.reason).toMatch(/awaiting approval.*21 Oct/);
    expect(specialClauseGate("changes_requested").reason).toMatch(/Revise and resubmit/);
  });
});

describe("roles", () => {
  it("only admin and manager approve; sales reps can author", () => {
    expect(canApproveSpecialClause("manager")).toBe(true);
    expect(canApproveSpecialClause("admin")).toBe(true);
    expect(canApproveSpecialClause("sales_rep")).toBe(false);
    expect(canApproveSpecialClause("accounts")).toBe(false);
    expect(canAuthorSpecialClause("sales_rep")).toBe(true);
    expect(canAuthorSpecialClause("fms")).toBe(false);
  });
});

describe("review token", () => {
  beforeAll(() => { process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key"; });
  it("verifies for the exact text and intent only", () => {
    const t = issueReviewToken("clause text here", "intent");
    expect(verifyReviewToken(t, "clause text here", "intent")).toBe(true);
    expect(verifyReviewToken(t, "clause text edited", "intent")).toBe(false);
    expect(verifyReviewToken(t, "clause text here", "other intent")).toBe(false);
    expect(verifyReviewToken(null, "clause text here", "intent")).toBe(false);
    expect(verifyReviewToken("a.b.c", "clause text here", "intent")).toBe(false);
  });
  it("expires after an hour", () => {
    const t = issueReviewToken("x", "y", 1_000_000);
    expect(verifyReviewToken(t, "x", "y", 1_000_000 + 59 * 60_000)).toBe(true);
    expect(verifyReviewToken(t, "x", "y", 1_000_000 + 61 * 60_000)).toBe(false);
  });
});

describe("stripClauseHeading", () => {
  it("drops the number and title the table prints separately", () => {
    expect(stripClauseHeading("37. Special Conditions. The Member shall…", 37)).toBe("The Member shall…");
    expect(stripClauseHeading("Clause 37 – Special Conditions: The Member shall…", 37)).toBe("The Member shall…");
    expect(stripClauseHeading("The Member shall…", 37)).toBe("The Member shall…");
  });
});

describe("draftSpecialClause", () => {
  const draftJson = (text: string, extra: object = {}) =>
    JSON.stringify({ questions: [], restated_intent: "r", clause_text: text, kept: ["10 hours"], added: [], ...extra });
  const verdict = (ok: boolean, problems: string[] = []) =>
    JSON.stringify({ ok, problems, unlisted_additions: [], topics_checked: ["termination"] });

  it("returns clarifying questions instead of guessing", async () => {
    const r = await draftSpecialClause(input, async () => JSON.stringify({ questions: ["Free or discounted?"], clause_text: "" }));
    expect(r).toEqual({ status: "questions", questions: ["Free or discounted?"] });
  });

  it("returns the draft when the reviewer passes it first time", async () => {
    const calls: string[] = [];
    const r = await draftSpecialClause(input, async (system) => {
      calls.push(system.slice(0, 12));
      return calls.length === 1 ? draftJson("37. Special Conditions. The Member…") : verdict(true);
    });
    expect(r.status).toBe("drafted");
    if (r.status === "drafted") expect(r.report.rounds).toBe(1);
  });

  it("feeds reviewer problems back and redrafts", async () => {
    let n = 0;
    const prompts: string[] = [];
    const r = await draftSpecialClause(input, async (_s, user) => {
      n++;
      prompts.push(user);
      if (n === 1) return draftJson("v1");
      if (n === 2) return verdict(false, ["says 12 hours, request said 10"]);
      if (n === 3) return draftJson("v2");
      return verdict(true);
    });
    expect(r.status).toBe("drafted");
    expect(prompts[2]).toContain("says 12 hours, request said 10");
    if (r.status === "drafted") { expect(r.clause_text).toBe("v2"); expect(r.report.rounds).toBe(2); }
  });

  it("redrafts without anything the reviewer says the author never asked for", async () => {
    let n = 0;
    const prompts: string[] = [];
    const r = await draftSpecialClause(input, async (_s, user) => {
      n++;
      prompts.push(user);
      if (n === 1) return draftJson("v1 with booking rule");
      if (n === 2) return JSON.stringify({ ok: true, problems: [], unlisted_additions: ["advance booking"], topics_checked: [] });
      if (n === 3) return draftJson("v2");
      return verdict(true);
    });
    expect(prompts[2]).toContain('Remove "advance booking"');
    expect(r.status).toBe("drafted");
    if (r.status === "drafted") { expect(r.clause_text).toBe("v2"); expect(r.report.added).toEqual([]); }
  });

  it("redrafts, without a review, when the draft admits to adding something", async () => {
    let n = 0;
    const roles: string[] = [];
    const r = await draftSpecialClause(input, async (system) => {
      n++;
      roles.push(system.startsWith("You draft") ? "draft" : "verify");
      if (n === 1) return draftJson("v1", { added: ["no carry-forward"] });
      if (n === 2) return draftJson("v2");
      return verdict(true);
    });
    expect(roles).toEqual(["draft", "draft", "verify"]);
    expect(r.status).toBe("drafted");
  });

  it("turns additions that survive every round into questions for the author", async () => {
    const r = await draftSpecialClause(input, async (system) =>
      system.startsWith("You draft") ? draftJson("sticky", { added: ["no carry-forward"] }) : verdict(true));
    expect(r).toEqual({ status: "questions", questions: ["Should the clause also say: no carry-forward?"] });
  });

  it("keeps the report short however chatty the model is", async () => {
    const long = "x".repeat(300);
    let n = 0;
    const r = await draftSpecialClause(input, async () => {
      n++;
      return n === 1
        ? draftJson("v1", { kept: Array.from({ length: 9 }, (_, i) => `${i}${long}`) })
        : JSON.stringify({ ok: true, problems: [], unlisted_additions: [], topics_checked: Array.from({ length: 12 }, () => long) });
    });
    if (r.status !== "drafted") throw new Error("expected drafted");
    expect(r.report.kept).toHaveLength(5);
    expect(r.report.topics_checked).toHaveLength(6);
    expect(Math.max(...r.report.kept.map((t) => t.length))).toBeLessThanOrEqual(120);
  });

  it("gives up after three failed rounds rather than returning unvetted text", async () => {
    let n = 0;
    const r = await draftSpecialClause(input, async () => (++n % 2 === 1 ? draftJson("bad") : verdict(false, ["wrong meaning"])));
    expect(r).toEqual({ status: "failed", problems: ["wrong meaning"] });
    expect(n).toBe(6);
  });

  it("fails closed on malformed model output", async () => {
    await expect(draftSpecialClause(input, async () => "not json")).rejects.toThrow();
  });
});
