import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { formatCurrency } from "@/lib/utils";
import { HANDOFF_STATE_LABELS, type HandoffState } from "@/lib/tally-handoff";
import type { StatementTimelineEvent } from "@/types";

/**
 * GET /api/billing-statements/[id]/timeline
 *
 * The full, chronological history of one billing statement, merged from every
 * source that records an event against it:
 *
 *   1. lifecycle columns on billing_statements (created / finalized / proforma
 *      sent / PI cancelled / GST sent / exported / voided)
 *   2. billing_send_log        — proforma + GST invoice dispatches
 *   3. billing_reminder_sends  — the dunning ladder
 *   4. billing_payments        — money actually received
 *   5. gst_invoice_uploads     — Tally invoice handoff + name check
 *   6. audit_trail             — everything else, incl. handoff_state moves
 *
 * Replaces the send-only history that GET .../send-reminder returns. That
 * endpoint reads just sources 2 and 3, which meant a statement could show
 * "GST invoice sent" against an unpaid bill with nothing on screen explaining
 * why — the "convert to GST early" override that cancelled the PI lives in
 * audit_trail and was never surfaced. See TWV-BS-0167 for the case that
 * prompted this.
 *
 * Read-only. Auth is enforced on the caller's session; the reads themselves
 * use the admin client because audit_trail and the cross-table joins are not
 * uniformly covered by RLS. History is not sensitive — anyone who can see the
 * statement on AR can see how it got there.
 */
export const dynamic = "force-dynamic";

const VIEW_ROLES = ["admin", "manager", "accounts", "sales_rep", "office_admin"];

/** Human labels for billing_send_log.send_type. */
const SEND_TYPE_LABELS: Record<string, string> = {
  proforma: "Proforma invoice sent",
  gst_invoice: "GST invoice sent",
  receipt: "Receipt sent",
  reminder: "Reminder sent",
};

/**
 * audit_trail change keys that another source already renders more clearly.
 * `pi_cancelled_at` is covered by the lifecycle event, which also carries the
 * override reason — showing both would double up the single most important
 * line on the timeline.
 */
