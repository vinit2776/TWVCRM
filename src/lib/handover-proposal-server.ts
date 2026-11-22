import type { SupabaseClient } from "@supabase/supabase-js";
import { finishHandoverJobs, type FinishableJob } from "@/lib/handover-finish-server";

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

  return finishHandoverJobs(
    admin,
    jobs as FinishableJob[],
    actorId,
    `Proposal${proposalNumber ? ` ${proposalNumber}` : ""} sent to the customer`,
    `The proposal was sent${proposalNumber ? ` (${proposalNumber})` : ""}`,
  );
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
