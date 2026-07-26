/**
 * Follow-up dispatcher for receivables that live outside billing_statements:
 * proposal security deposits, deposit top-ups, and ad-hoc proforma invoices.
 *
 * Deliberately separate from src/lib/payment-reminder.ts. That module is
 * welded to the billing_statements shape (billing_payments lookups, Razorpay
 * link write-back onto the statement, billing_reminder_sends FK) and drives
 * live monthly invoicing — widening it to four entity types would put the
 * production dunning path at risk for no benefit. The ladder *definition*
 * (STAGES) is imported so tone and cadence stay in one place.
 *
 * Ladder assignment:
 *   ad-hoc PI        -> full ladder (stages 0-5, escalates, perpetual)
 *   deposit / top-up -> soft ladder (stages 0-2). Collecting a deposit —
 *                       especially a renewal-escalation shortfall, which
 *                       never blocks activation — is routine follow-up, not
 *                       debt collection, so it never escalates to management
 *                       and never re-fires perpetually.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { resend, EMAIL_FROM, EMAIL_REPLY_TO } from "@/lib/mailer";
import { messaging } from "@/lib/whatsapp";
import { STAGES, fmtINR, fmtDate, pickStageIndex } from "@/lib/payment-reminder";
import { ladderMaxStageFor, type ReceivableKind } from "@/lib/receivables";

/** Where each kind keeps its due date and reminder bookkeeping. */
const TABLE_MAP: Record<Exclude<ReceivableKind, "statement">, {
  table: string;
  reminderCount: string;
  lastSentAt: string;
}> = {
  deposit: {
    table: "proposals",
    reminderCount: "deposit_reminder_count",
    lastSentAt: "deposit_last_reminder_sent_at",
  },
  topup: {
    table: "deposit_topups",
    reminderCount: "reminder_count",
    lastSentAt: "last_reminder_sent_at",
  },
  adhoc_invoice: {
    table: "proforma_invoices",
    reminderCount: "reminder_count",
    lastSentAt: "last_reminder_sent_at",
  },
};

export interface ReceivableReminderInput {
  kind: Exclude<ReceivableKind, "statement">;
  id: string;
  reference: string;
  partyName: string;
  email: string | null;
  phone: string | null;
  amount: number;
  dueDate: string;
  daysOverdue: number;
  stageIdx: number;
  payLinkUrl: string | null;
  triggeredBy: "cron" | "manual";
  triggeredByUserId?: string | null;
  ccPools: { accounts: string[]; managerAndAdmin: string[]; adminOnly: string[] };
}

export interface ReceivableReminderResult {
  stageIdx: number;
  toneLabel: string;
  emailSent: boolean;
  whatsAppSent: boolean;
  errors: string[];
}

/**
 * Stage selection capped by the kind's ladder. Returns -1 when nothing
 * should fire (not yet due, or the soft ladder is exhausted).
 */
export function pickStageForKind(kind: ReceivableKind, daysOverdue: number): number {
  const idx = pickStageIndex(daysOverdue);
  if (idx < 0) return -1;
  const max = ladderMaxStageFor(kind);
  if (max === null) return idx;
  return idx > max ? max : idx;
}

/**
 * Whether this stage is allowed to fire given what has already gone out.
 * The soft ladder has no perpetual rung, so once its final stage has been
 * sent the sequence simply stops.
 */
export function shouldFire(
  kind: ReceivableKind,
  stageIdx: number,
  reminderCount: number,
  lastSentAt: string | null,
  force = false,
): { fire: boolean; reason?: string } {
  if (stageIdx < 0) return { fire: false, reason: "not yet due" };

  const max = ladderMaxStageFor(kind);
  const isSoft = max !== null;

  if (stageIdx < reminderCount) {
    // Full ladder's terminal stage re-fires on its own cadence; the soft
    // ladder deliberately goes quiet instead.
    const stage = STAGES[stageIdx];
    const isPerpetual = !isSoft
      && stage.perpetualEveryDays !== undefined
      && stageIdx === STAGES.length - 1;
    if (!isPerpetual) return { fire: false, reason: "stage already sent" };
    if (!force && lastSentAt) {
      const elapsed = Date.now() - Date.parse(lastSentAt);
      if (elapsed < (stage.perpetualEveryDays as number) * 86400000) {
        return { fire: false, reason: `<${stage.perpetualEveryDays}d since last` };
      }
    }
    return { fire: true };
  }

  // 48h floor guards against accidental double-fires.
  if (!force && lastSentAt && Date.now() - Date.parse(lastSentAt) < 48 * 3600000) {
    return { fire: false, reason: "<48h since last" };
  }
  return { fire: true };
}

