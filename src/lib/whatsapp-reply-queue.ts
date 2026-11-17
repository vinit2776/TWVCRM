// Open WhatsApp enquiries where the customer is waiting for an answer, shared by the Replies tab
// and the reply-wait alert so both judge "waiting" by the same rule.

import type { SupabaseClient } from "@supabase/supabase-js";
import { enquiryMessages, type RawEnquiryRow } from "@/lib/enquiries";
import { waitingReply, waitTone, type WaitingReply, type WaitTone } from "@/lib/whatsapp-replies";

export type WaitingRow = {
  id: string;
  reference: string;
  lead_id: string | null;
  claimed_by: string;
  payload: RawEnquiryRow["payload"];
  lead: { first_name: string | null; last_name: string | null; mobile: string | null } | null;
  claimer: { full_name: string } | null;
  reply: WaitingReply;
  tone: WaitTone;
};

/** Longest wait first. `client` must be able to read lead_enquiries and enquiry_updates (admin client). */
export async function loadWaitingReplies(client: SupabaseClient, now: number = Date.now()): Promise<WaitingRow[]> {
  const { data, error } = await client
    .from("lead_enquiries")
    .select(
      "id, reference, lead_id, payload, received_at, claimed_by, claimed_at, " +
        "lead:leads!lead_enquiries_lead_id_fkey(first_name, last_name, mobile), " +
        "claimer:users!lead_enquiries_claimed_by_fkey(full_name)"
    )
    .eq("source", "whatsapp")
    .is("resolved_at", null)
    .not("claimed_by", "is", null)
    .order("received_at", { ascending: false })
    .limit(500);
  if (error) throw new Error(error.message);
  type Row = Omit<WaitingRow, "reply" | "tone"> & { claimed_at: string | null };
  const rows = (data ?? []) as unknown as Row[];

  // The latest thing a person logged on each, to measure the customer's messages against.
  const lastUpdate = new Map<string, string>();
  if (rows.length) {
    const { data: updates } = await client
      .from("enquiry_updates")
      .select("enquiry_id, created_at")
      .in("enquiry_id", rows.map((r) => r.id));
    for (const u of (updates ?? []) as { enquiry_id: string; created_at: string }[]) {
      if (u.created_at > (lastUpdate.get(u.enquiry_id) ?? "")) lastUpdate.set(u.enquiry_id, u.created_at);
    }
  }

  const waiting: WaitingRow[] = [];
  for (const row of rows) {
    const lastStaffAt = [row.claimed_at, lastUpdate.get(row.id)].filter((t): t is string => !!t).sort().at(-1) ?? null;
    const reply = waitingReply(enquiryMessages(row.payload), lastStaffAt);
    if (reply) waiting.push({ ...row, reply, tone: waitTone(reply.waitingSince, now) });
  }
  return waiting.sort((a, b) => a.reply.waitingSince.localeCompare(b.reply.waitingSince));
}
