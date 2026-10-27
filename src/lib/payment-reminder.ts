/**
 * Shared payment-reminder dispatcher.
 *
 * Both /api/cron/payment-reminder (daily ladder cron) and
 * /api/billing-statements/[id]/send-reminder (manual "Send Reminder Now"
 * button on the AR page) call into this so:
 *   • the ladder definition lives in exactly one place
 *   • every reminder send is logged to billing_reminder_sends regardless of
 *     trigger source, giving accounts a single "what have we sent this
 *     customer?" history
 *   • Razorpay link refresh logic is shared
 *
 * Returns a per-statement summary the caller can use for response payloads.
 */

import { RAZORPAY_MAX_LINK_VALIDITY_SECONDS } from "@/lib/constants";
import type { SupabaseClient } from "@supabase/supabase-js";
import { resend, EMAIL_FROM, EMAIL_REPLY_TO } from "@/lib/mailer";
import { messaging } from "@/lib/whatsapp";
import { getCachedSettings } from "@/lib/app-settings-cache";
import { totalPaid as settlementTotalPaid, balanceDue as settlementBalanceDue, settlementAmount } from "@/lib/settlement";
import { fetchInvoiceAttachment, type ReminderAttachment } from "@/lib/reminder-invoice-attachment";
import { splitAttachable } from "@/lib/reminder-consolidation";

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

export interface Stage {
  /** Days past due_date that qualify this stage. */
  day: number;
  /** Human label shown in subject + body + history log. */
  toneLabel: string;
  subject: (ref: string, dueDesc: string, amount: string) => string;
  /** Opening sentence of the email body. */
  /**
   * Body copy. May contain the `{doc}` placeholder for the customer-facing
   * document noun — "tax invoice" once a GST invoice has been issued against
   * the statement, "proforma" otherwise. Callers must substitute it; see
   * `resolveIntro`.
   */
  intro: string;
  ccAccounts: boolean;
  ccManagerAndAdmin: boolean;
  whatsApp: boolean;
  /**
   * Optional re-fire cadence (days). If set, the cron MAY send this stage
   * again after `reminder_count` has already advanced past it, as long as
   * `last_reminder_sent_at` is at least this many days old. Use on the
   * terminal stage so reminders continue perpetually until payment lands
   * or the statement is voided. Manual collections runs in parallel.
   */
  perpetualEveryDays?: number;
}

export const STAGES: Stage[] = [
  {
    day: 0, toneLabel: "Friendly reminder",
    subject: (ref, _due, amt) => `Payment due today — ${ref} · ₹${amt}`,
    intro: "Just a friendly note that the payment for the {doc} below is due today. We'd appreciate it if you could settle it at your convenience.",
    ccAccounts: false, ccManagerAndAdmin: false, whatsApp: false,
  },
  {
    day: 3, toneLabel: "Gentle reminder",
    subject: (ref, due, amt) => `Reminder — ${ref} now ${due} overdue · ₹${amt}`,
    intro: "A gentle reminder that the payment for the {doc} below is still pending. Please process at your earliest convenience.",
    ccAccounts: false, ccManagerAndAdmin: false, whatsApp: true,
  },
  {
    day: 7, toneLabel: "Firm reminder",
    subject: (ref, _due, amt) => `Overdue — ${ref} · ₹${amt}`,
    intro: "The payment for the {doc} below is now overdue. Kindly arrange settlement at the earliest. Our accounts team has been copied on this email.",
    ccAccounts: true, ccManagerAndAdmin: false, whatsApp: true,
  },
  {
    day: 14, toneLabel: "Escalation",
    subject: (ref, _due, amt) => `URGENT: Payment overdue — ${ref} · ₹${amt}`,
    // Management is silently CC'd on this stage and above (see ccManagerAndAdmin
    // below). The customer-facing body deliberately does NOT mention this —
    // disclosing internal escalation paths reduces the urgency lever for
    // subsequent stages and can come across as performative.
    intro: "This payment is now significantly overdue. Please clear the balance at the earliest, or write back if there is a specific issue we can help resolve. We'd appreciate a response either way so we can plan accordingly.",
    ccAccounts: true, ccManagerAndAdmin: true, whatsApp: true,
  },
  {
    day: 21, toneLabel: "Checking in",
    subject: (ref, _due, amt) => `Checking in — ${ref} · ₹${amt}`,
    intro: "We've sent a few reminders about this payment and haven't heard back yet. We'd really appreciate a quick reply — even just to let us know when we can expect settlement, or if there's something we can help resolve. Our accounts team is available if you'd like to discuss.",
    ccAccounts: true, ccManagerAndAdmin: true, whatsApp: true,
  },
  {
    day: 30, toneLabel: "Continued follow-up",
    subject: (ref, due, amt) => `Payment still pending — ${ref} (${due} overdue) · ₹${amt}`,
    intro: "The payment for the {doc} below has been outstanding for some time despite multiple reminders. Our accounts team is also reaching out separately. We'd really appreciate it if you could close this out, or reply to let us know when we can expect settlement.",
    ccAccounts: true, ccManagerAndAdmin: true, whatsApp: true,
    // Re-fires every 3 days perpetually until the statement is paid or voided.
    // Manual collections (calls, in-person visits) runs in parallel — this
    // is the steady automated drumbeat.
    perpetualEveryDays: 3,
  },
];

