import { describe, it, expect } from "vitest";
import { defaultProposal, followRevisions } from "../journey/pick-proposal";

const p = (id: string, status: string, superseded_by: string | null = null) => ({ id, status, superseded_by });

describe("followRevisions", () => {
  it("returns a live proposal unchanged", () => {
    const list = [p("b", "sent"), p("a", "draft")];
    expect(followRevisions(list, list[0])?.id).toBe("b");
  });

  it("follows a superseded proposal to its revision", () => {
    const list = [p("r2", "draft"), p("a", "superseded", "r2")];
    expect(followRevisions(list, list[1])?.id).toBe("r2");
  });

  it("follows a chain of revisions to the end", () => {
    const list = [p("r3", "sent"), p("r2", "superseded", "r3"), p("a", "superseded", "r2")];
    expect(followRevisions(list, list[2])?.id).toBe("r3");
  });

  it("stops on a broken chain instead of looping or crashing", () => {
    const list = [p("a", "superseded", "missing")];
    expect(followRevisions(list, list[0])?.id).toBe("a");
    const loop = [p("a", "superseded", "b"), p("b", "superseded", "a")];
    expect(followRevisions(loop, loop[0])).toBeDefined();
  });

  it("handles nothing requested", () => {
    expect(followRevisions([p("a", "sent")], undefined)).toBeUndefined();
  });
});

describe("defaultProposal", () => {
  it("prefers the newest live proposal and skips superseded ones", () => {
    const list = [p("r2", "draft"), p("a", "superseded", "r2")];
    expect(defaultProposal(list)?.id).toBe("r2");
  });

  it("falls back to a rejected proposal rather than a superseded one", () => {
    const list = [p("old", "superseded", "x"), p("rej", "rejected")];
    expect(defaultProposal(list)?.id).toBe("rej");
  });

  it("returns nothing when only superseded proposals exist", () => {
    expect(defaultProposal([p("a", "superseded", "gone")])).toBeUndefined();
  });
});