function renderEmail(o: {
  kind: Exclude<ReceivableKind, "statement">;
  customerName: string; reference: string; dueDate: string;
  amountStr: string; payLinkUrl: string | null; intro: string;
  toneLabel: string; daysOverdue: number;
}): string {
  const d = o.daysOverdue;
  const banner = d > 0
    ? `<div style="background:#fee2e2;border:1px solid #fca5a5;border-radius:6px;padding:10px 14px;margin:12px 0;font-size:13px;color:#991b1b;"><strong>${d} day${d > 1 ? "s" : ""} past due.</strong></div>`
    : d === 0
    ? `<div style="background:#fef3c7;border:1px solid #fcd34d;border-radius:6px;padding:10px 14px;margin:12px 0;font-size:13px;color:#92400e;"><strong>Due today.</strong></div>`
    : `<div style="background:#ecfdf5;border:1px solid #6ee7b7;border-radius:6px;padding:10px 14px;margin:12px 0;font-size:13px;color:#065f46;"><strong>Due in ${Math.abs(d)} day${Math.abs(d) !== 1 ? "s" : ""}</strong> (${o.dueDate}).</div>`;

  const refLabel = o.kind === "adhoc_invoice" ? "Invoice Ref" : "Reference";
  const whatLabel = o.kind === "deposit"
    ? "Security Deposit"
    : o.kind === "topup" ? "Additional Security Deposit" : "Amount Due";

  return `
    <div style="font-family:sans-serif;max-width:600px;margin:0 auto;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
      <div style="background:#015E65;padding:20px 32px;">
        <h1 style="color:white;margin:0;font-size:20px;">The WorkVilla</h1>
        <p style="color:#00AE6C;margin:4px 0 0;font-size:12px;">${o.toneLabel}</p>
      </div>
      <div style="padding:28px;">
        <p style="color:#333;font-size:14px;">Dear ${o.customerName},</p>
        <p style="color:#333;font-size:14px;">${o.intro}</p>
        ${banner}
        <table style="width:100%;border-collapse:collapse;margin:16px 0;font-size:13px;">
          <tr><td style="padding:6px 0;color:#666;">${refLabel}</td><td style="padding:6px 0;font-weight:600;">${o.reference}</td></tr>
          <tr><td style="padding:6px 0;color:#666;">Due Date</td><td style="padding:6px 0;font-weight:600;color:#b45309;">${o.dueDate}</td></tr>
          <tr><td style="padding:6px 0;color:#666;">${whatLabel}</td><td style="padding:6px 0;font-weight:700;color:#015E65;font-size:17px;">Rs. ${o.amountStr}</td></tr>
        </table>
        ${o.payLinkUrl ? `
        <div style="text-align:center;margin:24px 0;">
          <a href="${o.payLinkUrl}" style="background:#015E65;color:white;padding:12px 32px;text-decoration:none;border-radius:8px;font-weight:bold;display:inline-block;font-size:14px;">Pay Now</a>
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

/** Deposit copy differs from invoice copy — a deposit isn't an unpaid bill. */
function introFor(kind: Exclude<ReceivableKind, "statement">, stageIdx: number): string {
  if (kind === "adhoc_invoice") return STAGES[stageIdx].intro;

  const what = kind === "deposit" ? "security deposit" : "additional security deposit";
  switch (stageIdx) {
    case 0:
      return `Just a friendly note that the ${what} below is due today. Once it's received we can complete the formalities at our end.`;
    case 1:
      return `A gentle reminder that the ${what} below is still pending. Please process it at your convenience.`;
    default:
      return `The ${what} below is still outstanding. Kindly arrange it at the earliest, or write back if there's anything we can help resolve. Our accounts team has been copied on this email.`;
  }
}

function subjectFor(
  kind: Exclude<ReceivableKind, "statement">,
  reference: string,
  daysOverdue: number,
  amountStr: string,
  stageIdx: number,
): string {
  if (kind === "adhoc_invoice") {
    const dueDesc = daysOverdue > 0 ? `${daysOverdue}d` : "due today";
    return STAGES[stageIdx].subject(reference, dueDesc, amountStr);
  }
  const what = kind === "deposit" ? "Security deposit" : "Additional deposit";
  if (daysOverdue <= 0) return `${what} due today — ${reference} · ₹${amountStr}`;
  return `${what} pending — ${reference} (${daysOverdue}d) · ₹${amountStr}`;
}

/**
 * Send one ladder-stage reminder for a single non-statement receivable.
 * Updates the kind's reminder counters and writes one
 * receivable_reminder_sends row per channel.
 *
 * Stage selection and throttling are the caller's job — this sends what it
 * is told to send.
 */
export async function sendReceivableReminder(
  admin: SupabaseClient,
  input: ReceivableReminderInput,
): Promise<ReceivableReminderResult> {
  const {
    kind, id, reference, partyName, email, phone, amount, dueDate,
    daysOverdue, stageIdx, payLinkUrl, triggeredBy, triggeredByUserId, ccPools,
  } = input;

  const stage = STAGES[stageIdx];
  const errors: string[] = [];
  const amountStr = fmtINR(amount);
  const dueStr = fmtDate(dueDate);
  const isSoft = ladderMaxStageFor(kind) !== null;

  // Soft ladder tops out at "accounts CC'd" — management is never looped in
  // on a deposit chase.
  const cc: string[] = [];
  if (stage.ccAccounts) cc.push(...ccPools.accounts);
  if (!isSoft && stage.ccManagerAndAdmin) cc.push(...ccPools.managerAndAdmin);
  if (!isSoft && stageIdx >= 4) cc.push(...ccPools.adminOnly);
  const uniqCc = Array.from(new Set(cc.filter((e) => e && e !== email)));

  const logSend = async (channel: "email" | "whatsapp", ok: boolean, recipient: string | null) => {
    await admin.from("receivable_reminder_sends").insert({
      kind, receivable_id: id, stage_index: stageIdx, stage_label: stage.toneLabel,
      channel, recipient, status: ok ? "sent" : "failed",
      error: ok ? null : errors[errors.length - 1] || "unknown",
      triggered_by: triggeredBy, triggered_by_user_id: triggeredByUserId || null,
    });
  };

  let emailSent = false;
  if (email) {
    const html = renderEmail({
      kind, customerName: partyName, reference, dueDate: dueStr,
      amountStr, payLinkUrl, intro: introFor(kind, stageIdx),
      toneLabel: stage.toneLabel, daysOverdue,
    });
    try {
      const r = await resend.emails.send({
        from: EMAIL_FROM,
        replyTo: EMAIL_REPLY_TO,
        to: [email],
        cc: uniqCc.length > 0 ? uniqCc : undefined,
        subject: subjectFor(kind, reference, daysOverdue, amountStr, stageIdx),
        html,
      });
      emailSent = !r.error;
      if (r.error) errors.push(`email: ${r.error.message || JSON.stringify(r.error)}`);
    } catch (err) {
      errors.push(`email: ${err instanceof Error ? err.message : String(err)}`);
    }
    await logSend("email", emailSent, email);
  }

  let whatsAppSent = false;
  if (stage.whatsApp && phone) {
    try {
      const r = await messaging.paymentReminder(phone, partyName, reference, amountStr, dueStr, id);
      whatsAppSent = !!r?.success;
      if (!whatsAppSent) errors.push(`whatsapp: ${r?.error || "unknown"}`);
    } catch (err) {
      errors.push(`whatsapp: ${err instanceof Error ? err.message : String(err)}`);
    }
    await logSend("whatsapp", whatsAppSent, phone);
  }

  if (emailSent || whatsAppSent) {
    const map = TABLE_MAP[kind];
    await admin
      .from(map.table)
      .update({
        [map.reminderCount]: stageIdx + 1,
        [map.lastSentAt]: new Date().toISOString(),
      })
      .eq("id", id);
  }

  return { stageIdx, toneLabel: stage.toneLabel, emailSent, whatsAppSent, errors };
}