/**
 * Fill the `{doc}` placeholder in a stage intro.
 *
 * A statement that has had a GST invoice issued against it is, to the
 * customer, a tax invoice — chasing it as a "proforma" names a document they
 * were never sent. Deposits and ad-hoc PIs are always proformas.
 */
export function resolveIntro(intro: string, docNoun: string): string {
  return intro.replace(/\{doc\}/g, docNoun);
}

/** Highest stage index that applies given days-past-due, or -1 if pre-due. */
export function pickStageIndex(daysOverdue: number): number {
  let best = -1;
  for (let i = 0; i < STAGES.length; i++) {
    if (daysOverdue >= STAGES[i].day) best = i;
  }
  return best;
}

export function fmtINR(n: number): string {
  return Math.round(n).toLocaleString("en-IN", { maximumFractionDigits: 0 });
}

export function fmtDate(ymd: string): string {
  return new Date(ymd + "T00:00:00").toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric" });
}

export function daysOverdueFromDueDate(dueDateYmd: string): number {
  const todayIst = new Date(Date.now() + IST_OFFSET_MS).toISOString().slice(0, 10);
  const todayMs = Date.parse(todayIst + "T00:00:00Z");
  const dueMs = Date.parse(dueDateYmd + "T00:00:00Z");
  return Math.floor((todayMs - dueMs) / 86400000);
}

/** Never-reminded first, then longest since last reminder. */
export function byLeastRecentlyReminded<T extends { last_reminder_sent_at?: string | null }>(a: T, b: T) {
  const ta = a.last_reminder_sent_at ? Date.parse(a.last_reminder_sent_at) : 0;
  const tb = b.last_reminder_sent_at ? Date.parse(b.last_reminder_sent_at) : 0;
  return ta - tb;
}

/** The delivery stamps a statement can carry, one per issuance path. */
export interface DeliveryMarkers {
  /** Proforma First — stamped by dispatchProforma only on a successful send. */
  proforma_sent_at?: string | null;
  /** GST Direct (CRM-issued) — stamped by dispatchGstDirect when the mail goes out. */
  emailed_at?: string | null;
  /** Tally-issued — stamped when accounts send the invoice from /accounting/inbox. */
  tally_delivered_at?: string | null;
}

/**
 * Did this statement actually reach the customer?
 *
 * Never infer delivery from `status`. A statement is finalized BEFORE it is
 * dispatched, so a failed send (Razorpay down, mail rejected, a crash between
 * the two) leaves a finalized, due-dated statement that the customer has never
 * seen. Dunning on status alone chases people for an invoice they never got.
 *
 * Each issuance path stamps its own marker on success and leaves it NULL on
 * failure, so the presence of any one of them is the only honest evidence:
 *   • Proforma First      → proforma_sent_at
 *   • GST Direct (CRM)    → emailed_at
 *   • Tally-issued        → tally_delivered_at
 *
 * A statement with none of them is not necessarily lost — it may have been
 * sent by hand outside the CRM — so callers must surface these rather than
 * drop them silently. They need a human, not a reminder.
 */
export function hasReachedCustomer(s: DeliveryMarkers): boolean {
  return Boolean(s.proforma_sent_at) || Boolean(s.emailed_at) || Boolean(s.tally_delivered_at);
}

/**
 * Refreshes the Razorpay link if expired/missing; returns a working URL or
 * null if Razorpay is disabled / call failed. Persists the new id+url on the
 * statement so subsequent reminders reuse it.
 */
