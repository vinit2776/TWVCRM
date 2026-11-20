import { describe, it, expect } from "vitest";
import {
  FADE_AFTER_COMPLETIONS,
  guidanceDetail,
  isGuidanceKey,
  progressKeyFor,
  renewalWalkthrough,
  shortHintFor,
  WALKTHROUGH_KEY,
} from "@/lib/vo-renewal-learning";

const done = (n: number, last = "2026-11-01T10:00:00Z", blocked: string | null = null) => ({
  times_completed: n,
  last_completed_at: last,
  last_blocked_at: blocked,
});

describe("guidanceDetail", () => {
  it("is long for someone who has never done the step", () => {
    expect(guidanceDetail(null)).toBe("long");
    expect(guidanceDetail(undefined)).toBe("long");
  });

  it("stays long until the step has been completed enough times", () => {
    expect(guidanceDetail(done(FADE_AFTER_COMPLETIONS - 1))).toBe("long");
    expect(guidanceDetail(done(FADE_AFTER_COMPLETIONS))).toBe("short");
  });

  it("comes back long after a blocked attempt since the last completion", () => {
    expect(guidanceDetail(done(5, "2026-11-01T10:00:00Z", "2026-11-02T09:00:00Z"))).toBe("long");
  });

  it("goes short again once the step is completed after being blocked", () => {
    expect(guidanceDetail(done(6, "2026-11-03T10:00:00Z", "2026-11-02T09:00:00Z"))).toBe("short");
  });

  it("is long when blocked and never completed", () => {
    expect(guidanceDetail({ times_completed: 3, last_completed_at: null, last_blocked_at: "2026-11-02T09:00:00Z" })).toBe("long");
  });
});

describe("progress keys", () => {
  it("accepts only the steps and the walkthrough", () => {
    expect(isGuidanceKey(progressKeyFor("start"))).toBe(true);
    expect(isGuidanceKey(progressKeyFor("lapse"))).toBe(true);
    expect(isGuidanceKey(WALKTHROUGH_KEY)).toBe(true);
    expect(isGuidanceKey("renewal.pay")).toBe(false);
    expect(isGuidanceKey("anything")).toBe(false);
  });

  it("has a short version for each step that fades, and none for others", () => {
    for (const s of ["start", "partner", "lapse"]) expect(shortHintFor(s)).toBeTruthy();
    expect(shortHintFor("pay")).toBeUndefined();
  });
});

describe("renewalWalkthrough", () => {
  it("has five steps for every role", () => {
    for (const role of ["sales_rep", "accounts", "admin", "floor_manager", null]) {
      expect(renewalWalkthrough(role)).toHaveLength(5);
    }
  });

  it("tailors the lines to the role", () => {
    expect(renewalWalkthrough("accounts")[3].forYou).toBe("Verifying and recording is yours.");
    expect(renewalWalkthrough("sales_rep")[3].forYou).toContain("Waiting on accounts");
    expect(renewalWalkthrough("sales_rep")[1].forYou).toContain("your step");
    expect(renewalWalkthrough("floor_manager")[1].forYou).toBeUndefined();
  });
});
