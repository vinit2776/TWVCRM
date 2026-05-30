import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { resend, EMAIL_FROM, EMAIL_REPLY_TO } from "@/lib/mailer";
import { messaging } from "@/lib/whatsapp";
import { pingCronHealth } from "@/lib/cron-ping";

export const maxDuration = 60;

/**
 * GET /api/cron/payment-reminder
 *
 * Daily customer payment-reminder cron. Fires at 09:30 IST. For every unpaid
 * (or partially-paid) finalized billing statement with a due_date, computes
 * days-past-due and sends a stage-appropriate reminder following the ladder:
 *
 *   Stage 0  → day 0   — friendly "due today" nudge          (email)
 *   Stage 1  → day +3  — gentle reminder                     (email + WhatsApp)
 *   Stage 2  → day +7  — firm reminder, CC accounts          (email + WhatsApp)
 *   Stage 3  → day +14 — escalation, CC accounts/mgr/admin   (email + WhatsApp)
 *   Stage 4  → day +21 — service-notice warning, CC admin    (email + WhatsApp)
 *   Stage 5  → day +30 — final notice, CC admin              (email + WhatsApp)
 *   day +31+ → no auto reminder (manual collections takeover)
 *
 * Idempotency: `reminder_count` on billing_statements tracks how many ladder
 * stages have already been sent. A reminder fires only when the current stage
 * index >= reminder_count (so we never repeat a stage, and we catch up if the
 * cron missed a day). Also throttled to no two sends within 48h.
 *
 * Razorpay payment link: reused if still valid (status === "created"); if
 * expired, paid (race), or absent, a fresh link is created so the customer
 * always has one click to pay.
 *
 * Query: ?dry=1 — compute the ladder + recipients but send nothing; useful for
 *                  ops to preview today's run.
 *        ?force=1 — bypass the 48h throttle (testing only).
 */

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

// Per-stage config. Order matters — index === reminder_count after send.
interface Stage {
  day: number;            // minimum days past due to qualify
  toneLabel: string;      // shown in subject + body
  subject: (ref: string, due: string, amount: string) => string;
  intro: string;          // opening sentence in the email body
  ccAccounts: boolean;
  ccManagerAndAdmin: boolean;
  whatsApp: boolean;
}

const STAGES: Stage[] = [
  {
    day: 0, toneLabel: "Friendly reminder",
    subject: (ref, due, amt) => `Payment due today — ${ref} · ₹${amt}`,
    intro: "Just a friendly note that the payment for the proforma below is due today. We'd appreciate it if you could settle it at your convenience.",
    ccAccounts: false, ccManagerAndAdmin: false, whatsApp: false,
  },
  {
    day: 3, toneLabel: "Gentle reminder",
    subject: (ref, due, amt) => `Reminder — ${ref} now ${due} overdue · ₹${amt}`,
    intro: "A gentle reminder that the payment for the proforma below is still pending. Please process at your earliest convenience.",
    ccAccounts: false, ccManagerAndAdmin: false, whatsApp: true,
  },
  {
    day: 7, toneLabel: "Firm reminder",
    subject: (ref, due, amt) => `Overdue — ${ref} · ₹${amt}`,
    intro: "The payment for the proforma below is now overdue. Kindly arrange settlement at the earliest. Our accounts team has been copied on this email.",
    ccAccounts: true, ccManagerAndAdmin: false, whatsApp: true,
  },
  {
    day: 14, toneLabel: "Escalation",
    subject: (ref, due, amt) => `URGENT: Payment overdue — ${ref} · ₹${amt}`,
    intro: "This payment is now significantly overdue. We've copied our management team on this email. Please clear the balance or get in touch to discuss.",
    ccAccounts: true, ccManagerAndAdmin: true, whatsApp: true,
  },
  {
    day: 21, toneLabel: "Service notice",
    subject: (ref, due, amt) => `Service-continuation notice — ${ref} · ₹${amt}`,
    intro: "Despite multiple reminders, the payment below remains outstanding. Per the terms of your contract, continued non-payment may result in suspension of services. Please act today to avoid disruption.",
    ccAccounts: true, ccManagerAndAdmin: true, whatsApp: true,
  },
  {
    day: 30, toneLabel: "Final notice",
    subject: (ref, due, amt) => `FINAL NOTICE — ${ref} · ₹${amt}`,
    intro: "This is our final automated notice for the outstanding payment below. Our accounts team will contact you directly to arrange settlement. Please respond to avoid further escalation.",
    ccAccounts: true, ccManagerAndAdmin: true, whatsApp: true,
  },
];

