// DB side of customer complaints (see complaints.ts and migration 00622). Server only.

import type { SupabaseClient } from "@supabase/supabase-js";
import { classify } from "@/lib/facility-classifier";
import { REQUEST_OWNER_ROLE, requestDueAt, type RequestType } from "@/lib/requests";
import {
  OPEN_COMPLAINT_WINDOW_DAYS,
  REPEAT_WINDOW_DAYS,
  suggestComplaintPriority,
} from "@/lib/complaints";

const DAY_MS = 86_400_000;
const MAX_MESSAGES = 20;
/** A plain message joins an open complaint or request only within this long of its last message. */
const FOLLOW_UP_WINDOW_HOURS = 12;

export type RecordedComplaint = { id: string; reference: string; appended: boolean };

/** The customer's complaint or request that is still being dealt with, if any: new, waiting on
 *  info, or handled by a work order or task that is not yet finished. One that is finished is
 *  done: a further message is a new one. `kind` and `requestType` narrow the search. */
async function findOpenComplaint(
  supabase: SupabaseClient,
  leadId: string,
  filter: { kind?: "complaint" | "request"; requestType?: string } = {}
) {
  const since = new Date(Date.now() - OPEN_COMPLAINT_WINDOW_DAYS * DAY_MS).toISOString();
  let q = supabase
    .from("customer_complaints")
    .select("id, reference, messages, status, issue_id, task_id")
    .eq("lead_id", leadId)
    .in("status", ["new", "needs_info", "qualified"])
    .gte("created_at", since);
  if (filter.kind) q = q.eq("kind", filter.kind);
  if (filter.requestType) q = q.eq("request_type", filter.requestType);
  const { data: open } = await q.order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (!open) return null;
  if (open.status === "qualified" && open.issue_id) {
    const { data: issue } = await supabase.from("facility_issues").select("status").eq("id", open.issue_id).maybeSingle();
    if (issue?.status === "resolved" || issue?.status === "closed") return null;
  }
  if (open.status === "qualified" && open.task_id) {
    const { data: task } = await supabase.from("tasks").select("status").eq("id", open.task_id).maybeSingle();
    if (task?.status === "done") return null;
  }
  return open;
}

async function appendTo(supabase: SupabaseClient, open: { id: string; messages: unknown }, text: string) {
  const message = { at: new Date().toISOString(), text: text.slice(0, 1000) };
  const messages = [...((open.messages as unknown[]) ?? []), message].slice(-MAX_MESSAGES);
  await supabase.from("customer_complaints").update({ messages, updated_at: new Date().toISOString() }).eq("id", open.id);
}

/** A customer's ordinary message while a complaint of theirs is open belongs to that
 *  complaint ("it is very hot now", "still not cooling"), not to the void. Null if none is open. */
export async function appendToOpenComplaint(
  supabase: SupabaseClient,
  leadId: string,
  text: string
): Promise<RecordedComplaint | null> {
  const open = await findOpenComplaint(supabase, leadId);
  if (!open) return null;
  // Only a recent thread: a message long after the last one is not a follow-up to it.
  const messages = (open.messages as { at?: string }[]) ?? [];
  const last = messages.at(-1)?.at;
  if (last && Date.now() - Date.parse(last) > FOLLOW_UP_WINDOW_HOURS * 3_600_000) return null;
  await appendTo(supabase, open, text);
  return { id: open.id as string, reference: open.reference as string, appended: true };
}

/** Records a customer's problem message. If the same customer already has a complaint that is
 *  still open the message joins it instead of opening a second one. Returns null if nothing
 *  could be saved. */
export async function recordComplaint(
  supabase: SupabaseClient,
  input: { leadId: string; customerName: string; customerPhone: string; text: string }
): Promise<RecordedComplaint | null> {
  const message = { at: new Date().toISOString(), text: input.text.slice(0, 1000) };

  const open = await findOpenComplaint(supabase, input.leadId, { kind: "complaint" });
  if (open) {
    await appendTo(supabase, open, input.text);
    return { id: open.id as string, reference: open.reference as string, appended: true };
  }

  const [{ data: contract }, { count: earlier }] = await Promise.all([
    supabase
      .from("contracts")
      .select("id")
      .eq("lead_id", input.leadId)
      .eq("status", "active")
      .order("activated_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from("customer_complaints")
      .select("id", { count: "exact", head: true })
      .eq("lead_id", input.leadId)
      .gte("created_at", new Date(Date.now() - REPEAT_WINDOW_DAYS * DAY_MS).toISOString()),
  ]);

  const repeatCount = earlier ?? 0;
  const guess = classify(input.text);
  const { data: created, error } = await supabase
    .from("customer_complaints")
    .insert({
      lead_id: input.leadId,
      contract_id: (contract?.id as string | undefined) ?? null,
      customer_name: input.customerName,
      customer_phone: input.customerPhone,
      messages: [message],
      suggested_scope: guess.scope ?? null,
      suggested_priority: suggestComplaintPriority(repeatCount, guess.priorityFloor),
      repeat_count: repeatCount,
    })
    .select("id, reference")
    .single();
  if (error || !created) {
    console.error("[complaints] could not record complaint:", error?.message);
    return null;
  }
  return { id: created.id as string, reference: created.reference as string, appended: false };
}

/** Records a customer's request. A further message of the same type, while one is open, joins it. */
export async function recordRequest(
  supabase: SupabaseClient,
  input: { leadId: string; customerName: string; customerPhone: string; text: string; type: RequestType }
): Promise<RecordedComplaint | null> {
  const open = await findOpenComplaint(supabase, input.leadId, { kind: "request", requestType: input.type });
  if (open) {
    await appendTo(supabase, open, input.text);
    return { id: open.id as string, reference: open.reference as string, appended: true };
  }
  const { data: contract } = await supabase
    .from("contracts")
    .select("id")
    .eq("lead_id", input.leadId)
    .eq("status", "active")
    .order("activated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const { data: created, error } = await supabase
    .from("customer_complaints")
    .insert({
      kind: "request",
      request_type: input.type,
      owner_role: REQUEST_OWNER_ROLE[input.type],
      due_at: requestDueAt(input.type).toISOString(),
      lead_id: input.leadId,
      contract_id: (contract?.id as string | undefined) ?? null,
      customer_name: input.customerName,
      customer_phone: input.customerPhone,
      messages: [{ at: new Date().toISOString(), text: input.text.slice(0, 1000) }],
    })
    .select("id, reference")
    .single();
  if (error || !created) {
    console.error("[requests] could not record request:", error?.message);
    return null;
  }
  return { id: created.id as string, reference: created.reference as string, appended: false };
}
