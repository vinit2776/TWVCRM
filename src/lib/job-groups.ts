export interface JobRow {
  id: string;
  kind: string;
  title: string;
  status: "todo" | "in_progress" | "done";
  due_date: string | null;
  created_at: string;
  completed_at: string | null;
  completion_note: string | null;
  brief: { discussed?: string | null; proposal_kind?: string | null } | null;
  assigned_to: string | null;
  handed_over_by: string | null;
  assignee: { id: string; full_name: string } | null;
  giver: { id: string; full_name: string } | null;
  lead: { id: string; first_name: string | null; last_name: string | null } | null;
}

export interface JobGroups {
  /** Jobs for the signed-in person to do. */
  you: JobRow[];
  /** Jobs they handed to someone else that are not done. */
  waiting: JobRow[];
  /** Jobs they handed over that someone else finished lately. */
  done: JobRow[];
}

const DONE_VISIBLE_DAYS = 14;

/** Sorts the jobs involving one person into the three lists the Leads Home shows. */
export function groupJobs(jobs: JobRow[], meId: string, now: Date = new Date()): JobGroups {
  const cutoff = now.getTime() - DONE_VISIBLE_DAYS * 24 * 60 * 60 * 1000;
  const dueKey = (j: JobRow) => (j.due_date ? Date.parse(j.due_date) : Number.MAX_SAFE_INTEGER);
  const you = jobs
    .filter((j) => j.assigned_to === meId && j.status !== "done")
    .sort((a, b) => dueKey(a) - dueKey(b) || Date.parse(a.created_at) - Date.parse(b.created_at));
  const handedToOthers = jobs.filter((j) => j.handed_over_by === meId && j.assigned_to !== meId);
  const waiting = handedToOthers
    .filter((j) => j.status !== "done")
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  const done = handedToOthers
    .filter((j) => j.status === "done" && j.completed_at && Date.parse(j.completed_at) >= cutoff)
    .sort((a, b) => Date.parse(b.completed_at as string) - Date.parse(a.completed_at as string));
  return { you, waiting, done };
}
