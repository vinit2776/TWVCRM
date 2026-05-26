import type { SupabaseClient } from "@supabase/supabase-js";
import type { LeadStatus } from "@/types";

/**
 * Status progression order — index determines priority.
 * Auto-updates only move forward (never downgrade).
 */
const STATUS_ORDER: LeadStatus[] = [
  "new",
  "contacted",
  "tour_scheduled",
  "tour_completed",
  "proposal_sent",
  "negotiating",
  "won",
  "lost",
];

function statusIndex(status: LeadStatus): number {
  return STATUS_ORDER.indexOf(status);
}

/**
 * Auto-advance lead status based on CRM events.
 *
 * Rules:
 *  - activity (call/meeting/note/email) → "contacted" (if currently "new")
 *  - tour activity logged, future or no date → "tour_scheduled" (if before that)
 *  - tour activity logged, meeting_end_at in the past → "tour_completed" (if before that)
 *  - proposal created → "proposal_sent" (if currently before "proposal_sent")
 *  - contract activated → "won" + set converted_at (unless already "won" or "lost")
 *
 * Never downgrades: if the lead is already at or past the target status, no change is made.
 */
export async function autoUpdateLeadStatus(
  supabase: SupabaseClient,
  leadId: string,
  trigger: "activity" | "proposal" | "contract" | "tour",
  options?: { meetingEndAt?: string | null }
): Promise<void> {
  // Fetch current lead status
  const { data: lead } = await supabase
    .from("leads")
    .select("status")
    .eq("id", leadId)
    .single();

  if (!lead) return;

  const currentStatus = lead.status as LeadStatus;
  let targetStatus: LeadStatus | null = null;

  if (trigger === "activity") {
    // Only upgrade from "new" to "contacted" for non-tour activities
    if (currentStatus === "new") {
      targetStatus = "contacted";
    }
  } else if (trigger === "tour") {
    // Tour completed if meeting_end_at is in the past; otherwise just scheduled
    const isCompleted =
      options?.meetingEndAt && new Date(options.meetingEndAt) <= new Date();
    if (isCompleted) {
      if (statusIndex(currentStatus) < statusIndex("tour_completed")) {
        targetStatus = "tour_completed";
      }
    } else {
      if (statusIndex(currentStatus) < statusIndex("tour_scheduled")) {
        targetStatus = "tour_scheduled";
      }
    }
  } else if (trigger === "proposal") {
    // Upgrade to "proposal_sent" if not already there or beyond
    if (statusIndex(currentStatus) < statusIndex("proposal_sent")) {
      targetStatus = "proposal_sent";
    }
  } else if (trigger === "contract") {
    // Advance to "won" when a contract becomes active (unless already won or lost)
    if (currentStatus !== "won" && currentStatus !== "lost") {
      targetStatus = "won";
    }
  }

  if (targetStatus && targetStatus !== currentStatus) {
    const updatePayload: Record<string, unknown> = { status: targetStatus };

    // Set converted_at when lead is won via contract activation
    if (trigger === "contract" && targetStatus === "won") {
      updatePayload.converted_at = new Date().toISOString();
    }

    await supabase
      .from("leads")
      .update(updatePayload)
      .eq("id", leadId);
  }
}
