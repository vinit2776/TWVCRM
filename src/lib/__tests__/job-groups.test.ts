import { describe, it, expect } from "vitest";
import { groupJobs, type JobRow } from "../job-groups";

const NOW = new Date("2026-11-20T10:00:00Z");
const base: JobRow = {
  id: "x", kind: "send_proposal", title: "t", status: "todo", due_date: null, created_at: "2026-11-18T10:00:00Z", completed_at: null,
  completion_note: null, brief: null, assigned_to: "me", handed_over_by: "other", assignee: null, giver: null, lead: null,
};
const job = (o: Partial<JobRow>): JobRow => ({ ...base, ...o });

describe("groupJobs", () => {
  it("puts jobs for me in You, soonest due first, undated last", () => {
    const g = groupJobs(
      [job({ id: "a", due_date: null }), job({ id: "b", due_date: "2026-11-22" }), job({ id: "c", due_date: "2026-11-21" }), job({ id: "d", status: "done" })],
      "me",
      NOW,
    );
    expect(g.you.map((j) => j.id)).toEqual(["c", "b", "a"]);
  });
  it("puts what I handed to others and is not done in Waiting, oldest first", () => {
    const g = groupJobs(
      [
        job({ id: "a", assigned_to: "p", handed_over_by: "me", created_at: "2026-11-19T10:00:00Z" }),
        job({ id: "b", assigned_to: "p", handed_over_by: "me", created_at: "2026-11-17T10:00:00Z" }),
        job({ id: "c", assigned_to: "me", handed_over_by: "me" }),
      ],
      "me",
      NOW,
    );
    expect(g.waiting.map((j) => j.id)).toEqual(["b", "a"]);
    expect(g.you.map((j) => j.id)).toEqual(["c"]);
  });
  it("shows Done by others for two weeks, newest first, and never my own done jobs", () => {
    const g = groupJobs(
      [
        job({ id: "new", assigned_to: "p", handed_over_by: "me", status: "done", completed_at: "2026-11-19T10:00:00Z" }),
        job({ id: "mid", assigned_to: "p", handed_over_by: "me", status: "done", completed_at: "2026-11-10T10:00:00Z" }),
        job({ id: "old", assigned_to: "p", handed_over_by: "me", status: "done", completed_at: "2026-11-01T10:00:00Z" }),
        job({ id: "mine", assigned_to: "me", handed_over_by: "me", status: "done", completed_at: "2026-11-19T10:00:00Z" }),
      ],
      "me",
      NOW,
    );
    expect(g.done.map((j) => j.id)).toEqual(["new", "mid"]);
  });
});
