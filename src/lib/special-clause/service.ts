import type { SupabaseClient } from "@supabase/supabase-js";
import { logAudit } from "@/lib/audit";
import { createNotificationsForUsers } from "@/lib/in-app-notifications";
import { sendPushToUsers } from "@/lib/push";
import { canApproveSpecialClause, canAuthorSpecialClause } from "./gate";
import { verifyReviewToken } from "./token";
import { regenerateCaseAgreementPdfs } from "./case-regenerate";
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

export type SubjectKind = "contract" | "case";
export interface Subject {
  kind: SubjectKind;
  id: string;
}

interface SubjectRow {
  id: string;
  /** Human reference used in notifications and audit text (TWV-C-0014, case number). */
  label: string;
  /** Why a clause can't be added or changed now (agreement out for signature, signed…), or null. */
  lockedReason: string | null;
  special_clause_status: string | null;
  special_clause_id: string | null;
}

const FK: Record<SubjectKind, "contract_id" | "case_id"> = { contract: "contract_id", case: "case_id" };
const TABLE: Record<SubjectKind, string> = { contract: "contracts", case: "cases" };
const URL_PREFIX: Record<SubjectKind, string> = { contract: "/contracts", case: "/cases" };
const AUDIT_ENTITY = { contract: "contract", case: "case" } as const;

/** Contracts whose agreement is already out for signature or signed can't take a new clause. */
const CLOSED_STATUSES = ["rejected", "terminated", "completed", "expired"];

async function loadSubject(admin: SupabaseClient, subject: Subject): Promise<SubjectRow | null> {
  if (subject.kind === "contract") {
    const { data } = await admin
      .from("contracts")
      .select("id, contract_number, status, signed_document_id, leegality_document_id, special_clause_status, special_clause_id")
      .eq("id", subject.id)
      .maybeSingle();
    const c = data as {
      id: string; contract_number: string; status: string; signed_document_id: string | null;
      leegality_document_id: string | null; special_clause_status: string | null; special_clause_id: string | null;
    } | null;
    if (!c) return null;
    let lockedReason: string | null = null;
    if (CLOSED_STATUSES.includes(c.status)) lockedReason = `Can't change the clause on a ${c.status} contract.`;
    else if (c.signed_document_id || c.leegality_document_id) {
      lockedReason = "This agreement is already out for signature or signed. Changes go through an addendum.";
    }
    return { id: c.id, label: c.contract_number, lockedReason, special_clause_status: c.special_clause_status, special_clause_id: c.special_clause_id };
  }

  const { data } = await admin
    .from("cases")
    .select("id, case_number, special_clause_status, special_clause_id")
    .eq("id", subject.id)
    .maybeSingle();
  const k = data as { id: string; case_number: string | null; special_clause_status: string | null; special_clause_id: string | null } | null;
  if (!k) return null;
  const { data: agreements } = await admin
    .from("case_agreements")
    .select("status, signed_document_id")
    .eq("case_id", subject.id);
  const out = ((agreements ?? []) as { status: string | null; signed_document_id: string | null }[])
    .some((a) => a.signed_document_id || a.status === "signing" || a.status === "executed");
  return {
    id: k.id,
    label: k.case_number || "Virtual office case",
    lockedReason: out ? "An agreement for this case is already out for signature or signed. Changes go through an addendum." : null,
    special_clause_status: k.special_clause_status,
    special_clause_id: k.special_clause_id,
  };
}

/** Keeps anything derived from the clause in step: a VO case's stored agreement PDFs. */
async function afterTextChanged(admin: SupabaseClient, subject: Subject): Promise<void> {
  if (subject.kind === "case") await regenerateCaseAgreementPdfs(admin, subject.id);
}

async function notifyApprovers(admin: SupabaseClient, exceptUserId: string, title: string, body: string, subject: Subject) {
  const { data } = await admin.from("users").select("id").in("role", ["admin", "manager"]).eq("is_active", true);
  const ids = ((data ?? []) as { id: string }[]).map((u) => u.id).filter((id) => id !== exceptUserId);
  const url = `${URL_PREFIX[subject.kind]}/${subject.id}`;
  await createNotificationsForUsers(ids, { type: "special_clause", title, body, url, entityType: AUDIT_ENTITY[subject.kind], entityId: subject.id });
  await sendPushToUsers(ids, { title, body, url, tag: `special-clause-${subject.id}` });
}

async function notifyUser(userId: string | null, title: string, body: string, subject: Subject) {
  if (!userId) return;
  const url = `${URL_PREFIX[subject.kind]}/${subject.id}`;
  await createNotificationsForUsers([userId], { type: "special_clause", title, body, url, entityType: AUDIT_ENTITY[subject.kind], entityId: subject.id });
  await sendPushToUsers([userId], { title, body, url, tag: `special-clause-${subject.id}` });
}

export interface SubmitInput {
  subject: Subject;
  actor: Actor;
  intent: string;
  reason: string;
  clauseText: string;
  reviewToken: string;
  report: ClauseReport;
}

