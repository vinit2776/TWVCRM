import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/server";
import {
  generateRenewalPI,
  logRenewalReminder,
  sendRenewalEmail,
  sendRenewalWhatsApp,
  type VoCaseForRenewal,
} from "@/lib/vo-renewal";
import { generateDiscontinuationDraftsForCase } from "@/lib/vo-discontinuation";
import { resend, EMAIL_FROM } from "@/lib/mailer";
import { withCronHealth } from "@/lib/cron-ping";
import { renewalRecipients } from "@/lib/renewal-recipients";
import { getCachedSettings } from "@/lib/app-settings-cache";
import {
  VO_RENEWAL_GRACE_DAYS_SETTING,
  graceEndsAtFor,
  parseGraceDays,
} from "@/lib/vo-renewal-desk";
import { latestLapseDecision } from "@/lib/vo-lapse-decision";
import { addDays } from "@/lib/vo-renewal-term";
import {
  ATTENTION_LABELS,
  FINAL_NOTICE_STAGE,
  VO_RENEWAL_CRON_MODE_SETTING,
  classifyRenewalCase,
  parseCronMode,
  partnerRenewalRecord,
  type AttentionReason,
  type CronAction,
  type CronCaseFacts,
} from "@/lib/vo-renewal-reminders";
import { rollPartnerRenewal } from "@/lib/vo-partner-renewal";

/**
 * VO Renewal cron — daily 09:30 IST. Chases renewals that a person has
 * already started; it never opens one.
 *
 * What it does, per opted-in case (cases.renewal_notices_enabled, set one case
 * at a time by an admin once the end date is confirmed):
 *
 *   - renewal_due, notified, end date ahead: the next reminder (2 at 21 days,
 *     3 at 14, 4 at 7) on the SAME payment link Start renewal made. Stages are
 *     "due and not yet sent", so a missed run is caught up, never skipped.
 *   - renewal_due, end date reached: the final notice, and the case enters
 *     grace for the configured number of days.
 *   - grace_period, grace over: lapsed, discontinuation drafts prepared (a
 *     person reviews and sends them), admin and accounts told.
 *   - postpaid partner case with a recorded confirmation, new term reached:
 *     rolled into its next term (no bill, no customer contact).
 *
 * What it will not do: contact a customer who was never sent a first notice,
 * lapse a case nobody was told about, change the status of a postpaid partner
 * case, create a bill or payment link, or touch a case that is not opted in.
 * Anything that needs a person lands in the internal digest instead.
 *
 * MODE (app_settings.vo_renewal_cron_mode, Settings → Virtual office):
 *   off      does nothing
 *   dry_run  (default; anything unrecognised means this) emails the internal
 *            digest of what it WOULD do and changes nothing
 *   live     acts, and sends the digest as well
 * A request can only make a run more cautious (?dry_run=1 turns live into a
 * dry run); nothing in the URL can turn a dry run live. An earlier hand-typed
 * flag that defaulted the wrong way once emailed 20 real customers.
 */

const LIVE_STATUSES = ["active", "renewal_due", "grace_period"];
const DIGEST_RECIPIENTS = ["admin@theworkvilla.com", "accounts@theworkvilla.com"];

// Every renewal query joins the aggregator — without it renewalRecipients()
// cannot tell a partner-billed case from a direct one, and every notice
// defaults to the end client.
const CASE_SELECT =
  "*, location:locations!cases_location_id_fkey(name, address, city, state), aggregator:aggregators!cases_aggregator_id_fkey(name, billing_method, primary_email, primary_phone)";

type CaseRow = VoCaseForRenewal & {
  status: string;
  metadata?: unknown;
  renewal_notices_enabled: boolean;
  renewal_last_reminder_at: string | null;
  renewal_reminder_count: number;
  renewal_grace_ends_at: string | null;
  renewal_razorpay_link_url: string | null;
  renewal_razorpay_link_id: string | null;
  renewal_billing_statement_id: string | null;
};

