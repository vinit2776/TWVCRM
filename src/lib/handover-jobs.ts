/** The kinds of hand-over job, and the plain rules about who may do what with one. */
export const JOB_KINDS = ["call_back", "book_tour", "send_proposal", "other"] as const;
export type JobKind = (typeof JOB_KINDS)[number];

export const JOB_KIND_LABELS: Record<JobKind, string> = {
  call_back: "Call back",
  book_tour: "Book a tour",
  send_proposal: "Send a proposal",
  other: "Something else",
};

/** What the giver tells the person doing the job. The lead itself is read live, not copied here. */
export interface JobBrief {
  /** What was discussed with the customer. */
  discussed?: string;
  /** What kind of proposal, for a send-a-proposal job. */
  proposal_kind?: string;
}

export function defaultJobTitle(kind: JobKind, leadName: string): string {
  const who = leadName.trim() || "the customer";
  switch (kind) {
    case "call_back":
      return `Call back ${who}`;
    case "book_tour":
      return `Book a tour for ${who}`;
    case "send_proposal":
      return `Send a proposal to ${who}`;
    case "other":
      return `Follow up with ${who}`;
  }
}

interface JobLike {
  kind: string;
  assigned_to: string | null;
  handed_over_by: string | null;
}

const isJob = (t: JobLike) => t.kind !== "general";

/** Only the person a job was handed to finishes it (an admin can too, to unblock a stuck one). */
export function canCompleteJob(task: JobLike, userId: string | null, role: string | null): boolean {
  if (!isJob(task)) return true;
  return !!userId && (task.assigned_to === userId || role === "admin");
}

/** Only the person who handed a job over changes its brief, title, assignee or removes it (an admin can too). */
export function canEditJob(task: JobLike, userId: string | null, role: string | null): boolean {
  if (!isJob(task)) return true;
  return !!userId && (task.handed_over_by === userId || role === "admin");
}