/** Highest stage index that applies for the given days-past-due, or -1 if pre-due. */
function pickStageIndex(daysOverdue: number): number {
  let best = -1;
  for (let i = 0; i < STAGES.length; i++) {
    if (daysOverdue >= STAGES[i].day) best = i;
  }
  return best;
}

/**
 * Returns a working Razorpay payment-link URL for the statement. If the
 * stored link is still valid, returns it as-is. Otherwise creates a fresh link
 * via Razorpay API and persists the new id/url on the statement row.
 *
 * Returns null on hard failure — the cron then sends the reminder without a
 * one-click pay button (customer can still pay via bank/UPI listed in email).
 */
async function ensureLivePaymentLink(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  admin: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  statement: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  contract: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  lead: any,
  appUrl: string,
): Promise<string | null> {
  // Razorpay credentials live in app_settings, not env (per CRM convention).
  const { data: rzpRows } = await admin
    .from("app_settings").select("key, value")
    .in("key", ["razorpay_enabled", "razorpay_key_id", "razorpay_key_secret"]);
  const rzp = (rzpRows || []).reduce((m: Record<string, string>, r: { key: string; value: string }) => { m[r.key] = r.value; return m; }, {});
  if (rzp.razorpay_enabled !== "true" || !rzp.razorpay_key_id || !rzp.razorpay_key_secret) return null;
  const auth = Buffer.from(`${rzp.razorpay_key_id}:${rzp.razorpay_key_secret}`).toString("base64");

  // Check existing link's status — only "created" means active/payable.
  const existingId = statement.razorpay_payment_link_id as string | undefined;
  const existingUrl = statement.razorpay_payment_link_url as string | undefined;
  if (existingId) {
    try {
      const res = await fetch(`https://api.razorpay.com/v1/payment_links/${existingId}`, {
        headers: { Authorization: `Basic ${auth}` },
      });
      if (res.ok) {
        const data = await res.json() as { status?: string; short_url?: string };
        if (data.status === "created") return data.short_url || existingUrl || null;
      }
    } catch (err) {
      console.error("[payment-reminder] link status check failed:", err);
    }
  }

  // Create a fresh link. reference_id rotates per reminder count to avoid
  // Razorpay "already exists" collision after expiry.
  const refId = `bs_${statement.id}_r${statement.reminder_count || 0}`;
  const customerName = lead?.company || `${lead?.first_name || ""} ${lead?.last_name || ""}`.trim() || "Customer";
  const phone = (lead?.mobile || lead?.phone || "").replace(/\s/g, "");
  const email = lead?.email || "";

  const payload: Record<string, unknown> = {
    amount: Math.round(Number(statement.total_amount) * 100),
    currency: "INR",
    accept_partial: false,
    description: `${statement.statement_number} — ${contract.contract_number}`,
    reference_id: refId,
    expire_by: Math.floor(Date.now() / 1000) + 15 * 24 * 60 * 60,
    notify: { sms: !!phone, email: !!email },
    reminder_enable: true,
    notes: { statement_id: statement.id, contract_number: contract.contract_number, reminder_regen: "true" },
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
      return existingUrl || null; // fall back to whatever we had
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

function fmtINR(n: number): string {
  return Math.round(n).toLocaleString("en-IN", { maximumFractionDigits: 0 });
}

function fmtDate(ymd: string): string {
  return new Date(ymd + "T00:00:00").toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric" });
}

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const url = new URL(request.url);
  const dry = url.searchParams.get("dry") === "1";
  const force = url.searchParams.get("force") === "1";

  const admin = createAdminClient();
  const appUrl = (process.env.NEXT_PUBLIC_APP_URL || "https://twv-crm.vercel.app").trim();

  // Today (IST) anchor for days-past-due.
  const todayIst = new Date(Date.now() + IST_OFFSET_MS).toISOString().slice(0, 10);
  const todayMs = Date.parse(todayIst + "T00:00:00Z");

  // Pull every unpaid finalized statement with a due_date set.
  const { data: statements, error } = await admin
    .from("billing_statements")
    .select(`
      id, statement_number, period_start, period_end, due_date, total_amount,
      payment_status, razorpay_payment_link_id, razorpay_payment_link_url,
      reminder_count, last_reminder_sent_at, voided_at,
      contract:contracts!billing_statements_contract_id_fkey(
        id, contract_number,
        lead:leads!contracts_lead_id_fkey(id, first_name, last_name, company, email, phone, mobile)
      )
    `)
    .in("status", ["finalized", "exported"])
    .in("payment_status", ["unpaid", "partially_paid"])
    .is("voided_at", null)
    .not("due_date", "is", null);

  if (error) {
    await pingCronHealth("payment-reminder", "error", { error: error.message });
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Internal CC recipients — fetched once.
  const { data: staff } = await admin.from("users")
    .select("email, role")
    .in("role", ["admin", "manager", "accounts"])
    .eq("is_active", true);
  const accountsCcs = (staff || []).filter((u: { role: string }) => u.role === "accounts").map((u: { email: string }) => u.email).filter(Boolean);
  const managerAdminCcs = (staff || []).filter((u: { role: string }) => ["admin", "manager"].includes(u.role)).map((u: { email: string }) => u.email).filter(Boolean);
  const adminOnlyCcs = (staff || []).filter((u: { role: string }) => u.role === "admin").map((u: { email: string }) => u.email).filter(Boolean);

  let sent = 0, skipped = 0, errors = 0;
  const summary: { id: string; stmt: string; stage: number; tone: string; channel: string; status: string; reason?: string }[] = [];

  for (const s of statements || []) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const contract: any = s.contract;
    if (!contract) { skipped++; summary.push({ id: s.id, stmt: s.statement_number, stage: -1, tone: "—", channel: "—", status: "skip", reason: "no contract" }); continue; }
    const lead = contract.lead;
    if (!lead?.email && !(lead?.mobile || lead?.phone)) {
      skipped++; summary.push({ id: s.id, stmt: s.statement_number, stage: -1, tone: "—", channel: "—", status: "skip", reason: "no contact" });
      continue;
    }

    const dueMs = Date.parse((s.due_date as string) + "T00:00:00Z");
    const daysOverdue = Math.floor((todayMs - dueMs) / 86400000);
    const stageIdx = pickStageIndex(daysOverdue);
    if (stageIdx < 0) { skipped++; summary.push({ id: s.id, stmt: s.statement_number, stage: -1, tone: "pre-due", channel: "—", status: "skip", reason: "not yet due" }); continue; }
    if (stageIdx < (s.reminder_count || 0)) { skipped++; summary.push({ id: s.id, stmt: s.statement_number, stage: stageIdx, tone: "—", channel: "—", status: "skip", reason: "already sent this stage" }); continue; }

    // 48h throttle (force=1 bypasses for testing).
    if (!force && s.last_reminder_sent_at) {
      const lastMs = Date.parse(s.last_reminder_sent_at as string);
      if (Date.now() - lastMs < 48 * 60 * 60 * 1000) {
        skipped++; summary.push({ id: s.id, stmt: s.statement_number, stage: stageIdx, tone: STAGES[stageIdx].toneLabel, channel: "—", status: "skip", reason: "<48h since last" });
        continue;
      }
    }

    const stage = STAGES[stageIdx];
    const amountStr = fmtINR(Number(s.total_amount));
    const dueStr = fmtDate(s.due_date as string);
    const customerName = lead.company || `${lead.first_name || ""} ${lead.last_name || ""}`.trim() || "Customer";

    if (dry) {
      summary.push({ id: s.id, stmt: s.statement_number, stage: stageIdx, tone: stage.toneLabel, channel: stage.whatsApp ? "email+wa" : "email", status: "would-send" });
      continue;
    }

    // Refresh / regenerate Razorpay link before sending so the Pay Now button works.
    const payLinkUrl = await ensureLivePaymentLink(admin, s, contract, lead, appUrl);

    // Build per-stage cc list.
    const cc: string[] = [];
    if (stage.ccAccounts) cc.push(...accountsCcs);
    if (stage.ccManagerAndAdmin) cc.push(...managerAdminCcs);
    if (stageIdx >= 4) cc.push(...adminOnlyCcs);
    const uniqCc = Array.from(new Set(cc.filter((e) => e && e !== lead.email)));

    // Email
    let emailOk = false;
    if (lead.email) {
      const overdueDays = Math.max(0, daysOverdue);
      const html = renderEmail({
        customerName, stmt: s.statement_number, contractNumber: contract.contract_number,
        periodStart: s.period_start as string, periodEnd: s.period_end as string,
        dueDate: dueStr, amountStr, payLinkUrl, intro: stage.intro,
        toneLabel: stage.toneLabel, overdueDays,
      });
      try {
        const r = await resend.emails.send({
          from: EMAIL_FROM,
          replyTo: EMAIL_REPLY_TO,
          to: [lead.email],
          cc: uniqCc.length > 0 ? uniqCc : undefined,
          subject: stage.subject(s.statement_number, overdueDays > 0 ? `${overdueDays}d` : "due today", amountStr),
          html,
        });
        emailOk = !r.error;
      } catch (err) {
        console.error("[payment-reminder] email failed:", err);
      }
    }

    // WhatsApp (stage 1 onwards)
    let waOk = false;
    if (stage.whatsApp) {
      const phone = lead.mobile || lead.phone;
      if (phone) {
        try {
          const r = await messaging.paymentReminder(phone, s.statement_number, amountStr, dueStr, s.id);
          waOk = r?.success === true;
        } catch (err) {
          console.error("[payment-reminder] WhatsApp failed:", err);
        }
      }
    }

    if (!emailOk && !waOk) {
      errors++;
      summary.push({ id: s.id, stmt: s.statement_number, stage: stageIdx, tone: stage.toneLabel, channel: stage.whatsApp ? "email+wa" : "email", status: "error" });
      continue;
    }

    // Bookkeeping: advance reminder_count + stamp last_reminder_sent_at.
    await admin.from("billing_statements").update({
      reminder_count: stageIdx + 1,
      last_reminder_sent_at: new Date().toISOString(),
    }).eq("id", s.id);

    sent++;
    summary.push({
      id: s.id, stmt: s.statement_number, stage: stageIdx, tone: stage.toneLabel,
      channel: `${emailOk ? "email" : ""}${emailOk && waOk ? "+" : ""}${waOk ? "wa" : ""}`,
      status: "sent",
    });
  }

  const result = { date: todayIst, dry, considered: (statements || []).length, sent, skipped, errors, summary };
  await pingCronHealth("payment-reminder", errors > 0 ? "error" : "ok", { sent, skipped, errors });
  return NextResponse.json(result);
}

function renderEmail(opts: {
  customerName: string;
  stmt: string;
  contractNumber: string;
  periodStart: string;
  periodEnd: string;
  dueDate: string;
  amountStr: string;
  payLinkUrl: string | null;
  intro: string;
  toneLabel: string;
  overdueDays: number;
}): string {
  const periodLabel = `${fmtDate(opts.periodStart)} – ${fmtDate(opts.periodEnd)}`;
  const overdueBanner = opts.overdueDays > 0
    ? `<div style="background:#fee2e2;border:1px solid #fca5a5;border-radius:6px;padding:10px 14px;margin:12px 0;font-size:13px;color:#991b1b;"><strong>${opts.overdueDays} day${opts.overdueDays > 1 ? "s" : ""} past due.</strong></div>`
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
        ${overdueBanner}
        <table style="width:100%;border-collapse:collapse;margin:16px 0;font-size:13px;">
          <tr><td style="padding:6px 0;color:#666;">Proforma Ref</td><td style="padding:6px 0;font-weight:600;">${opts.stmt}</td></tr>
          <tr><td style="padding:6px 0;color:#666;">Contract</td><td style="padding:6px 0;">${opts.contractNumber}</td></tr>
          <tr><td style="padding:6px 0;color:#666;">Period</td><td style="padding:6px 0;">${periodLabel}</td></tr>
          <tr><td style="padding:6px 0;color:#666;">Due Date</td><td style="padding:6px 0;font-weight:600;color:#b45309;">${opts.dueDate}</td></tr>
          <tr><td style="padding:6px 0;color:#666;">Amount Due</td><td style="padding:6px 0;font-weight:700;color:#015E65;font-size:17px;">Rs. ${opts.amountStr}</td></tr>
        </table>
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
