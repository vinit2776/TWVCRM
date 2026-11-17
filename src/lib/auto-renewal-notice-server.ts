import type { SupabaseClient } from "@supabase/supabase-js";
import { logAudit, logEmailActivity } from "@/lib/audit";
import { resend, EMAIL_FROM, EMAIL_REPLY_TO } from "@/lib/mailer";
import { isProductionDatabase } from "@/lib/environment";
import { getCachedSettings } from "@/lib/app-settings-cache";
import { parseAutoRenewTiming, programmedEscalation } from "@/lib/auto-renewal";
import { planAutoRenewals } from "@/lib/auto-renewal-plan";
import { loadAutoRenewFacts } from "@/lib/auto-renewal-plan-server";
import {
  buildNoticeDraft,
  isDueToSend,
  isValidEmail,
  kindsToPrepare,
  noticeAttention,
  noticeRecipients,
  renderNoticeHtml,
  sendDayFor,
  splitRecipientsForEnvironment,
  type NoticeKind,
  type NoticeStatus,
} from "@/lib/auto-renewal-notice";

/** A row of auto_renewal_notices, as the API returns it. */
export interface NoticeRow {
  id: string;
  contract_id: string;
  kind: NoticeKind;
  term_end_date: string;
  status: NoticeStatus;
  subject: string;
  body: string;
  recipients: string[];
  current_rent: number;
  new_rent: number;
  escalation_percentage: number;
  renewal_start_date: string;
  send_on: string;
  edited: boolean;
  approved_by: string | null;
  approved_at: string | null;
  sent_by: string | null;
  sent_at: string | null;
  failure_reason: string | null;
  created_at: string;
}

const NOTICE_COLUMNS =
  "id, contract_id, kind, term_end_date, status, subject, body, recipients, current_rent, new_rent, escalation_percentage, renewal_start_date, send_on, edited, approved_by, approved_at, sent_by, sent_at, failure_reason, created_at";

/** Postgres: table does not exist (migration 00672 not on this database yet). */
const TABLE_MISSING = "42P01";
const UNIQUE_VIOLATION = "23505";

export const NOTICES_UNAVAILABLE = "Customer notices are not set up on this database yet (migration 00672 not applied).";

const todayIst = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

export async function loadNotices(
  admin: SupabaseClient,
  contractIds: string[],
): Promise<NoticeRow[] | null> {
  if (contractIds.length === 0) return [];
  const { data, error } = await admin
    .from("auto_renewal_notices")
    .select(NOTICE_COLUMNS)
    .in("contract_id", contractIds)
    .order("created_at", { ascending: true });
  if (error) {
    if (error.code === TABLE_MISSING) return null;
    throw new Error(`auto-renew notices: could not read notices: ${error.message}`);
  }
  return (data ?? []) as NoticeRow[];
}

export type PrepareResult =
  | { result: "created"; notice: NoticeRow }
  | { result: "exists" }
  | { result: "unavailable" }
  | { result: "blocked"; reason: string };

/**
 * Writes the draft for one notice of one contract. A draft sends nothing: a person
 * approves it first. Safe to call twice: the second call finds the first.
 *
 * `manual` is a person asking for it from the contract page, who can do so even for
 * a contract the daily job would hold; the job never does.
 */
