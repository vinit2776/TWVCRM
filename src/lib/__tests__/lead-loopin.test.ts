import { describe, it, expect } from "vitest";
import { canBeKeptInformed, daysLeft, loopinExpiry, loopinProblem, watcherState, LOOPIN_DAYS } from "../lead-loopin";

const now = new Date("2026-11-23T10:00:00Z");

describe("canBeKeptInformed", () => {
  it("allows only roles that work leads", () => {
    const roles = ["admin", "manager", "sales_rep"];
    expect(canBeKeptInformed("manager", roles)).toBe(true);
    expect(canBeKeptInformed("floor_manager", roles)).toBe(false);
    expect(canBeKeptInformed(null, roles)).toBe(false);
  });
});

describe("loopinProblem", () => {
  const ok = { userIds: ["u2"], reason: "Needs the requirement before the tour", addedBy: "u1" };
  it("accepts a person and a reason", () => expect(loopinProblem(ok)).toBeNull());
  it("needs someone, a real reason, and not yourself", () => {
    expect(loopinProblem({ ...ok, userIds: [] })).toMatch(/at least one/);
    expect(loopinProblem({ ...ok, reason: "  " })).toMatch(/why/);
    expect(loopinProblem({ ...ok, reason: "ok" })).toMatch(/why/);
    expect(loopinProblem({ ...ok, userIds: ["u1"] })).toMatch(/yourself/);
  });
});

describe("expiry", () => {
  it("clears itself after 14 days", () => {
    const exp = loopinExpiry(now);
    expect(daysLeft(exp, now)).toBe(LOOPIN_DAYS);
    expect(watcherState({ answer: null, expires_at: exp }, now)).toBe("waiting");
    expect(watcherState({ answer: null, expires_at: exp }, new Date(now.getTime() + 14 * 86400000))).toBe("expired");
    expect(daysLeft(exp, new Date(now.getTime() + 20 * 86400000))).toBe(0);
  });
  it("an answer wins over expiry", () => {
    expect(watcherState({ answer: "got_it", expires_at: "2020-01-01T00:00:00Z" }, now)).toBe("got_it");
    expect(watcherState({ answer: "not_for_me", expires_at: "2020-01-01T00:00:00Z" }, now)).toBe("not_for_me");
  });
});