export async function ensureLivePaymentLink(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  admin: SupabaseClient, statement: any, contract: any, lead: any, appUrl: string,
  partyRef?: string,
): Promise<string | null> {
  const settings = await getCachedSettings(admin, [
    "razorpay_key_id",
    "razorpay_key_secret",
    "razorpay_enabled",
  ]);
  if (settings["razorpay_enabled"] !== "true" || !settings["razorpay_key_id"] || !settings["razorpay_key_secret"]) return null;
  const auth = Buffer.from(`${settings["razorpay_key_id"]}:${settings["razorpay_key_secret"]}`).toString("base64");

  const existingId = statement.razorpay_payment_link_id as string | undefined;
  const existingUrl = statement.razorpay_payment_link_url as string | undefined;
  if (existingId) {
    try {
      const res = await fetch(`https://api.razorpay.com/v1/payment_links/${existingId}`, { headers: { Authorization: `Basic ${auth}` } });
      if (res.ok) {
        const data = await res.json() as { status?: string; short_url?: string };
        if (data.status === "created") return data.short_url || existingUrl || null;
      }
    } catch (err) {
      console.error("[payment-reminder] link status check failed:", err);
    }
  }

  const refId = `bs_${statement.id}_r${statement.reminder_count || 0}`;
  const customerName = lead?.company || `${lead?.first_name || ""} ${lead?.last_name || ""}`.trim() || "Customer";
  const phone = (lead?.mobile || lead?.phone || "").replace(/\s/g, "");
  const email = lead?.email || "";
  const ref = partyRef ?? contract?.contract_number ?? "";

  const payload: Record<string, unknown> = {
    // Defensive rupee-rounding — total_amount should already be a whole rupee,
    // but this guards against any stale/unrounded value ever landing on the row.
    amount: Math.round(Number(statement.total_amount)) * 100,
    currency: "INR",
    accept_partial: false,
    description: `${statement.statement_number} — ${ref}`,
    reference_id: refId,
    expire_by: Math.floor(Date.now() / 1000) + RAZORPAY_MAX_LINK_VALIDITY_SECONDS,
    notify: { sms: !!phone, email: !!email },
    reminder_enable: true,
    notes: { statement_id: statement.id, contract_number: ref, reminder_regen: "true" },
    callback_url: `${appUrl}/billing`,
    callback_method: "get",
  };
  if (customerName || email || phone) {
    payload.customer = {
      ...(customerName ? { name: customerName } : {}),
      ...(email ? { email } : {}),
      ...(phone ? { contact: phone } : {}),
    };
  }

  try {
    const rzpRes = await fetch("https://api.razorpay.com/v1/payment_links", {
      method: "POST",
      headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!rzpRes.ok) {
      console.error("[payment-reminder] create link failed:", await rzpRes.text());
      return existingUrl || null;
    }
    const data = await rzpRes.json() as { id: string; short_url: string };
    await admin.from("billing_statements").update({
      razorpay_payment_link_id: data.id,
      razorpay_payment_link_url: data.short_url,
    }).eq("id", statement.id);
    return data.short_url;
  } catch (err) {
    console.error("[payment-reminder] create link threw:", err);
    return existingUrl || null;
  }
}

function renderEmail(opts: {
  customerName: string; stmt: string; contractNumber: string; contractLabel?: string;
  periodStart: string; periodEnd: string; dueDate: string;
  amountStr: string; payLinkUrl: string | null; intro: string;
  toneLabel: string;
  /** SIGNED days past due. Negative = pre-due (operator triggered manual
   *  reminder before due date). 0 = due today. Positive = overdue. */
  daysOverdue: number;
  /** When set, the customer has made a partial payment — show original
   *  total + amount paid alongside the balance figure. */
  originalTotal: string | null;
  paidSoFar: string | null;
  /** When set, this statement has an early-issued GST invoice (PI was cancelled).
   *  The ref label changes and the cancelled PI number is shown for context. */
  gstInvoiceNumber?: string | null;
  cancelledPiNumber?: string | null;
  /** URL for the 1x1 tracking pixel. When loaded by the email client we mark
   *  the send row as opened. Omit to skip tracking (non-email channels). */
  trackingPixelUrl?: string | null;
  /** Name of the attached invoice document ("tax invoice" / "proforma"); omit when nothing is attached. */
  attachedDoc?: string | null;
}): string {
  const periodLabel = `${fmtDate(opts.periodStart)} – ${fmtDate(opts.periodEnd)}`;
  const d = opts.daysOverdue;
  const overdueBanner = d > 0
    ? `<div style="background:#fee2e2;border:1px solid #fca5a5;border-radius:6px;padding:10px 14px;margin:12px 0;font-size:13px;color:#991b1b;"><strong>${d} day${d > 1 ? "s" : ""} past due.</strong></div>`
    : d === 0
    ? `<div style="background:#fef3c7;border:1px solid #fcd34d;border-radius:6px;padding:10px 14px;margin:12px 0;font-size:13px;color:#92400e;"><strong>Due today.</strong></div>`
    : `<div style="background:#ecfdf5;border:1px solid #6ee7b7;border-radius:6px;padding:10px 14px;margin:12px 0;font-size:13px;color:#065f46;"><strong>Due in ${Math.abs(d)} day${Math.abs(d) !== 1 ? "s" : ""}</strong> (${opts.dueDate}).</div>`;

  return `
    <div style="font-family:sans-serif;max-width:600px;margin:0 auto;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
      <div style="background:#015E65;padding:20px 32px;">
        <h1 style="color:white;margin:0;font-size:20px;">The WorkVilla</h1>
        <p style="color:#00AE6C;margin:4px 0 0;font-size:12px;">${opts.toneLabel}</p>
      </div>
      <div style="padding:28px;">
        <p style="color:#333;font-size:14px;">Dear ${opts.customerName},</p>
        <p style="color:#333;font-size:14px;">${opts.intro}</p>
        ${overdueBanner}
        ${opts.gstInvoiceNumber && opts.cancelledPiNumber ? `
        <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:6px;padding:10px 14px;margin:12px 0;font-size:12px;color:#166534;">
          This is a follow-up for Tax Invoice <strong>${opts.gstInvoiceNumber}</strong> which replaced Proforma Invoice ${opts.cancelledPiNumber}.
        </div>` : ""}
        <table style="width:100%;border-collapse:collapse;margin:16px 0;font-size:13px;">
          <tr><td style="padding:6px 0;color:#666;">${opts.gstInvoiceNumber ? "Tax Invoice Ref" : "Proforma Ref"}</td><td style="padding:6px 0;font-weight:600;">${opts.gstInvoiceNumber || opts.stmt}</td></tr>
          <tr><td style="padding:6px 0;color:#666;">${opts.contractLabel ?? "Contract"}</td><td style="padding:6px 0;">${opts.contractNumber}</td></tr>
          <tr><td style="padding:6px 0;color:#666;">Period</td><td style="padding:6px 0;">${periodLabel}</td></tr>
          <tr><td style="padding:6px 0;color:#666;">Due Date</td><td style="padding:6px 0;font-weight:600;color:#b45309;">${opts.dueDate}</td></tr>
          ${opts.originalTotal && opts.paidSoFar ? `
          <tr><td style="padding:6px 0;color:#666;">Original Total</td><td style="padding:6px 0;color:#666;">Rs. ${opts.originalTotal}</td></tr>
          <tr><td style="padding:6px 0;color:#666;">Paid So Far</td><td style="padding:6px 0;color:#059669;">Rs. ${opts.paidSoFar}</td></tr>
          <tr><td style="padding:6px 0;color:#666;">Balance Due</td><td style="padding:6px 0;font-weight:700;color:#015E65;font-size:17px;">Rs. ${opts.amountStr}</td></tr>
          ` : `
          <tr><td style="padding:6px 0;color:#666;">Amount Due</td><td style="padding:6px 0;font-weight:700;color:#015E65;font-size:17px;">Rs. ${opts.amountStr}</td></tr>
          `}
        </table>
        ${opts.originalTotal ? `<p style="background:#ecfdf5;border:1px solid #a7f3d0;border-radius:6px;padding:8px 12px;color:#065f46;font-size:12px;margin:8px 0;">Thank you for the partial payment. The balance shown above is what remains outstanding.</p>` : ""}
        ${opts.attachedDoc ? `<p style="color:#333;font-size:13px;">The ${opts.attachedDoc} is attached to this email for your reference.</p>` : ""}
        ${opts.payLinkUrl ? `
        <div style="text-align:center;margin:24px 0;">
          <a href="${opts.payLinkUrl}" style="background:#015E65;color:white;padding:12px 32px;text-decoration:none;border-radius:8px;font-weight:bold;display:inline-block;font-size:14px;">Pay Now</a>
        </div>` : ""}
        <p style="color:#666;font-size:12px;margin-top:24px;">If you've already made the payment, please ignore this reminder. For any queries, reply to this email or contact our accounts team.</p>
        <p style="color:#666;font-size:12px;">Regards,<br/>Accounts Team — The WorkVilla</p>
      </div>
      <div style="background:#f9fafb;padding:10px 28px;border-top:1px solid #e5e7eb;text-align:center;">
        <p style="color:#9ca3af;margin:0;font-size:10px;">This is an automated payment reminder. SREE DESIGN INFRASTRUCTURE PVT LTD | The WorkVilla</p>
      </div>
    </div>
  `;
}

export interface ReminderSendInput {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  statement: any;          // full row from billing_statements, contract+lead joined
  stageIdx: number;
  appUrl: string;
  /** "cron" for automated daily fires, "manual" for the AR-page button. */
  triggeredBy: "cron" | "manual";
  /** UUID of the user who clicked "Send Reminder Now"; null for cron. */
  triggeredByUserId?: string | null;
  /** Pre-fetched CC pools (saves the cron from re-querying per statement). */
  ccPools: { accounts: string[]; managerAndAdmin: string[]; adminOnly: string[] };
}

export interface ReminderSendResult {
  stageIdx: number;
  toneLabel: string;
  emailSent: boolean;
  whatsAppSent: boolean;
  recipient: { email: string | null; phone: string | null };
  errors: string[];
}

/**
 * Send one ladder-stage reminder for a single statement. Updates
 * billing_statements.reminder_count + last_reminder_sent_at on success.
 * Writes one billing_reminder_sends row per channel (email, WhatsApp).
 *
 * Callers are responsible for stage selection + throttle gates — this
 * function unconditionally sends what it's asked to send.
 */
export async function sendOneReminder(
  admin: SupabaseClient,
  input: ReminderSendInput,
): Promise<ReminderSendResult> {
  const { statement: s, stageIdx, appUrl, triggeredBy, triggeredByUserId, ccPools } = input;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const contract: any = s.contract;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const proposal: any = s.proposal;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const invoice: any = s.invoice;
  const lead = contract?.lead ?? proposal?.lead ?? invoice?.lead;
  const partyRef: string = contract?.contract_number ?? proposal?.proposal_number ?? invoice?.invoice_number ?? "";
  const stage = STAGES[stageIdx];
  const errors: string[] = [];

  // Compute current outstanding balance. Partial payments may have come in
  // since the statement was finalized — in that case the reminder must show
  // the remaining balance, not the original invoice total. The Razorpay
  // link still tracks against the full statement; if the customer has paid
  // partially, the partial-payment note in the email tells them to pay the
  // balance via bank transfer / UPI (or reply for a fresh balance-only link).
  // Paid-to-date includes TDS (same settlement definition as the payment
  // route) — a TDS-bearing partial payment must not inflate the reminder's
  // balance figure.
  const { data: pays } = await admin
    .from("billing_payments").select("amount, tds_amount").eq("billing_statement_id", s.id);
  const paidSoFar = Math.round(settlementTotalPaid(pays));
  const balanceDue = settlementBalanceDue(s.total_amount as number, paidSoFar);
  const isPartial = paidSoFar > 0 && balanceDue > 0;
  const amountStr = fmtINR(balanceDue);

  const dueStr = fmtDate(s.due_date as string);
  const daysOverdue = daysOverdueFromDueDate(s.due_date as string);
  const customerName = lead?.company || `${lead?.first_name || ""} ${lead?.last_name || ""}`.trim() || "Customer";

  const payLinkUrl = await ensureLivePaymentLink(admin, s, contract, lead, appUrl, partyRef);

  // Build CC list per stage.
  const cc: string[] = [];
  if (stage.ccAccounts) cc.push(...ccPools.accounts);
  if (stage.ccManagerAndAdmin) cc.push(...ccPools.managerAndAdmin);
  if (stageIdx >= 4) cc.push(...ccPools.adminOnly);
  const uniqCc = Array.from(new Set(cc.filter((e) => e && e !== lead?.email)));

  // What the customer actually holds. Once a GST invoice has been issued the
  // proforma has been superseded (and in the override flow, cancelled outright)
  // — chasing them under the proforma number names a document they cannot find.
  // This is independent of pi_cancelled_at: Tally-issued invoices never had a
  // proforma cancelled, and were the larger share of the mismatch.
  const gstInvoiceNumber = (s.gst_invoice_number as string | null) || null;
  const customerRef = gstInvoiceNumber || (s.statement_number as string);
  const docNoun = gstInvoiceNumber ? "tax invoice" : "proforma";
  // Only shown when a proforma was actually cancelled, for continuity.
  const cancelledPiNumber = s.pi_cancelled_at ? (s.statement_number as string) : null;

  // Email
  let emailSent = false;
  if (lead?.email) {
    // For pre-due manual sends (operator clicked "Send Reminder Now" before
    // the due date), Stage 0's hardcoded "due today" wording is misleading.
    // Override subject + intro + banner to reflect the actual time remaining.
    // Cron never fires reminders pre-due — this branch only ever applies to
    // manual sends.
    const isPreDue = daysOverdue < 0;
    const daysUntilDue = Math.abs(daysOverdue);

    let dynamicSubject: string;
    let dynamicIntro: string;
    if (isPreDue && stageIdx === 0) {
      dynamicSubject = `Upcoming payment — ${customerRef} due in ${daysUntilDue} day${daysUntilDue !== 1 ? "s" : ""} · ₹${amountStr}`;
      dynamicIntro = `A friendly heads-up that the payment for the ${docNoun} below is due in ${daysUntilDue} day${daysUntilDue !== 1 ? "s" : ""} (${dueStr}). Sharing the details so you can plan the transfer.`;
    } else {
      const subjDueDesc = daysOverdue > 0 ? `${daysOverdue}d` : "due today";
      dynamicSubject = stage.subject(customerRef, subjDueDesc, amountStr);
      dynamicIntro = resolveIntro(stage.intro, docNoun);
    }

    const trackingId = crypto.randomUUID();
    const trackingPixelUrl = `${input.appUrl}/api/tracking/email-open?id=${trackingId}`;

    const attachment = await fetchInvoiceAttachment(admin, s);

    const html = renderEmail({
      customerName, stmt: s.statement_number, contractNumber: partyRef,
      contractLabel: contract ? "Contract" : proposal ? "Proposal Ref" : "Invoice",
      periodStart: s.period_start as string, periodEnd: s.period_end as string,
      dueDate: dueStr, amountStr, payLinkUrl, intro: dynamicIntro,
      toneLabel: stage.toneLabel,
      // Pass signed days so the banner can pick the right wording for
      // pre-due (green "due in X days"), due-today (amber), and overdue (red).
      daysOverdue,
      originalTotal: isPartial ? fmtINR(settlementAmount(s.total_amount as number)) : null,
      paidSoFar:     isPartial ? fmtINR(paidSoFar) : null,
      // Switches the ref label to "Tax Invoice Ref". cancelledPiNumber adds the
      // "replaced Proforma X" line, so it stays null unless one was cancelled.
      gstInvoiceNumber,
      cancelledPiNumber,
      trackingPixelUrl,
      attachedDoc: attachment ? docNoun : null,
    });
    try {
      const r = await resend.emails.send({
        from: EMAIL_FROM,
        replyTo: EMAIL_REPLY_TO,
        to: [lead.email],
        cc: uniqCc.length > 0 ? uniqCc : undefined,
        subject: dynamicSubject,
        html,
        ...(attachment ? { attachments: [attachment] } : {}),
      });
      emailSent = !r.error;
      if (r.error) errors.push(`email: ${r.error.message || JSON.stringify(r.error)}`);
    } catch (err) {
      errors.push(`email: ${err instanceof Error ? err.message : String(err)}`);
    }
    await admin.from("billing_reminder_sends").insert({
      billing_statement_id: s.id,
      stage_index: stageIdx,
      stage_label: stage.toneLabel,
      channel: "email",
      recipient: lead.email,
      status: emailSent ? "sent" : "failed",
      error: emailSent ? null : errors[errors.length - 1] || "unknown",
      triggered_by: triggeredBy,
      triggered_by_user_id: triggeredByUserId || null,
    });
  }

  // WhatsApp (stage 1 onwards, only if customer has a phone)
  let whatsAppSent = false;
  const phone = lead?.mobile || lead?.phone || null;
  if (stage.whatsApp && phone) {
    try {
      const r = await messaging.paymentReminder(phone, customerName, customerRef, amountStr, dueStr, s.id);
      whatsAppSent = r?.success === true;
      if (!whatsAppSent) errors.push(`whatsapp: ${r?.error || "unknown"}`);
    } catch (err) {
      errors.push(`whatsapp: ${err instanceof Error ? err.message : String(err)}`);
    }
    await admin.from("billing_reminder_sends").insert({
      billing_statement_id: s.id,
      stage_index: stageIdx,
      stage_label: stage.toneLabel,
      channel: "whatsapp",
      recipient: phone,
      status: whatsAppSent ? "sent" : "failed",
      error: whatsAppSent ? null : errors[errors.length - 1] || "unknown",
      triggered_by: triggeredBy,
      triggered_by_user_id: triggeredByUserId || null,
    });
  }

  // Advance ladder bookkeeping only on at-least-one-channel success.
  if (emailSent || whatsAppSent) {
    await admin.from("billing_statements").update({
      reminder_count: stageIdx + 1,
      last_reminder_sent_at: new Date().toISOString(),
    }).eq("id", s.id);
  }

  return {
    stageIdx, toneLabel: stage.toneLabel,
    emailSent, whatsAppSent,
    recipient: { email: lead?.email || null, phone },
    errors,
  };
}

/** One invoice inside a consolidated reminder, with everything the email shows. */
export interface ConsolidatedItem {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  statement: any;
  ref: string;
  contractRef: string;
  dueStr: string;
  daysOverdue: number;
  balance: number;
  billed: number;
  paid: number;
  payLinkUrl: string | null;
}

export function renderConsolidatedEmail(opts: {
  customerName: string; intro: string; toneLabel: string;
  items: ConsolidatedItem[]; totalStr: string; oldestDays: number;
  omittedAttachments: number; showContract: boolean; trackingPixelUrl: string | null;
}): string {
  const n = opts.items.length;
  const rows = opts.items.map((it) => `
          <tr>
            <td style="padding:8px;border-bottom:1px solid #eee;">${it.ref}${opts.showContract ? `<br/><span style="color:#888;font-size:11px;">${it.contractRef}</span>` : ""}${it.paid > 0 ? `<br/><span style="color:#059669;font-size:11px;">Rs. ${fmtINR(it.billed)} billed, Rs. ${fmtINR(it.paid)} paid</span>` : ""}</td>
            <td style="padding:8px;border-bottom:1px solid #eee;white-space:nowrap;">${it.dueStr}</td>
            <td style="padding:8px;border-bottom:1px solid #eee;text-align:right;">${it.daysOverdue > 0 ? it.daysOverdue : "Today"}</td>
            <td style="padding:8px;border-bottom:1px solid #eee;text-align:right;white-space:nowrap;">Rs. ${fmtINR(it.balance)}</td>
            <td style="padding:8px;border-bottom:1px solid #eee;text-align:right;">${it.payLinkUrl ? `<a href="${it.payLinkUrl}" style="color:#015E65;font-weight:bold;">Pay</a>` : ""}</td>
          </tr>`).join("");
  const banner = opts.oldestDays > 0
    ? `<div style="background:#fee2e2;border:1px solid #fca5a5;border-radius:6px;padding:10px 14px;margin:12px 0;font-size:13px;color:#991b1b;"><strong>Oldest invoice is ${opts.oldestDays} day${opts.oldestDays > 1 ? "s" : ""} past due.</strong></div>`
    : `<div style="background:#fef3c7;border:1px solid #fcd34d;border-radius:6px;padding:10px 14px;margin:12px 0;font-size:13px;color:#92400e;"><strong>Due today.</strong></div>`;
  return `
    <div style="font-family:sans-serif;max-width:600px;margin:0 auto;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
      <div style="background:#015E65;padding:20px 32px;">
        <h1 style="color:white;margin:0;font-size:20px;">The WorkVilla</h1>
        <p style="color:#00AE6C;margin:4px 0 0;font-size:12px;">${opts.toneLabel}</p>
      </div>
      <div style="padding:28px;">
        <p style="color:#333;font-size:14px;">Dear ${opts.customerName},</p>
        <p style="color:#333;font-size:14px;">${opts.intro}</p>
        ${banner}
        <table style="width:100%;border-collapse:collapse;margin:16px 0;font-size:13px;">
          <tr><td style="padding:6px 0;color:#666;">Invoices outstanding</td><td style="padding:6px 0;">${n}</td></tr>
          <tr><td style="padding:6px 0;color:#666;">Amount Due</td><td style="padding:6px 0;font-weight:700;color:#015E65;font-size:17px;">Rs. ${opts.totalStr}</td></tr>
        </table>
        <p style="color:#333;font-size:13px;margin:20px 0 6px;"><strong>Breakdown</strong>${opts.omittedAttachments > 0 ? "" : " (each invoice is attached)"}</p>
        <table style="width:100%;border-collapse:collapse;font-size:12.5px;">
          <tr style="background:#f3f4f6;">
            <th style="text-align:left;padding:7px 8px;">Invoice</th>
            <th style="text-align:left;padding:7px 8px;">Due</th>
            <th style="text-align:right;padding:7px 8px;">Days late</th>
            <th style="text-align:right;padding:7px 8px;">Balance</th>
            <th style="text-align:right;padding:7px 8px;">Pay</th>
          </tr>${rows}
          <tr><td colspan="3" style="padding:8px;font-weight:700;border-top:2px solid #015E65;">Total outstanding</td><td style="padding:8px;text-align:right;font-weight:700;border-top:2px solid #015E65;white-space:nowrap;">Rs. ${opts.totalStr}</td><td style="border-top:2px solid #015E65;"></td></tr>
        </table>
        ${opts.omittedAttachments > 0 ? `<p style="color:#666;font-size:12px;">The ${n - opts.omittedAttachments} oldest invoices are attached; reply to this email for a copy of the other ${opts.omittedAttachments}.</p>` : ""}
        <p style="color:#666;font-size:12px;margin-top:20px;">Prefer a single transfer? Pay Rs. ${opts.totalStr} by bank transfer or UPI (details are on each invoice) and quote the invoice numbers. If you've already made the payment, please ignore this reminder. For any queries, reply to this email or contact our accounts team.</p>
        <p style="color:#666;font-size:12px;">Regards,<br/>Accounts Team — The WorkVilla</p>
      </div>
      <div style="background:#f9fafb;padding:10px 28px;border-top:1px solid #e5e7eb;text-align:center;">
        <p style="color:#9ca3af;margin:0;font-size:10px;">This is an automated payment reminder. SREE DESIGN INFRASTRUCTURE PVT LTD | The WorkVilla</p>
      </div>
      ${opts.trackingPixelUrl ? `<img src="${opts.trackingPixelUrl}" width="1" height="1" alt="" style="display:none;" />` : ""}
    </div>
  `;
}

export interface ConsolidatedReminderInput {
  /** Every due/overdue statement for the customer, oldest-overdue first. Index 0 sets tone, CC and WhatsApp. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  statements: any[];
  appUrl: string;
  triggeredBy: "cron" | "manual";
  triggeredByUserId?: string | null;
  ccPools: { accounts: string[]; managerAndAdmin: string[]; adminOnly: string[] };
}

/**
 * One reminder for a customer with several due invoices: the TOTAL as the
 * amount due, a per-invoice breakdown (each row with its own Pay link), and
 * the invoice PDFs attached. Replaces N emails with one.
 *
 * The ladder stage comes from the most overdue invoice. On success every
 * included statement is stamped so none of them sends its own reminder for a
 * stage it has already been covered for. Callers pass only statements that are
 * already due — never a pre-due one.
 */
export async function sendConsolidatedReminder(
  admin: SupabaseClient,
  input: ConsolidatedReminderInput,
): Promise<ReminderSendResult & { statementIds: string[] }> {
  const { statements, appUrl, triggeredBy, triggeredByUserId, ccPools } = input;
  const primary = statements[0];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const leadOf = (st: any) => st.contract?.lead ?? st.proposal?.lead ?? st.invoice?.lead;
  const lead = leadOf(primary);
  const stageIdx = pickStageIndex(daysOverdueFromDueDate(primary.due_date as string));
  const stage = STAGES[stageIdx];
  const errors: string[] = [];
  const customerName = lead?.company || `${lead?.first_name || ""} ${lead?.last_name || ""}`.trim() || "Customer";

  const items: ConsolidatedItem[] = [];
  for (const st of statements) {
    const { data: pays } = await admin
      .from("billing_payments").select("amount, tds_amount").eq("billing_statement_id", st.id);
    const paid = Math.round(settlementTotalPaid(pays));
    const balance = settlementBalanceDue(st.total_amount as number, paid);
    // Settled between the query and now — nothing to chase.
    if (balance <= 0) continue;
    const contract = st.contract, proposal = st.proposal, invoice = st.invoice;
    const partyRef: string = contract?.contract_number ?? proposal?.proposal_number ?? invoice?.invoice_number ?? "";
    items.push({
      statement: st,
      ref: (st.gst_invoice_number as string | null) || (st.statement_number as string),
      contractRef: partyRef,
      dueStr: fmtDate(st.due_date as string),
      daysOverdue: daysOverdueFromDueDate(st.due_date as string),
      balance, paid,
      billed: settlementAmount(st.total_amount as number),
      payLinkUrl: await ensureLivePaymentLink(admin, st, contract, leadOf(st), appUrl, partyRef),
    });
  }
  if (items.length === 0) {
    return { stageIdx, toneLabel: stage.toneLabel, emailSent: false, whatsAppSent: false, recipient: { email: lead?.email || null, phone: null }, errors: ["nothing outstanding"], statementIds: [] };
  }

  const total = items.reduce((sum, it) => sum + it.balance, 0);
  const totalStr = fmtINR(total);
  const oldest = items[0];
  const subjectRef = `${items.length} invoices`;
  const subjectDue = oldest.daysOverdue > 0 ? `${oldest.daysOverdue}d` : "due today";
  const subject = items.length === 1
    ? stage.subject(oldest.ref, subjectDue, totalStr)
    : stage.subject(subjectRef, subjectDue, totalStr);
  const intro = resolveIntro(stage.intro, items.length === 1 ? "invoice" : "invoices");

  const cc: string[] = [];
  if (stage.ccAccounts) cc.push(...ccPools.accounts);
  if (stage.ccManagerAndAdmin) cc.push(...ccPools.managerAndAdmin);
  if (stageIdx >= 4) cc.push(...ccPools.adminOnly);
  const uniqCc = Array.from(new Set(cc.filter((e) => e && e !== lead?.email)));

  let emailSent = false;
  if (lead?.email) {
    const { attach, omitted } = splitAttachable(items);
    const attachments: ReminderAttachment[] = [];
    for (const it of attach) {
      const a = await fetchInvoiceAttachment(admin, it.statement);
      if (a) attachments.push(a);
    }
    const trackingPixelUrl = `${appUrl}/api/tracking/email-open?id=${crypto.randomUUID()}`;
    const html = renderConsolidatedEmail({
      customerName, intro, toneLabel: stage.toneLabel, items, totalStr,
      oldestDays: oldest.daysOverdue,
      omittedAttachments: omitted,
      showContract: new Set(items.map((it) => it.contractRef)).size > 1,
      trackingPixelUrl,
    });
    try {
      const r = await resend.emails.send({
        from: EMAIL_FROM,
        replyTo: EMAIL_REPLY_TO,
        to: [lead.email],
        cc: uniqCc.length > 0 ? uniqCc : undefined,
        subject, html,
        ...(attachments.length > 0 ? { attachments } : {}),
      });
      emailSent = !r.error;
      if (r.error) errors.push(`email: ${r.error.message || JSON.stringify(r.error)}`);
    } catch (err) {
      errors.push(`email: ${err instanceof Error ? err.message : String(err)}`);
    }
    // One history row per invoice, so each statement's drawer shows it was covered.
    await admin.from("billing_reminder_sends").insert(items.map((it) => ({
      billing_statement_id: it.statement.id,
      stage_index: stageIdx,
      stage_label: stage.toneLabel,
      channel: "email",
      recipient: lead.email,
      status: emailSent ? "sent" : "failed",
      error: emailSent ? null : errors[errors.length - 1] || "unknown",
      triggered_by: triggeredBy,
      triggered_by_user_id: triggeredByUserId || null,
    })));
  }

  let whatsAppSent = false;
  const phone = lead?.mobile || lead?.phone || null;
  if (stage.whatsApp && phone) {
    const waRef = items.length === 1 ? oldest.ref : `${oldest.ref} and ${items.length - 1} more`;
    try {
      const r = await messaging.paymentReminder(phone, customerName, waRef, totalStr, oldest.dueStr, oldest.statement.id);
      whatsAppSent = r?.success === true;
      if (!whatsAppSent) errors.push(`whatsapp: ${r?.error || "unknown"}`);
    } catch (err) {
      errors.push(`whatsapp: ${err instanceof Error ? err.message : String(err)}`);
    }
    await admin.from("billing_reminder_sends").insert(items.map((it) => ({
      billing_statement_id: it.statement.id,
      stage_index: stageIdx,
      stage_label: stage.toneLabel,
      channel: "whatsapp",
      recipient: phone,
      status: whatsAppSent ? "sent" : "failed",
      error: whatsAppSent ? null : errors[errors.length - 1] || "unknown",
      triggered_by: triggeredBy,
      triggered_by_user_id: triggeredByUserId || null,
    })));
  }

  // Stamp every covered statement on at-least-one-channel success. Each keeps
  // the higher of its own count and the stage it is at today, so a stage it
  // has just been chased for does not fire again on its own.
  if (emailSent || whatsAppSent) {
    const now = new Date().toISOString();
    for (const it of items) {
      const own = pickStageIndex(it.daysOverdue) + 1;
      await admin.from("billing_statements").update({
        reminder_count: Math.max(Number(it.statement.reminder_count) || 0, own, it.statement.id === primary.id ? stageIdx + 1 : 0),
        last_reminder_sent_at: now,
      }).eq("id", it.statement.id);
    }
  }

  return {
    stageIdx, toneLabel: stage.toneLabel, emailSent, whatsAppSent,
    recipient: { email: lead?.email || null, phone },
    errors, statementIds: items.map((it) => it.statement.id as string),
  };
}


/**
 * Fetch the CC pools once for the run. Shared between cron + manual endpoint.
 */
export async function fetchCcPools(admin: SupabaseClient): Promise<{
  accounts: string[]; managerAndAdmin: string[]; adminOnly: string[];
}> {
  const { data: staff } = await admin.from("users")
    .select("email, role")
    .in("role", ["admin", "manager", "accounts"])
    .eq("is_active", true);
  const all = (staff || []) as { email: string; role: string }[];
  return {
    accounts: all.filter((u) => u.role === "accounts").map((u) => u.email).filter(Boolean),
    managerAndAdmin: all.filter((u) => ["admin", "manager"].includes(u.role)).map((u) => u.email).filter(Boolean),
    adminOnly: all.filter((u) => u.role === "admin").map((u) => u.email).filter(Boolean),
  };
}
