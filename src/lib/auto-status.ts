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
 *  - activity (call/meeting/note/email/tour) → "contacted" (if currently "new")
 *  - proposal created → "proposal_sent" (if currently before "proposal_sent")
 *
 * Never downgrades: if the lead is already at or past the target status, no change is made.
 */
export async function autoUpdateLeadStatus(
  supabase: SupabaseClient,
  leadId: string,
  trigger: "activity" | "proposal"
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
    // Only upgrade from "new" to "contacted"
    if (currentStatus === "new") {
      targetStatus = "contacted";
    }
  } else if (trigger === "proposal") {
    // Upgrade to "proposal_sent" if not already there or beyond
    if (statusIndex(currentStatus) < statusIndex("proposal_sent")) {
      targetStatus = "proposal_sent";
    }
  }

  if (targetStatus && targetStatus !== currentStatus) {
    await supabase
      .from("leads")
      .update({ status: targetStatus })
      .eq("id", leadId);
  }
}