interface StatementRow {
  id: string;
  reference_note: string | null;
  period_start: string;
  period_end: string;
  due_date: string | null;
  fixed_amount: number;
  total_amount: number;
  payment_status: string;
  voided_at: string | null;
  statement_type: string;
}

async function handler(request: Request) {
  const authHeader = request.headers.get("Authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const admin = await createAdminClient();
  const today = getTodayIST();
  const nowIso = new Date().toISOString();

  const settings = await getCachedSettings(admin, [VO_RENEWAL_CRON_MODE_SETTING, VO_RENEWAL_GRACE_DAYS_SETTING]);
  let mode = parseCronMode(settings[VO_RENEWAL_CRON_MODE_SETTING]);
  const graceDays = parseGraceDays(settings[VO_RENEWAL_GRACE_DAYS_SETTING]);
  // The URL can only make a run more cautious.
  if (new URL(request.url).searchParams.get("dry_run") === "1" && mode === "live") mode = "dry_run";

  if (mode === "off") {
    return NextResponse.json({ success: true, date: today, mode, skipped: "vo_renewal_cron_mode is off" });
  }
  const live = mode === "live";

  const results = {
    mode,
    reminders: [] as string[],
    finalNotices: [] as string[],
    lapsed: [] as string[],
    partnerRolled: [] as string[],
    skipped: [] as string[],
    errors: [] as string[],
    attention: {} as Record<AttentionReason, string[]>,
    notOptedIn: 0,
    noEndDate: 0,
  };

  const { data: rows, error: readError } = await admin.from("cases").select(CASE_SELECT).in("status", LIVE_STATUSES);
  if (readError) {
    return NextResponse.json({ success: false, error: readError.message }, { status: 500 });
  }
  const cases = (rows ?? []) as unknown as CaseRow[];

  const statementIds = cases
    .filter((c) => c.status === "renewal_due" && c.renewal_billing_statement_id)
    .map((c) => c.renewal_billing_statement_id as string);
  const statements = new Map<string, StatementRow>();
  if (statementIds.length > 0) {
    const { data: stmts } = await admin
      .from("billing_statements")
      .select("id, reference_note, period_start, period_end, due_date, fixed_amount, total_amount, payment_status, voided_at, statement_type")
      .in("id", statementIds);
    for (const s of (stmts ?? []) as StatementRow[]) statements.set(s.id, s);
  }

  for (const c of cases) {
    if (!c.end_date) {
      results.noEndDate++;
      continue;
    }
    if (!c.renewal_notices_enabled) {
      results.notOptedIn++;
      continue;
    }

    const stmt = c.renewal_billing_statement_id ? statements.get(c.renewal_billing_statement_id) : undefined;
    const partnerIntent = partnerRenewalRecord(c.metadata);
    const facts: CronCaseFacts = {
      status: c.status,
      end_date: c.end_date,
      renewal_notices_enabled: c.renewal_notices_enabled,
      postpaid: !!c.aggregator_id && c.aggregator?.billing_method === "postpaid",
      renewal_reminder_count: c.renewal_reminder_count ?? 0,
      renewal_last_reminder_at: c.renewal_last_reminder_at,
      renewal_grace_ends_at: c.renewal_grace_ends_at,
      has_open_bill:
        !!stmt &&
        stmt.statement_type === "vo_renewal" &&
        !stmt.voided_at &&
        stmt.payment_status !== "paid" &&
        !!c.renewal_razorpay_link_url,
      partner_intent: partnerIntent,
      lapse_decision: latestLapseDecision(c.metadata)?.decision ?? null,
    };

    const action = classifyRenewalCase(facts, today, nowIso);
    if (action.kind === "none") continue;
    if (action.kind === "attention") {
      (results.attention[action.reason] ??= []).push(label(c));
      continue;
    }

    try {
      await execute(admin, c, stmt, action, { live, today, graceDays, results });
    } catch (err) {
      results.errors.push(`${action.kind}:${c.case_number}:${err instanceof Error ? err.message : String(err)}`);
    }
  }

  await sendDigest(results, live, today);

  console.log("[cron/vo-renewal] Result:", JSON.stringify({ ...results, attention: summarise(results.attention) }));
  return NextResponse.json({ success: true, date: today, ...results });
}

// ---------------------------------------------------------------------------
// Executing a decision
// ---------------------------------------------------------------------------

interface Ctx {
  live: boolean;
  today: string;
  graceDays: number;
  results: {
    reminders: string[];
    finalNotices: string[];
    lapsed: string[];
    partnerRolled: string[];
    skipped: string[];
    errors: string[];
  };
}

async function execute(
  admin: SupabaseClient,
  c: CaseRow,
  stmt: StatementRow | undefined,
  action: Exclude<CronAction, { kind: "none" } | { kind: "attention"; reason: AttentionReason }>,
  ctx: Ctx,
) {
  const { live, today, graceDays, results } = ctx;

  if (action.kind === "partner_roll") {
    if (!live) {
      results.partnerRolled.push(`${c.case_number} (would roll into its confirmed new term)`);
      return;
    }
    const out = await rollPartnerRenewal(admin, { caseId: c.id, performedBy: null, today });
    if (out.outcome === "renewed") results.partnerRolled.push(c.case_number);
    else if (out.outcome === "already_renewed") results.skipped.push(`${c.case_number}: already rolled`);
    else results.errors.push(`partner_roll:${c.case_number}: ${out.message}`);
    return;
  }

  if (action.kind === "lapse") {
    if (!live) {
      results.lapsed.push(`${c.case_number} (would lapse and prepare discontinuation drafts)`);
      return;
    }
    // Drafts first: a case must never be lapsed with nothing for staff to review.
    const { count } = await admin
      .from("vo_discontinuation_documents")
      .select("id", { count: "exact", head: true })
      .eq("case_id", c.id);
    if (!count) await generateDiscontinuationDraftsForCase(admin, c as unknown as Record<string, unknown>, c.end_date);

    const { data: moved } = await admin
      .from("cases")
      .update({ status: "lapsed", lapsed_at: new Date().toISOString(), renewal_grace_ends_at: null })
      .eq("id", c.id)
      .eq("status", "grace_period")
      .select("id");
    if (!moved || moved.length === 0) {
      results.skipped.push(`${c.case_number}: changed while lapsing`);
      return;
    }
    await resend.emails.send({
      from: EMAIL_FROM,
      to: DIGEST_RECIPIENTS,
      subject: `[Action Required] VO Case Lapsed — ${c.case_number} — ${c.client_name}`,
      html: `
        <p>The Virtual Office Agreement for <strong>${esc(c.client_company_name || c.client_name)}</strong> (Case: ${esc(c.case_number)}) has lapsed after the grace period with no renewal.</p>
        <p>Nothing has been sent to the client. The discontinuation documents are drafts waiting for review:</p>
        <p><a href="${appUrl()}/cases/${c.id}?tab=renewal">Open the case's Renewal tab</a> to review and approve them, or to record that the client has paid.</p>
      `,
    });
    results.lapsed.push(c.case_number);
    return;
  }

  // reminder | final_notice — both chase the existing bill on its existing link.
  const isFinal = action.kind === "final_notice";
  const stage = action.kind === "reminder" ? action.stage : FINAL_NOTICE_STAGE;
  const bucket = isFinal ? results.finalNotices : results.reminders;
  const tag = isFinal ? "final notice" : `reminder ${stage}`;

  if (!live) {
    bucket.push(`${c.case_number} (would send ${tag})`);
    return;
  }
  if (!stmt || !c.renewal_razorpay_link_url) {
    results.errors.push(`${c.case_number}: no open bill or payment link to chase`);
    return;
  }
  if (await hasPaymentActivity(admin, stmt.id)) {
    results.skipped.push(`${c.case_number}: a payment is recorded or reported against the bill — not chasing`);
    return;
  }

  const routing = renewalRecipients(c);
  if (routing.blocked) {
    results.errors.push(`${c.case_number}: ${routing.blocked}`);
    return;
  }
  if (!routing.billing.email && !routing.billing.phone) {
    results.errors.push(`${c.case_number}: no email or phone on file for ${routing.billing.name} — ${tag} not sent`);
    return;
  }

  const piNumber = stmt.reference_note || `TWV-PI-${c.case_number.replace(/\D/g, "")}`;
  const totalAmount = Number(stmt.total_amount);
  const link = c.renewal_razorpay_link_url;
  const dueDate = stmt.due_date ?? c.end_date;
  const pdfBuffer = generateRenewalPI({
    caseData: c,
    piNumber,
    periodStart: stmt.period_start,
    periodEnd: stmt.period_end,
    dueDate,
    razorpayUrl: link,
    subtotal: Number(stmt.fixed_amount),
  });
  const notice = {
    caseData: c,
    reminderNumber: stage,
    isGraceNotice: isFinal,
    piNumber,
    periodStart: stmt.period_start,
    periodEnd: stmt.period_end,
    totalAmount,
    razorpayUrl: link,
  };

  // The end client hears too when a partner is billed, but only once it is
  // getting close (the 7-day reminder and the final notice).
  if (stage >= 4 && routing.headsUp?.email) {
    await sendRenewalEmail({ ...notice, recipient: routing.headsUp });
  }
  const [emailSent, whatsAppSent] = await Promise.all([
    sendRenewalEmail({ ...notice, recipient: routing.billing, pdfBuffer }),
    sendRenewalWhatsApp({
      caseData: c,
      recipient: routing.billing,
      isGraceNotice: isFinal,
      piNumber,
      totalAmount,
      razorpayUrl: link,
      pdfBuffer,
      supabase: admin,
    }),
  ]);

  // Nothing got through: leave the case where it is so tomorrow's run tries
  // again, and never let an unsent notice move a case toward lapse.
  if (!emailSent && !whatsAppSent) {
    results.errors.push(`${c.case_number}: ${tag} could not be delivered on any channel — will retry`);
    return;
  }

  if (stage === 4) {
    await resend.emails.send({
      from: EMAIL_FROM,
      to: ["accounts@theworkvilla.com"],
      subject: `[Action Required] VO Renewal Final Reminder — ${c.case_number}`,
      html: `<p>Case <strong>${esc(c.case_number)}</strong> (${esc(c.client_name)}) has not renewed. This is the 4th and last reminder before the end date, <strong>${esc(c.end_date)}</strong>.</p>`,
    });
  }

  const update: Record<string, unknown> = {
    renewal_reminder_count: stage,
    renewal_last_reminder_at: new Date().toISOString(),
  };
  if (isFinal) {
    update.status = "grace_period";
    update.renewal_grace_ends_at = graceEndsAtFor(addDays(today, graceDays));
  }
  const { data: updated } = await admin
    .from("cases")
    .update(update)
    .eq("id", c.id)
    .eq("status", c.status)
    .select("id");
  if (!updated || updated.length === 0) {
    results.skipped.push(`${c.case_number}: changed while sending ${tag}`);
  }

  await logRenewalReminder({
    adminSupabase: admin,
    caseId: c.id,
    reminderNumber: stage,
    statementId: stmt.id,
    razorpayLinkId: c.renewal_razorpay_link_id ?? "",
    razorpayLinkUrl: link,
    emailSent,
    whatsAppSent,
    isGraceNotice: isFinal,
  });
  bucket.push(`${c.case_number}:${isFinal ? "final" : `R${stage}`}`);
}

/** Money already recorded or reported against the bill means someone is handling it. */
async function hasPaymentActivity(admin: SupabaseClient, statementId: string): Promise<boolean> {
  const [payments, reports] = await Promise.all([
    admin.from("billing_payments").select("id", { count: "exact", head: true }).eq("billing_statement_id", statementId),
    admin
      .from("query_payment_reports")
      .select("id", { count: "exact", head: true })
      .eq("claimed_statement_id", statementId)
      .eq("status", "reported"),
  ]);
  return (payments.count ?? 0) > 0 || (reports.count ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// Internal digest
// ---------------------------------------------------------------------------

function label(c: CaseRow): string {
  return `${c.case_number} — ${c.client_company_name || c.client_name} (ends ${c.end_date})`;
}

function summarise(a: Record<string, string[]>): Record<string, number> {
  return Object.fromEntries(Object.entries(a).map(([k, v]) => [k, v.length]));
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function appUrl(): string {
  return process.env.NEXT_PUBLIC_APP_URL || "";
}

async function sendDigest(
  results: {
    mode: string;
    reminders: string[];
    finalNotices: string[];
    lapsed: string[];
    partnerRolled: string[];
    skipped: string[];
    errors: string[];
    attention: Record<AttentionReason, string[]>;
    notOptedIn: number;
    noEndDate: number;
  },
  live: boolean,
  today: string,
) {
  const attentionKeys = Object.keys(results.attention) as AttentionReason[];
  const did = [...results.reminders, ...results.finalNotices, ...results.lapsed, ...results.partnerRolled];
  if (did.length === 0 && attentionKeys.length === 0 && results.errors.length === 0 && results.skipped.length === 0) return;
  // A "needs a person" list that has not changed would repeat every morning,
  // so on a day with nothing done and nothing wrong it goes out on Mondays only.
  const isMonday = new Date(`${today}T00:00:00Z`).getUTCDay() === 1;
  if (did.length === 0 && results.errors.length === 0 && results.skipped.length === 0 && !isMonday) return;

  const list = (title: string, items: string[]) =>
    items.length
      ? `<h3 style="margin:16px 0 4px;font-size:14px">${esc(title)} (${items.length})</h3><ul style="margin:0;padding-left:18px;font-size:13px">${items
          .slice(0, 40)
          .map((i) => `<li>${esc(i)}</li>`)
          .join("")}${items.length > 40 ? `<li>…and ${items.length - 40} more</li>` : ""}</ul>`
      : "";

  const banner = live
    ? ""
    : `<p style="background:#fffbeb;border:1px solid #fcd34d;padding:8px 12px;font-size:13px"><strong>Dry run.</strong> Nothing was sent to a customer and no case was changed. Lines marked “would” are what a live run does. Switch the mode in Settings → Virtual office when the digests look right.</p>`;

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:640px;color:#1a1a1a">
      <h2 style="font-size:16px">Virtual office renewals — ${esc(today)}</h2>
      ${banner}
      ${list(live ? "Reminders sent" : "Reminders it would send", results.reminders)}
      ${list(live ? "Final notices sent" : "Final notices it would send", results.finalNotices)}
      ${list(live ? "Partner cases rolled into their new term" : "Partner cases it would roll", results.partnerRolled)}
      ${list(live ? "Lapsed" : "Cases it would lapse", results.lapsed)}
      ${attentionKeys.map((k) => list(`Needs a person — ${ATTENTION_LABELS[k]}`, results.attention[k])).join("")}
      ${list("Held back", results.skipped)}
      ${list("Errors", results.errors)}
      <p style="font-size:12px;color:#6b7280;margin-top:18px">
        ${results.notOptedIn} live case${results.notOptedIn === 1 ? " is" : "s are"} not opted in to automatic reminders${results.noEndDate ? `; ${results.noEndDate} have no end date` : ""}.
        <a href="${appUrl()}/cases/renewals">Open the Renewals desk</a>
      </p>
    </div>`;

  try {
    await resend.emails.send({
      from: EMAIL_FROM,
      to: DIGEST_RECIPIENTS,
      subject: `${live ? "" : "[Dry run] "}Virtual office renewals — ${today}`,
      html,
    });
  } catch (err) {
    console.error("[cron/vo-renewal] digest email failed:", err);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getTodayIST(): string {
  // toLocaleDateString, not toLocaleString round-tripped through new Date().
  // en-CA's date-time form is "2026-08-22, 9:47:31 p.m.", which Date cannot
  // parse — it yields Invalid Date and .toISOString() throws RangeError,
  // killing this cron on its first line of work before it reads a single
  // case. cron_health recorded exactly that. The date-only form returns
  // "2026-08-22" directly, with no parsing round-trip to get wrong.
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

export const GET = withCronHealth("cron/vo-renewal", handler);
