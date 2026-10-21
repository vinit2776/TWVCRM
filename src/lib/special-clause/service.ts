import type { SupabaseClient } from "@supabase/supabase-js";
import { logAudit } from "@/lib/audit";
import { createNotificationsForUsers } from "@/lib/in-app-notifications";
import { sendPushToUsers } from "@/lib/push";
import { canApproveSpecialClause, canAuthorSpecialClause } from "./gate";
import { verifyReviewToken } from "./token";
import type { ClauseReport } from "./ai";

// Server-side state machine for a contract's special clause. Callers pass the
// admin (service-role) client: the rows are written on behalf of the user after
// the role checks below, and the notifications need to reach other users.

export interface Actor {
  id: string;
  role: string;
  name: string;
}

export type ServiceResult<T = object> =
  | ({ ok: true } & T)
  | { ok: false; status: number; error: string };

const fail = (status: number, error: string): { ok: false; status: number; error: string } => ({ ok: false, status, error });

/** Contracts whose agreement is already out for signature or signed can't take a new clause. */
const CLOSED_STATUSES = ["rejected", "terminated", "completed", "expired"];

interface ContractRow {
  id: string;
  contract_number: string;
  status: string;
  signed_document_id: string | null;
  leegality_document_id: string | null;
  special_clause_status: string | null;
  special_clause_id: string | null;
}

async function loadContract(admin: SupabaseClient, id: string): Promise<ContractRow | null> {
  const { data } = await admin
    .from("contracts")
    .select("id, contract_number, status, signed_document_id, leegality_document_id, special_clause_status, special_clause_id")
    .eq("id", id)
    .maybeSingle();
  return (data as ContractRow | null) ?? null;
}

async function notifyApprovers(admin: SupabaseClient, exceptUserId: string, title: string, body: string, contractId: string) {
  const { data } = await admin.from("users").select("id").in("role", ["admin", "manager"]).eq("is_active", true);
  const ids = ((data ?? []) as { id: string }[]).map((u) => u.id).filter((id) => id !== exceptUserId);
  const url = `/contracts/${contractId}`;
  await createNotificationsForUsers(ids, { type: "special_clause", title, body, url, entityType: "contract", entityId: contractId });
  await sendPushToUsers(ids, { title, body, url, tag: `special-clause-${contractId}` });
}

async function notifyUser(userId: string | null, title: string, body: string, contractId: string) {
  if (!userId) return;
  const url = `/contracts/${contractId}`;
  await createNotificationsForUsers([userId], { type: "special_clause", title, body, url, entityType: "contract", entityId: contractId });
  await sendPushToUsers([userId], { title, body, url, tag: `special-clause-${contractId}` });
}

export interface SubmitInput {
  contractId: string;
  actor: Actor;
  intent: string;
  reason: string;
  clauseText: string;
  reviewToken: string;
  report: ClauseReport;
}