export async function prepareNotice(
  admin: SupabaseClient,
  contractId: string,
  kind: NoticeKind,
  opts: { actorId: string | null; manual: boolean; today?: string },
): Promise<PrepareResult> {
  const today = opts.today ?? todayIst();
  const [facts, settings, contractRes] = await Promise.all([
    loadAutoRenewFacts(admin, today, { contractId }),
    getCachedSettings(admin, ["auto_renew_draft_lead_days", "auto_renew_notice_lead_days", "auto_renew_confirmation_days"]),
    admin
      .from("contracts")
      .select("tenure_months, lead:leads!contracts_lead_id_fkey(email, billing_emails)")
      .eq("id", contractId)
      .maybeSingle(),
  ]);
  if (facts === null) return { result: "unavailable" };
  const f = facts[0];
  if (!f || !contractRes.data) return { result: "blocked", reason: "Contract not found or not live." };

  const item = planAutoRenewals([f], today, parseAutoRenewTiming(settings)).items[0];
  if (!opts.manual && item.holds.length > 0) {
    return { result: "blocked", reason: `Held: ${item.holds.map((h) => h.label).join(", ")}` };
  }
  if (kind === "confirmation" && !item.schedule.confirmationOn) {
    return { result: "blocked", reason: "This contract's schedule has no rate confirmation." };
  }

  const lead = contractRes.data.lead as unknown as { email: string | null; billing_emails: string[] | null } | null;
  const programmed = programmedEscalation({
    agreement_escalation_percentage: f.agreementEscalationPercentage,
    escalation_percentage: f.escalationPercentage,
  });
  const negotiated = f.revisedEscalationPercentage != null && f.revisedEscalationPercentage !== programmed;

  let notifiedOn: string | null = null;
  if (kind === "confirmation") {
    const { data: sent } = await admin
      .from("auto_renewal_notices")
      .select("sent_at, renewal_start_date, new_rent, escalation_percentage")
      .eq("contract_id", contractId)
      .eq("kind", "notice")
      .eq("term_end_date", f.endDate)
      .eq("status", "sent")
      .maybeSingle();
    notifiedOn = sent?.sent_at ? String(sent.sent_at).slice(0, 10) : null;
  }

  const startDay = new Date(`${f.endDate}T00:00:00Z`);
  startDay.setUTCDate(startDay.getUTCDate() + 1);
  const renewalStart = startDay.toISOString().slice(0, 10);

  const draft = buildNoticeDraft({
    kind,
    customer: f.customer,
    contractNumber: f.contractNumber,
    location: f.location,
    endDate: f.endDate,
    renewalStart,
    termMonths: Number(contractRes.data.tenure_months ?? 11),
    currentRent: f.subtotal,
    newRent: item.nextRent,
    escalationPercentage: item.nextRentPct,
    negotiated,
    noticeDeadline: item.schedule.noticeDeadline,
    notifiedOn,
  });

  const { data: inserted, error } = await admin
    .from("auto_renewal_notices")
    .insert({
      contract_id: contractId,
      kind,
      term_end_date: f.endDate,
      status: "draft",
      subject: draft.subject,
      body: draft.body,
      recipients: noticeRecipients(lead),
      current_rent: f.subtotal,
      new_rent: item.nextRent,
      escalation_percentage: item.nextRentPct,
      renewal_start_date: renewalStart,
      send_on: sendDayFor(kind, item.schedule),
    })
    .select(NOTICE_COLUMNS)
    .single();

  if (error) {
    if (error.code === TABLE_MISSING) return { result: "unavailable" };
    if (error.code === UNIQUE_VIOLATION) return { result: "exists" };
    throw new Error(`auto-renew notices: could not save the draft: ${error.message}`);
  }

  logAudit(admin, {
    entityType: "contract",
    entityId: contractId,
    action: "auto_renewal_notice_prepared",
    performedBy: opts.actorId,
    changes: { notice: { old: null, new: `${kind} for term ending ${f.endDate}` } },
  });
  return { result: "created", notice: inserted as NoticeRow };
}

export type SendResult =
  | { ok: true; sentTo: string[]; skippedOnStaging: string[] }
  | { ok: false; error: string };

/**
 * Sends one notice by email. The row is claimed first (status sending), so two
 * callers cannot both send it. The daily job sends only approved notices; a person
 * can send a draft, an approved or a failed one from the contract page.
 */
export async function sendNotice(
  admin: SupabaseClient,
  noticeId: string,
  opts: { actorId: string | null; source: "job" | "manual" },
): Promise<SendResult> {
  const { data: row, error: readErr } = await admin
    .from("auto_renewal_notices")
    .select(NOTICE_COLUMNS)
    .eq("id", noticeId)
    .maybeSingle();
  if (readErr) return { ok: false, error: readErr.message };
  if (!row) return { ok: false, error: "Notice not found." };
  const notice = row as NoticeRow;

  const allowedFrom: NoticeStatus[] = opts.source === "job" ? ["approved"] : ["draft", "approved", "failed"];
  if (!allowedFrom.includes(notice.status)) {
    return { ok: false, error: `This notice is ${notice.status} and cannot be sent.` };
  }

  const valid = notice.recipients.filter(isValidEmail);
  if (valid.length === 0) return { ok: false, error: "There is no valid recipient email on this notice." };
  const { allowed, blocked } = splitRecipientsForEnvironment(valid, isProductionDatabase());
  if (allowed.length === 0) {
    return {
      ok: false,
      error: "This is not the production database, so notices can only go to @example.com addresses.",
    };
  }

  const { data: claimed } = await admin
    .from("auto_renewal_notices")
    .update({ status: "sending", updated_at: new Date().toISOString() })
    .eq("id", noticeId)
    .in("status", allowedFrom)
    .select("id");
  if (!claimed || claimed.length === 0) return { ok: false, error: "Someone else is already sending this notice." };

  let failure: string | null = null;
  try {
    const { error } = await resend.emails.send({
      from: EMAIL_FROM,
      replyTo: EMAIL_REPLY_TO,
      to: allowed,
      subject: notice.subject,
      html: renderNoticeHtml(notice.body),
      patient: true,
    });
    if (error) failure = error.message;
  } catch (err) {
    failure = err instanceof Error ? err.message : "unknown error";
  }

  const now = new Date().toISOString();
  if (failure) {
    await admin
      .from("auto_renewal_notices")
      .update({ status: "failed", failure_reason: failure.slice(0, 500), updated_at: now })
      .eq("id", noticeId);
    logAudit(admin, {
      entityType: "contract",
      entityId: notice.contract_id,
      action: "auto_renewal_notice_send_failed",
      performedBy: opts.actorId,
      changes: { notice: { old: null, new: notice.kind }, reason: { old: null, new: failure.slice(0, 200) } },
    });
    return { ok: false, error: `The email did not send: ${failure}` };
  }

  await admin
    .from("auto_renewal_notices")
    .update({ status: "sent", sent_at: now, sent_by: opts.actorId, failure_reason: null, updated_at: now })
    .eq("id", noticeId);
  logAudit(admin, {
    entityType: "contract",
    entityId: notice.contract_id,
    action: "auto_renewal_notice_sent",
    performedBy: opts.actorId,
    changes: {
      notice: { old: null, new: `${notice.kind} for term ending ${notice.term_end_date}` },
      new_rent: { old: notice.current_rent, new: notice.new_rent },
      sent_to: { old: null, new: allowed.length },
    },
  });

  if (opts.actorId) {
    const { data: contract } = await admin.from("contracts").select("lead_id").eq("id", notice.contract_id).maybeSingle();
    if (contract?.lead_id) {
      await logEmailActivity(admin, {
        leadId: contract.lead_id as string,
        subject: notice.subject,
        description: `Auto-renewal ${notice.kind} emailed to ${allowed.join(", ")}`,
        createdBy: opts.actorId,
      });
    }
  }
  return { ok: true, sentTo: allowed, skippedOnStaging: blocked };
}

