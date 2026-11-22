import type { SupabaseClient } from "@supabase/supabase-js";
import { logAudit } from "@/lib/audit";
import { createNotification } from "@/lib/in-app-notifications";

/**
 * A "send a proposal" job finishes by itself when its proposal goes out to the customer. The job is
 * tied to the proposal when the proposal is created from the job's button (`tasks.proposal_id`), so a
 * proposal someone makes some other way never finishes a job by accident. Call this only on a real
 * change to `sent`; downloading the PDF sets no status and does not finish anything.
 */
export async function completeHandoverTasksForProposal(
  admin: SupabaseClient,
  proposalId: string,
  actorId: string | null,
  proposalNumber?: string | null,
): Promise<number> {
  const { data: jobs } = await admin
    .from("tasks")
    .select("id, title, handed_over_by, lead_id")
    .eq("proposal_id", proposalId)
    .eq("kind", "send_proposal")
    .neq("status", "done");
  if (!jobs || jobs.length === 0) return 0;

  const now = new Date().toISOString();
  let finished = 0;
  for (const job of jobs) {
    const { error } = await admin
      .from("tasks")
      .update({
        status: "done",
        completed_at: now,
        completion_note: `Proposal${proposalNumber ? ` ${proposalNumber}` : ""} sent to the customer`,
      })
      .eq("id", job.id)
      .neq("status", "done");
    if (error) {
      console.error("[handover] could not finish the send-proposal job:", error.message);
      continue;
    }
    finished += 1;
    if (actorId) {
      logAudit(admin, {
        entityType: "task",
        entityId: job.id as string,
        action: "update",
        performedBy: actorId,
        changes: { status: { old: "todo", new: "done" } },
      });
    }
    if (job.handed_over_by && job.handed_over_by !== actorId) {
      await createNotification({
        userId: job.handed_over_by as string,
        type: "handover_job",
        title: job.title as string,
        body: `The proposal was sent${proposalNumber ? ` (${proposalNumber})` : ""}`,
        url: "/leads?view=home",
        entityType: "task",
        entityId: job.id as string,
      }).catch(() => {});
    }
  }
  return finished;
}

/**
 * Ties a proposal just created from a job's button to that job, so sending it finishes the job.
 * Only the person the job was given to, on that job's own lead, can tie a proposal to it.
 */
export async function linkProposalToHandoverJob(
  admin: SupabaseClient,
  jobId: string,
  proposalId: string,
  leadId: string | null,
  userId: string,
): Promise<boolean> {
  if (!leadId) return false;
  const { data, error } = await admin
    .from("tasks")
    .update({ proposal_id: proposalId })
    .eq("id", jobId)
    .eq("kind", "send_proposal")
    .eq("lead_id", leadId)
    .eq("assigned_to", userId)
    .neq("status", "done")
    .select("id");
  if (error) {
    console.error("[handover] could not link the proposal to the job:", error.message);
    return false;
  }
  return (data?.length ?? 0) > 0;
}