export async function submitSpecialClause(admin: SupabaseClient, input: SubmitInput): Promise<ServiceResult<{ revisionId: string; status: "pending_approval" | "approved" }>> {
  const { actor } = input;
  if (!canAuthorSpecialClause(actor.role)) return fail(403, "You can't add a special clause.");
  if (!verifyReviewToken(input.reviewToken, input.clauseText, input.intent)) {
    return fail(400, "This clause wasn't reviewed (or the review expired). Draft and review it again.");
  }

  const contract = await loadContract(admin, input.contractId);
  if (!contract) return fail(404, "Contract not found");
  if (CLOSED_STATUSES.includes(contract.status)) return fail(400, `Can't add a clause to a ${contract.status} contract.`);
  if (contract.signed_document_id || contract.leegality_document_id) {
    return fail(400, "This agreement is already out for signature or signed. Changes go through an addendum.");
  }
  if (contract.special_clause_status === "pending_approval") {
    return fail(409, "A clause is already awaiting approval. Withdraw it first to submit a different one.");
  }

  const { data: last } = await admin
    .from("special_clauses").select("revision").eq("contract_id", contract.id)
    .order("revision", { ascending: false }).limit(1).maybeSingle();
  const revision = ((last as { revision: number } | null)?.revision ?? 0) + 1;

  const selfApproved = canApproveSpecialClause(actor.role);
  const status = selfApproved ? "approved" : "pending_approval";
  const now = new Date().toISOString();

  // Retire the previous live revision (approved or changes_requested) only after
  // the new row exists, so a failure here never leaves the contract without history.
  const { data: row, error } = await admin
    .from("special_clauses")
    .insert({
      contract_id: contract.id,
      revision,
      status,
      intent: input.intent,
      reason: input.reason,
      clause_text: input.clauseText,
      ai_report: input.report,
      submitted_by: actor.id,
      submitted_at: now,
      ...(selfApproved ? { decided_by: actor.id, decided_at: now, self_approved: true } : {}),
    })
    .select("id")
    .single();
  if (error || !row) return fail(500, error?.message ?? "Couldn't save the clause");
  const revisionId = (row as { id: string }).id;

  if (contract.special_clause_id) {
    await admin.from("special_clauses").update({ status: "superseded" }).eq("id", contract.special_clause_id).in("status", ["approved", "changes_requested"]);
  }

  const { error: cErr } = await admin.from("contracts").update({
    special_clause_status: status,
    special_clause_text: selfApproved ? input.clauseText : null,
    special_clause_id: revisionId,
  }).eq("id", contract.id);
  if (cErr) return fail(500, cErr.message);

  await logAudit(admin, {
    entityType: "contract", entityId: contract.id,
    action: selfApproved ? "special_clause_approved" : "special_clause_submitted",
    performedBy: actor.id,
    changes: { special_clause: { old: contract.special_clause_status, new: status }, revision: { old: null, new: revision }, intent: { old: null, new: input.intent }, clause_text: { old: null, new: input.clauseText } },
  });

  if (!selfApproved) {
    await notifyApprovers(admin, actor.id, "Clause approval needed", `${contract.contract_number}: ${actor.name} submitted a special clause for approval.`, contract.id);
  }
  return { ok: true, revisionId, status };
}

export interface DecideInput {
  contractId: string;
  revisionId: string;
  actor: Actor;
  decision: "approve" | "request_changes";
  note?: string;
  requiredChanges?: string;
}

export async function decideSpecialClause(admin: SupabaseClient, input: DecideInput): Promise<ServiceResult<{ status: "approved" | "changes_requested" }>> {
  const { actor } = input;
  if (!canApproveSpecialClause(actor.role)) return fail(403, "Only a manager or admin can decide on a special clause.");

  const contract = await loadContract(admin, input.contractId);
  if (!contract) return fail(404, "Contract not found");

  const { data: rev } = await admin
    .from("special_clauses").select("id, status, clause_text, submitted_by")
    .eq("id", input.revisionId).eq("contract_id", contract.id).maybeSingle();
  const row = rev as { id: string; status: string; clause_text: string; submitted_by: string | null } | null;
  if (!row) return fail(404, "Clause revision not found");
  if (row.status !== "pending_approval" || contract.special_clause_id !== row.id) {
    return fail(409, "This revision is no longer awaiting approval — it may already have been decided or withdrawn.");
  }

  const approve = input.decision === "approve";
  const note = input.note?.trim() ?? "";
  const required = input.requiredChanges?.trim() ?? "";
  if (!approve && (note.length < 10 || required.length < 10)) {
    return fail(400, "Give a reason and what needs to be corrected (at least 10 characters each).");
  }

  const status = approve ? "approved" : "changes_requested";
  const { error } = await admin.from("special_clauses").update({
    status,
    decided_by: actor.id,
    decided_at: new Date().toISOString(),
    decision_note: approve ? (note || null) : note,
    required_changes: approve ? null : required,
  }).eq("id", row.id).eq("status", "pending_approval");
  if (error) return fail(500, error.message);

  const { error: cErr } = await admin.from("contracts").update({
    special_clause_status: status,
    special_clause_text: approve ? row.clause_text : null,
  }).eq("id", contract.id);
  if (cErr) return fail(500, cErr.message);

  await logAudit(admin, {
    entityType: "contract", entityId: contract.id,
    action: approve ? "special_clause_approved" : "special_clause_changes_requested",
    performedBy: actor.id,
    changes: { special_clause: { old: "pending_approval", new: status }, ...(approve ? {} : { reason: { old: null, new: note }, required_changes: { old: null, new: required } }) },
  });

  await notifyUser(
    row.submitted_by,
    approve ? "Clause approved" : "Clause needs changes",
    approve
      ? `${contract.contract_number}: ${actor.name} approved the special clause. The agreement can now be sent.`
      : `${contract.contract_number}: ${actor.name} asked for changes — ${note}`,
    contract.id,
  );
  return { ok: true, status };
}