/**
 * The price locks when the rate notice goes out: after that the next term's rent
 * is what the customer was told, so it can no longer be revised from the card.
 */
export async function lockedRateNotice(
  admin: SupabaseClient,
  contractId: string,
  termEndDate: string,
): Promise<{ sentAt: string; newRent: number } | null> {
  const { data, error } = await admin
    .from("auto_renewal_notices")
    .select("sent_at, new_rent")
    .eq("contract_id", contractId)
    .eq("kind", "notice")
    .eq("term_end_date", termEndDate)
    .eq("status", "sent")
    .maybeSingle();
  if (error || !data) return null;
  return { sentAt: String(data.sent_at), newRent: Number(data.new_rent) };
}

// ---------------------------------------------------------------------------
// The daily job's notice stage
// ---------------------------------------------------------------------------

export interface NoticeJobLine {
  contractNumber: string;
  customer: string;
  kind: NoticeKind;
  detail?: string;
}

export interface NoticeJobResult {
  available: boolean;
  prepared: NoticeJobLine[];
  sent: NoticeJobLine[];
  failed: NoticeJobLine[];
  /** Approved, due, but the contract is now held for a person, so nothing went. */
  heldBack: NoticeJobLine[];
  /** Drafts still waiting for a person to approve. */
  awaitingApproval: NoticeJobLine[];
  /** Their day has passed and they have not gone out. */
  late: NoticeJobLine[];
}

/**
 * Prepares today's drafts and sends the approved notices that are due, for every
 * opted-in contract in `plan`. Only called in live notice mode. A person approves
 * every notice; this never sends a draft.
 */
export async function runNoticeJob(
  admin: SupabaseClient,
  plan: ReturnType<typeof planAutoRenewals>,
  today: string,
): Promise<NoticeJobResult> {
  const out: NoticeJobResult = {
    available: true, prepared: [], sent: [], failed: [], heldBack: [], awaitingApproval: [], late: [],
  };
  const all = await loadNotices(admin, plan.items.map((i) => i.facts.id));
  if (all === null) return { ...out, available: false };

  for (const item of plan.items) {
    const f = item.facts;
    const line = (kind: NoticeKind, detail?: string): NoticeJobLine => ({
      contractNumber: f.contractNumber, customer: f.customer, kind, detail,
    });
    const mine = all.filter((n) => n.contract_id === f.id && n.term_end_date === f.endDate);

    const noticeSent = mine.some((n) => n.kind === "notice" && n.status === "sent");
    const toPrepare = kindsToPrepare(
      today, item.schedule, f.endDate, item.holds.length > 0, mine.map((n) => n.kind), noticeSent,
    );
    for (const kind of toPrepare) {
      const res = await prepareNotice(admin, f.id, kind, { actorId: null, manual: false, today });
      if (res.result === "created") {
        out.prepared.push(line(kind));
        mine.push(res.notice);
      }
    }

    for (const n of mine) {
      if (n.status === "failed") out.failed.push(line(n.kind, n.failure_reason ?? undefined));
      if (n.status === "draft") out.awaitingApproval.push(line(n.kind));
      if (noticeAttention(today, { kind: n.kind, status: n.status, sendOn: n.send_on }) === "late") {
        out.late.push(line(n.kind));
      }
      if (!isDueToSend(today, { status: n.status, sendOn: n.send_on })) continue;
      if (item.holds.length > 0) {
        out.heldBack.push(line(n.kind, item.holds.map((h) => h.label).join(", ")));
        continue;
      }
      const res = await sendNotice(admin, n.id, { actorId: null, source: "job" });
      if (res.ok) out.sent.push(line(n.kind));
      else out.failed.push(line(n.kind, res.error));
    }
  }
  return out;
}
