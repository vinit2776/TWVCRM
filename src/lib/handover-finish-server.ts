import type { SupabaseClient } from "@supabase/supabase-js";
import { logAudit } from "@/lib/audit";
import { createNotification } from "@/lib/in-app-notifications";
import { CALL_OUTCOME_LABELS } from "@/lib/constants";
import { jobKindForActivity } from "@/lib/handover-jobs";

export interface FinishableJob {
  id: string;
  title: string;
  handed_over_by: string | null;
}

/**
 * Marks hand-over jobs done by the system, with a note saying what finished them, an audit entry and
 * a message to whoever handed the job over. The update only touches a job that is not already done,
 * so two things finishing the same job at once cannot write it twice.
 */
export async function finishHandoverJobs(
  admin: SupabaseClient,
  jobs: FinishableJob[],
  actorId: string | null,
  note: string,
  notice: string,
): Promise<number> {
  const now = new Date().toISOString();
  let finished = 0;
  for (const job of jobs) {
    const { data, error } = await admin
      .from("tasks")
      .update({ status: "done", completed_at: now, completion_note: note })
      .eq("id", job.id)
      .neq("status", "done")
      .select("id");
    if (error) {
      console.error("[handover] could not finish the job:", error.message);
      continue;
    }
    if (!data || data.length === 0) continue;
    finished += 1;
    if (actorId) {
      logAudit(admin, {
        entityType: "task",
        entityId: job.id,
        action: "update",
        performedBy: actorId,
        changes: { status: { old: "todo", new: "done" } },
      });
    }
    if (job.handed_over_by && job.handed_over_by !== actorId) {
      await createNotification({
        userId: job.handed_over_by,
        type: "handover_job",
        title: job.title,
        body: notice,
        url: "/leads?view=home",
        entityType: "task",
        entityId: job.id,
      }).catch(() => {});
    }
  }
  return finished;
}

/**
 * A call logged on a lead finishes the "call back" jobs handed to the person who logged it, and a
 * tour booked finishes their "book a tour" jobs. Only the job's own assignee, on its own lead, and
 * only jobs created before the activity, so someone else's call or an older log never finishes it.
 * Any call counts, including "no answer": the job was done, and the note says how it went.
 */
export async function completeHandoverJobsForActivity(
  admin: SupabaseClient,
  params: {
    leadId: string;
    userId: string;
    activityType: string;
    callOutcome?: string | null;
    activityCreatedAt: string;
  },
): Promise<number> {
  const kind = jobKindForActivity(params.activityType);
  if (!kind) return 0;

  const { data: jobs } = await admin
    .from("tasks")
    .select("id, title, handed_over_by")
    .eq("lead_id", params.leadId)
    .eq("kind", kind)
    .eq("assigned_to", params.userId)
    .neq("status", "done")
    .lte("created_at", params.activityCreatedAt);
  if (!jobs || jobs.length === 0) return 0;

  const outcome = params.callOutcome ? CALL_OUTCOME_LABELS[params.callOutcome] ?? params.callOutcome : null;
  const note = kind === "call_back" ? `Call logged${outcome ? `: ${outcome}` : ""}` : "Tour booked";
  const notice = kind === "call_back" ? `The call back was made${outcome ? ` (${outcome})` : ""}` : "The tour was booked";
  return finishHandoverJobs(admin, jobs as FinishableJob[], params.userId, note, notice);
}