export async function withdrawSpecialClause(admin: SupabaseClient, input: { contractId: string; actor: Actor }): Promise<ServiceResult> {
  const { actor } = input;
  const contract = await loadContract(admin, input.contractId);
  if (!contract) return fail(404, "Contract not found");
  if (contract.special_clause_status !== "pending_approval" || !contract.special_clause_id) {
    return fail(409, "There's no pending clause to withdraw.");
  }
  const { data: rev } = await admin.from("special_clauses").select("id, revision, submitted_by").eq("id", contract.special_clause_id).maybeSingle();
  const row = rev as { id: string; revision: number; submitted_by: string | null } | null;
  if (!row) return fail(404, "Clause revision not found");
  if (row.submitted_by !== actor.id && !canApproveSpecialClause(actor.role)) {
    return fail(403, "Only the person who submitted the clause (or a manager/admin) can withdraw it.");
  }

  await admin.from("special_clauses").update({ status: "withdrawn" }).eq("id", row.id);

  // If this revision replaced an approved one, put that approved clause back
  // rather than silently dropping text the customer was already promised.
  const { data: prev } = await admin
    .from("special_clauses").select("id, clause_text, decided_by, required_changes, status")
    .eq("contract_id", contract.id).lt("revision", row.revision)
    .order("revision", { ascending: false }).limit(1).maybeSingle();
  const p = prev as { id: string; clause_text: string; decided_by: string | null; required_changes: string | null; status: string } | null;
  const wasApproved = !!p && p.status === "superseded" && !!p.decided_by && !p.required_changes;
  if (wasApproved && p) {
    await admin.from("special_clauses").update({ status: "approved" }).eq("id", p.id);
    await admin.from("contracts").update({ special_clause_status: "approved", special_clause_text: p.clause_text, special_clause_id: p.id }).eq("id", contract.id);
  } else {
    await admin.from("contracts").update({ special_clause_status: null, special_clause_text: null, special_clause_id: null }).eq("id", contract.id);
  }

  await logAudit(admin, {
    entityType: "contract", entityId: contract.id, action: "special_clause_withdrawn", performedBy: actor.id,
    changes: { special_clause: { old: "pending_approval", new: wasApproved ? "approved" : null } },
  });
  return { ok: true };
}

/** Renewals inherit the parent's APPROVED clause automatically; anything else
 *  (pending, changes requested) is left behind and must go through approval. */
export async function carrySpecialClauseToRenewal(admin: SupabaseClient, params: { sourceContractId: string; newContractId: string; actorId: string }): Promise<boolean> {
  const { data: src } = await admin
    .from("contracts").select("contract_number, special_clause_status, special_clause_text, special_clause_id")
    .eq("id", params.sourceContractId).maybeSingle();
  const s = src as { contract_number: string; special_clause_status: string | null; special_clause_text: string | null; special_clause_id: string | null } | null;
  if (!s || s.special_clause_status !== "approved" || !s.special_clause_text || !s.special_clause_id) return false;

  const { data: orig } = await admin.from("special_clauses").select("intent, reason, ai_report").eq("id", s.special_clause_id).maybeSingle();
  const o = orig as { intent: string; reason: string; ai_report: unknown } | null;
  const now = new Date().toISOString();
  const { data: row, error } = await admin.from("special_clauses").insert({
    contract_id: params.newContractId, revision: 1, status: "approved",
    intent: o?.intent ?? "Carried over from renewal", reason: o?.reason ?? "Carried over from renewal",
    clause_text: s.special_clause_text, ai_report: o?.ai_report ?? null,
    submitted_by: params.actorId, submitted_at: now, decided_at: now,
    decision_note: `Carried over automatically on renewal of ${s.contract_number}`,
    carried_from_id: s.special_clause_id,
  }).select("id").single();
  if (error || !row) { console.error("[special-clause] carry-over failed:", error?.message); return false; }

  await admin.from("contracts").update({
    special_clause_status: "approved", special_clause_text: s.special_clause_text, special_clause_id: (row as { id: string }).id,
  }).eq("id", params.newContractId);
  await logAudit(admin, {
    entityType: "contract", entityId: params.newContractId, action: "special_clause_approved", performedBy: params.actorId,
    changes: { special_clause: { old: null, new: "approved" }, carried_from: { old: null, new: s.contract_number } },
  });
  return true;
}