const AUDIT_SUPPRESSED_KEYS = ["pi_cancelled_at"];

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users").select("id, role").eq("auth_id", user.id).maybeSingle();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 404 });
  if (!VIEW_ROLES.includes(dbUser.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const admin = await createAdminClient();

  const { data: stmt } = await admin
    .from("billing_statements")
    .select(`
      id, statement_number, total_amount, created_at, finalized_at, finalized_by,
      proforma_sent_at, proforma_sent_by, proforma_viewed_at,
      pi_cancelled_at, pi_cancelled_by, pi_override_reason,
      gst_invoice_number, gst_invoice_sent_at, gst_invoice_sent_to, gst_invoice_viewed_at,
      exported_at, voided_at, voided_by, void_reason,
      emailed_to, tally_delivered_at, handoff_state, payment_status
    `)
    .eq("id", id)
    .maybeSingle();
  if (!stmt) return NextResponse.json({ error: "Statement not found" }, { status: 404 });

  const [sendLogRes, remindersRes, paymentsRes, uploadsRes, auditRes] = await Promise.all([
    admin.from("billing_send_log")
      .select("id, send_type, recipient, status, error, triggered_by, triggered_by_user_id, sent_at")
      .eq("billing_statement_id", id),
    admin.from("billing_reminder_sends")
      .select("id, stage_index, stage_label, channel, recipient, status, error, triggered_by, triggered_by_user_id, sent_at, opened_at")
      .eq("billing_statement_id", id),
    admin.from("billing_payments")
      .select("id, amount, tds_amount, payment_date, payment_mode, payment_reference, razorpay_payment_id, notes, recorded_by, created_at, tally_receipt_number")
      .eq("billing_statement_id", id),
    admin.from("gst_invoice_uploads")
      .select("id, tally_invoice_number, tally_invoice_series, invoice_date, invoice_amount, uploaded_by, uploaded_at, name_check_status, name_check_notes, superseded_by")
      .eq("billing_statement_id", id),
    admin.from("audit_trail")
      .select("id, action, changes, performed_by, created_at")
      .eq("entity_type", "billing_statement")
      .eq("entity_id", id),
  ]);

  // ── Resolve actor names ───────────────────────────────────────────────────
  // gst_invoice_uploads.uploaded_by stores the Supabase auth id rather than
  // users.id (unlike every other table here), so look up both columns and key
  // the map by each — otherwise the uploader renders as blank.
  const actorIds = Array.from(new Set([
    stmt.finalized_by, stmt.proforma_sent_by, stmt.pi_cancelled_by, stmt.voided_by,
    ...(sendLogRes.data || []).map((r) => r.triggered_by_user_id),
    ...(remindersRes.data || []).map((r) => r.triggered_by_user_id),
    ...(paymentsRes.data || []).map((r) => r.recorded_by),
    ...(uploadsRes.data || []).map((r) => r.uploaded_by),
    ...(auditRes.data || []).map((r) => r.performed_by),
  ].filter(Boolean))) as string[];

  const actorById = new Map<string, string>();
  if (actorIds.length > 0) {
    const [byId, byAuth] = await Promise.all([
      admin.from("users").select("id, auth_id, full_name, role").in("id", actorIds),
      admin.from("users").select("id, auth_id, full_name, role").in("auth_id", actorIds),
    ]);
    for (const u of [...(byId.data || []), ...(byAuth.data || [])]) {
      const label = u.role ? `${u.full_name} (${u.role})` : u.full_name;
      actorById.set(u.id, label);
      if (u.auth_id) actorById.set(u.auth_id, label);
    }
  }
  const actorName = (uid: string | null | undefined) =>
    uid ? actorById.get(uid) ?? null : null;

  const events: StatementTimelineEvent[] = [];
  const push = (e: Partial<StatementTimelineEvent> & { id: string; at: string; kind: StatementTimelineEvent["kind"]; label: string }) =>
    events.push({
      detail: null, channel: null, recipient: null, status: null,
      error: null, actor: null, amount: null, highlight: false, ...e,
    });

  // ── 1. Lifecycle milestones ───────────────────────────────────────────────
  const sendLog = sendLogRes.data || [];
  const hasSendLog = (type: string) => sendLog.some((r) => r.send_type === type);

  if (stmt.created_at) {
    push({
      id: `lc-created`, at: stmt.created_at, kind: "lifecycle",
      label: "Statement created",
      detail: formatCurrency(stmt.total_amount || 0),
    });
  }
  if (stmt.finalized_at) {
    push({
      id: `lc-finalized`, at: stmt.finalized_at, kind: "lifecycle",
      label: "Finalized", actor: actorName(stmt.finalized_by) ?? "System",
    });
  }
  // Only synthesise a send milestone when the send log has no matching row.
  // Historic rows predate billing_send_log, so without this the earliest
  // dispatch silently vanishes from the timeline.
  if (stmt.proforma_sent_at && !hasSendLog("proforma")) {
    push({
      id: `lc-proforma`, at: stmt.proforma_sent_at, kind: "send",
      label: "Proforma invoice sent", status: "sent",
      recipient: stmt.emailed_to, actor: actorName(stmt.proforma_sent_by) ?? "System",
      detail: "Reconstructed from statement record — predates the send log",
    });
  }
  if (stmt.proforma_viewed_at) {
    push({
      id: `lc-proforma-viewed`, at: stmt.proforma_viewed_at, kind: "lifecycle",
      label: "Proforma viewed by customer", status: "opened",
    });
  }
  if (stmt.pi_cancelled_at) {
    push({
      id: `lc-pi-cancelled`, at: stmt.pi_cancelled_at, kind: "lifecycle",
      label: "Proforma cancelled — GST invoice issued early (override)",
      detail: stmt.pi_override_reason
        ? `Reason: ${stmt.pi_override_reason}`
        : "No reason recorded",
      actor: actorName(stmt.pi_cancelled_by),
      highlight: true,
    });
  }
  if (stmt.gst_invoice_sent_at && !hasSendLog("gst_invoice")) {
    push({
      id: `lc-gst-sent`, at: stmt.gst_invoice_sent_at, kind: "send",
      label: "GST invoice sent", status: "sent",
      recipient: stmt.gst_invoice_sent_to || stmt.emailed_to,
      detail: stmt.gst_invoice_number ? `Invoice ${stmt.gst_invoice_number}` : null,
    });
  }
  // Older rows recorded the GST dispatch only as tally_delivered_at, with no
  // send-log row and no gst_invoice_sent_at — without this fallback the
  // customer-facing dispatch is missing from the timeline entirely.
  if (stmt.tally_delivered_at && !stmt.gst_invoice_sent_at && !hasSendLog("gst_invoice")) {
    push({
      id: `lc-tally-delivered`, at: stmt.tally_delivered_at, kind: "send",
      label: "GST invoice delivered to customer", status: "sent",
      recipient: stmt.emailed_to,
      detail: stmt.gst_invoice_number ? `Invoice ${stmt.gst_invoice_number}` : null,
    });
  }
  if (stmt.gst_invoice_viewed_at) {
    push({
      id: `lc-gst-viewed`, at: stmt.gst_invoice_viewed_at, kind: "lifecycle",
      label: "GST invoice viewed by customer", status: "opened",
    });
  }
  if (stmt.exported_at) {
    push({ id: `lc-exported`, at: stmt.exported_at, kind: "lifecycle", label: "Exported to accounts" });
  }
  if (stmt.voided_at) {
    push({
      id: `lc-voided`, at: stmt.voided_at, kind: "lifecycle", label: "Statement voided",
      detail: stmt.void_reason, actor: actorName(stmt.voided_by), highlight: true,
    });
  }

  // ── 2. Send log ───────────────────────────────────────────────────────────
  for (const r of sendLog) {
    push({
      id: `send-${r.id}`, at: r.sent_at, kind: "send",
      label: SEND_TYPE_LABELS[r.send_type] ?? `${r.send_type} sent`,
      channel: "email", recipient: r.recipient,
      status: r.status, error: r.error,
      actor: r.triggered_by === "cron"
        ? "Cron"
        : actorName(r.triggered_by_user_id) ?? "Manual",
    });
  }

  // ── 3. Reminder ladder ────────────────────────────────────────────────────
  for (const r of remindersRes.data || []) {
    push({
      id: `rem-${r.id}`, at: r.sent_at, kind: "reminder",
      label: r.stage_label ? `Reminder — ${r.stage_label}` : "Reminder sent",
      channel: r.channel, recipient: r.recipient,
      status: r.opened_at ? "opened" : r.status, error: r.error,
      actor: r.triggered_by === "cron"
        ? "Cron"
        : actorName(r.triggered_by_user_id) ?? "Manual",
    });
  }

  // ── 4. Payments ───────────────────────────────────────────────────────────
  for (const p of paymentsRes.data || []) {
    const bits = [
      p.payment_mode?.replace(/_/g, " "),
      p.payment_reference ? `ref ${p.payment_reference}` : null,
      p.razorpay_payment_id ? `razorpay ${p.razorpay_payment_id}` : null,
      p.tds_amount ? `TDS ${formatCurrency(p.tds_amount)}` : null,
      p.tally_receipt_number ? `Tally receipt ${p.tally_receipt_number}` : null,
      p.notes,
    ].filter(Boolean);
    push({
      // Payments are dated by payment_date (a date, not a timestamp), so fall
      // back to created_at for correct ordering against same-day events.
      id: `pay-${p.id}`, at: p.created_at || p.payment_date, kind: "payment",
      label: "Payment recorded",
      amount: p.amount, detail: bits.join(" · ") || null,
      status: "ok", actor: actorName(p.recorded_by),
    });
  }

  // ── 5. Tally GST invoice uploads ──────────────────────────────────────────
  for (const u of uploadsRes.data || []) {
    const bits = [
      u.tally_invoice_series ? `series ${u.tally_invoice_series}` : null,
      u.invoice_date ? `invoice dated ${u.invoice_date}` : null,
      u.invoice_amount != null ? formatCurrency(u.invoice_amount) : null,
      u.name_check_status ? `name check ${u.name_check_status}` : null,
      u.name_check_notes,
      u.superseded_by ? "superseded by a later upload" : null,
    ].filter(Boolean);
    push({
      id: `gst-${u.id}`, at: u.uploaded_at, kind: "gst",
      label: `Tally GST invoice uploaded${u.tally_invoice_number ? ` — ${u.tally_invoice_number}` : ""}`,
      detail: bits.join(" · ") || null,
      actor: actorName(u.uploaded_by),
    });
  }

  // ── 6. Audit trail ────────────────────────────────────────────────────────
  for (const a of auditRes.data || []) {
    const changes = (a.changes || {}) as Record<string, { old: unknown; new: unknown }>;
    const keys = Object.keys(changes).filter((k) => k !== "_actor_label" && k !== "trigger");
    if (keys.some((k) => AUDIT_SUPPRESSED_KEYS.includes(k))) continue;

    // A handoff move is the clearest signal of where the statement sat in the
    // accounts workflow, so give it a first-class label instead of a diff.
    const handoff = changes.handoff_state;
    let label: string;
    let highlight = false;
    if (handoff) {
      const to = HANDOFF_STATE_LABELS[handoff.new as HandoffState] ?? String(handoff.new);
      label = `Workflow → ${to}`;
      highlight = handoff.new === "direct_gst_requested";
    } else if (a.action !== "update") {
      label = a.action.replace(/_/g, " ").replace(/^./, (c: string) => c.toUpperCase());
    } else {
      label = keys.length ? `Updated: ${keys.map((k) => k.replace(/_/g, " ")).join(", ")}` : "Updated";
    }

    const trigger = (changes.trigger?.new ?? changes.trigger?.old) as string | undefined;
    const actorLabel = changes._actor_label?.new as string | undefined;

    push({
      id: `aud-${a.id}`, at: a.created_at, kind: "audit", label,
      detail: trigger ? `via ${trigger.replace(/_/g, " ")}` : null,
      actor: actorName(a.performed_by) ?? actorLabel ?? "System",
      highlight,
    });
  }

  events.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());

  return NextResponse.json({
    events,
    statement: {
      id: stmt.id,
      statement_number: stmt.statement_number,
      handoff_state: stmt.handoff_state,
      payment_status: stmt.payment_status,
    },
  });
}
