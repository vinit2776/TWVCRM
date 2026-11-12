import { describe, it, expect } from "vitest";
import { modelAdditions, cleanItem } from "../supported-items";
import { draftSpecialClause, type ClauseContext } from "../ai";

const request =
  "The customer can use the Cabin 4 meeting room for 10 free hours each month. Unused hours are forfeited at month-end. Hours beyond 10 are charged at the standard meeting room rate.";

// The "Added by AI" lines the model produced on production for this very request.
const noisy = [
  "Any unused hours within the monthly allowance of ten (10) hours shall be forfeited at the end of each calendar month an…",
  "Forfeiture of unused hours is automatic at month-end with no carry-forward (not specified in request)",
  "Clause applies during 'the Term' — ties to contract term of 11 months (implicit but not stated in request)",
  "Members must book the room 48 hours in advance",
];

describe("cleanItem", () => {
  it("drops commentary in brackets and trailing fragments", () => {
    expect(cleanItem("No carry-forward (not specified in request)")).toBe("No carry-forward");
    expect(cleanItem("Any unused hours shall be forfeited at the end of each calendar month an…")).toBe("Any unused hours shall be forfeited at the end of each calendar month an");
  });
  it("shortens very long items", () => {
    expect(cleanItem("x".repeat(300)).length).toBeLessThanOrEqual(100);
  });
});

describe("modelAdditions", () => {
  it("drops restatements of what the author said and keeps genuinely new terms", () => {
    const out = modelAdditions(noisy, request);
    expect(out.some((t) => /forfeit/i.test(t))).toBe(false);
    expect(out.some((t) => /48 hours in advance/.test(t))).toBe(true);
  });
  it("strips commentary from what it keeps", () => {
    const out = modelAdditions(["Members must book 48 hours in advance (not in request)"], request);
    expect(out).toEqual(["Members must book 48 hours in advance"]);
  });
  it("de-duplicates near-identical items", () => {
    const out = modelAdditions(["Members must book 48 hours in advance", "Booking 48 hours in advance is required for members"], request);
    expect(out).toHaveLength(1);
  });
  it("returns nothing for an empty or fully supported list", () => {
    expect(modelAdditions([], request)).toEqual([]);
    expect(modelAdditions(["Unused hours are forfeited at month-end"], request)).toEqual([]);
  });
});

const context: ClauseContext = { clauseNumber: 37, facts: {}, fixedClauseTopics: ["fees"] };
const draftJson = (text: string, extra: object = {}) =>
  JSON.stringify({ questions: [], restated_intent: "r", clause_text: text, kept: ["10 hours"], added: [], ...extra });
const verdict = (extra: object = {}) =>
  JSON.stringify({ ok: true, problems: [], unlisted_additions: [], topics_checked: ["fees"], ...extra });

describe("report.added in the pipeline", () => {
  it("relaxed mode lists only real additions, not restatements", async () => {
    let n = 0;
    const r = await draftSpecialClause({ intent: request, reason: "t", context, relaxed: true }, async () => {
      n++;
      return n === 1 ? draftJson("37. X. The Member may use Cabin 4.", { added: noisy.slice(0, 3) }) : verdict({ unlisted_additions: [noisy[3]] });
    });
    if (r.status !== "drafted") throw new Error("expected drafted");
    expect(r.report.added).toEqual(["Members must book the room 48 hours in advance"]);
  });

  it("strict mode does not redraft because the model listed something the author already said", async () => {
    let n = 0;
    const r = await draftSpecialClause({ intent: request, reason: "t", context }, async () => {
      n++;
      return n === 1 ? draftJson("37. X. The Member may use Cabin 4.", { added: [noisy[1]] }) : verdict();
    });
    expect(n).toBe(2);
    expect(r.status).toBe("drafted");
  });
});

describe("routine wording", () => {
  it("never counts 'during the Term' style remarks as additions", () => {
    expect(modelAdditions(["Clause applies during 'the Term'", "Applies throughout the Term of the contract"], request)).toEqual([]);
  });
  it("still keeps a real new term that merely mentions the Term", () => {
    expect(modelAdditions(["Member must pay a ₹5,000 setup fee at signing"], request)).toHaveLength(1);
  });
});