export async function submitSpecialClause(admin: SupabaseClient, input: SubmitInput): Promise<ServiceResult<{ revisionId: string; status: "pending_approval" | "approved" }>> {
  const { actor, subject } = input;
  if (!canAuthorSpecialClause(actor.role)) return fail(403, "You can't add a special clause.");
  if (!verifyReviewToken(input.reviewToken, input.clauseText, input.intent)) {
    return fail(400, "This clause wasn't reviewed (or the review expired). Draft and review it again.");
  }

  const row0 = await loadSubject(admin, subject);
  if (!row0) return fail(404, subject.kind === "case" ? "Case not found" : "Contract not found");
  if (row0.lockedReason) return fail(400, row0.lockedReason);
  if (row0.special_clause_status === "pending_approval") {
    return fail(409, "A clause is already awaiting approval. Withdraw it first to submit a different one.");
  }

  const fk = FK[subject.kind];
  const { data: last } = await admin
    .from("special_clauses").select("revision").eq(fk, subject.id)
    .order("revision", { ascending: false }).limit(1).maybeSingle();
  const revision = ((last as { revision: number } | null)?.revision ?? 0) + 1;

  const selfApproved = canApproveSpecialClause(actor.role);
  const status = selfApproved ? "approved" : "pending_approval";
  const now = new Date().toISOString();

  // Retire the previous live revision (approved or changes_requested) only after
  // the new row exists, so a failure here never leaves the subject without history.
  const { data: row, error } = await admin
    .from("special_clauses")
    .insert({
      [fk]: subject.id,
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

  if (row0.special_clause_id) {
    await admin.from("special_clauses").update({ status: "superseded" }).eq("id", row0.special_clause_id).in("status", ["approved", "changes_requested"]);
  }

  const { error: cErr } = await admin.from(TABLE[subject.kind]).update({
    special_clause_status: status,
    special_clause_text: selfApproved ? input.clauseText : null,
    special_clause_id: revisionId,
  }).eq("id", subject.id);
  if (cErr) return fail(500, cErr.message);
  await afterTextChanged(admin, subject);

  await logAudit(admin, {
    entityType: AUDIT_ENTITY[subject.kind], entityId: subject.id,
    action: selfApproved ? "special_clause_approved" : "special_clause_submitted",
    performedBy: actor.id,
    changes: { special_clause: { old: row0.special_clause_status, new: status }, revision: { old: null, new: revision }, intent: { old: null, new: input.intent }, clause_text: { old: null, new: input.clauseText } },
  });

  if (!selfApproved) {
    await notifyApprovers(admin, actor.id, "Clause approval needed", `${row0.label}: ${actor.name} submitted a special clause for approval.`, subject);
  }
  return { ok: true, revisionId, status };
}

export interface DecideInput {
  subject: Subject;
  revisionId: string;
  actor: Actor;
  decision: "approve" | "request_changes";
  note?: string;
  requiredChanges?: string;
}

export async function decideSpecialClause(admin: SupabaseClient, input: DecideInput): Promise<ServiceResult<{ status: "approved" | "changes_requested" }>> {
  const { actor, subject } = input;
  if (!canApproveSpecialClause(actor.role)) return fail(403, "Only a manager or admin can decide on a special clause.");

  const subj = await loadSubject(admin, subject);
  if (!subj) return fail(404, subject.kind === "case" ? "Case not found" : "Contract not found");

  const { data: rev } = await admin
    .from("special_clauses").select("id, status, clause_text, submitted_by")
    .eq("id", input.revisionId).eq(FK[subject.kind], subject.id).maybeSingle();
  const row = rev as { id: string; status: string; clause_text: string; submitted_by: string | null } | null;
  if (!row) return fail(404, "Clause revision not found");
  if (row.status !== "pending_approval" || subj.special_clause_id !== row.id) {
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

  const { error: cErr } = await admin.from(TABLE[subject.kind]).update({
    special_clause_status: status,
    special_clause_text: approve ? row.clause_text : null,
  }).eq("id", subject.id);
  if (cErr) return fail(500, cErr.message);
  await afterTextChanged(admin, subject);

  await logAudit(admin, {
    entityType: AUDIT_ENTITY[subject.kind], entityId: subject.id,
    action: approve ? "special_clause_approved" : "special_clause_changes_requested",
    performedBy: actor.id,
    changes: { special_clause: { old: "pending_approval", new: status }, ...(approve ? {} : { reason: { old: null, new: note }, required_changes: { old: null, new: required } }) },
  });

  await notifyUser(
    row.submitted_by,
    approve ? "Clause approved" : "Clause needs changes",
    approve
      ? `${subj.label}: ${actor.name} approved the special clause. The agreement can now be sent.`
      : `${subj.label}: ${actor.name} asked for changes — ${note}`,
    subject,
  );
  return { ok: true, status };
}

export async function withdrawSpecialClause(admin: SupabaseClient, input: { subject: Subject; actor: Actor }): Promise<ServiceResult> {
  const { actor, subject } = input;
  const subj = await loadSubject(admin, subject);
  if (!subj) return fail(404, subject.kind === "case" ? "Case not found" : "Contract not found");
  if (subj.special_clause_status !== "pending_approval" || !subj.special_clause_id) {
    return fail(409, "There's no pending clause to withdraw.");
  }
  const { data: rev } = await admin.from("special_clauses").select("id, revision, submitted_by").eq("id", subj.special_clause_id).maybeSingle();
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
    .eq(FK[subject.kind], subject.id).lt("revision", row.revision)
    .order("revision", { ascending: false }).limit(1).maybeSingle();
  const p = prev as { id: string; clause_text: string; decided_by: string | null; required_changes: string | null; status: string } | null;
  const wasApproved = !!p && p.status === "superseded" && !!p.decided_by && !p.required_changes;
  if (wasApproved && p) {
    await admin.from("special_clauses").update({ status: "approved" }).eq("id", p.id);
    await admin.from(TABLE[subject.kind]).update({ special_clause_status: "approved", special_clause_text: p.clause_text, special_clause_id: p.id }).eq("id", subject.id);
  } else {
    await admin.from(TABLE[subject.kind]).update({ special_clause_status: null, special_clause_text: null, special_clause_id: null }).eq("id", subject.id);
  }
  await afterTextChanged(admin, subject);

  await logAudit(admin, {
    entityType: AUDIT_ENTITY[subject.kind], entityId: subject.id, action: "special_clause_withdrawn", performedBy: actor.id,
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
