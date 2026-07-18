import { NextRequest, NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/server";
import { pingCronHealth } from "@/lib/cron-ping";
import {
  STAGES, pickStageIndex, daysOverdueFromDueDate,
  sendOneReminder, fetchCcPools,
} from "@/lib/payment-reminder";
import {
  pickStageForKind, shouldFire, sendReceivableReminder,
} from "@/lib/receivable-reminder";
import { fetchDunnableReceivables } from "@/lib/receivable-fetch";

export const maxDuration = 60;

/**
 * GET /api/cron/payment-reminder
 *
 * Daily customer payment-reminder cron. See src/lib/payment-reminder.ts for
 * the ladder definition + send logic (shared with the manual "Send Reminder
 * Now" button on /accounting/receivables).
 *
 * Idempotency: reminder_count gates per-stage; only fires when stageIdx >=
 * reminder_count, EXCEPT the terminal stage (stage 5, "Continued follow-up")
 * which is marked perpetualEveryDays and re-fires on its own cadence (every 3
 * days) until the statement is paid or voided. Manual collections runs in
 * parallel — this is the steady automated drumbeat.
 *
 * Throttle: non-perpetual stages have a 48h floor between sends. Perpetual
 * re-fires gate by the stage's own cadence (e.g. 3 days).
 *
 * Query: ?dry=1   — preview only, send nothing
 *        ?force=1 — bypass 48h throttle (testing)
 */
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

  // Pull every unpaid finalized statement with a due_date.
  const { data: statements, error } = await admin
    .from("billing_statements")
    .select(`
      id, statement_number, period_start, period_end, due_date, total_amount,
      payment_status, razorpay_payment_link_id, razorpay_payment_link_url,
      reminder_count, last_reminder_sent_at, voided_at,
      issuance_channel, tally_delivered_at,
      contract:contracts!billing_statements_contract_id_fkey(
        id, contract_number,
        lead:leads!contracts_lead_id_fkey(id, first_name, last_name, company, email, phone, mobile)
      ),
      proposal:proposals!billing_statements_proposal_id_fkey(
        id, proposal_number,
        lead:leads!proposals_lead_id_fkey(id, first_name, last_name, company, email, phone, mobile)
      ),
      invoice:proforma_invoices!billing_statements_invoice_id_fkey(
        id, invoice_number,
        lead:leads!proforma_invoices_lead_id_fkey(id, first_name, last_name, company, email, phone, mobile)
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

  const ccPools = await fetchCcPools(admin);
  let sent = 0, skipped = 0, errors = 0;
  const summary: { id: string; stmt: string; stage: number; tone: string; channel: string; status: string; reason?: string }[] = [];

  for (const s of statements || []) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const contract: any = s.contract;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const proposal: any = s.proposal;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const invoice: any = s.invoice;
    if (!contract && !proposal && !invoice) { skipped++; summary.push({ id: s.id, stmt: s.statement_number, stage: -1, tone: "—", channel: "—", status: "skip", reason: "no contract, proposal, or invoice" }); continue; }
    const lead = contract?.lead ?? proposal?.lead ?? invoice?.lead;
    if (!lead?.email && !(lead?.mobile || lead?.phone)) {
      skipped++; summary.push({ id: s.id, stmt: s.statement_number, stage: -1, tone: "—", channel: "—", status: "skip", reason: "no contact" });
      continue;
    }

    // OV1: never dun a Tally-issued invoice the customer hasn't received yet.
    // tally_delivered_at is set by dispatchTallyInvoice once the PDF + payment
    // link have actually gone out. CRM-issued statements (issuance_channel='crm')
    // are unaffected — they were delivered at the moment due_date was stamped.
    if (s.issuance_channel === "tally" && !s.tally_delivered_at) {
      skipped++; summary.push({ id: s.id, stmt: s.statement_number, stage: -1, tone: "—", channel: "—", status: "skip", reason: "tally not delivered" });
      continue;
    }

    const daysOverdue = daysOverdueFromDueDate(s.due_date as string);
    const stageIdx = pickStageIndex(daysOverdue);
    if (stageIdx < 0) { skipped++; summary.push({ id: s.id, stmt: s.statement_number, stage: -1, tone: "pre-due", channel: "—", status: "skip", reason: "not yet due" }); continue; }

    // Stage gating with perpetual re-fire support:
    //   • Stage hasn't fired yet (stageIdx >= reminder_count) → send.
    //   • Stage has fired AND is the terminal one AND has perpetualEveryDays
    //     set → re-fire once enough time has passed.
    //   • Otherwise skip (moved past this stage, or stage isn't perpetual).
    const stage = STAGES[stageIdx];
    const remCount = s.reminder_count || 0;
    const isFirstFire = stageIdx >= remCount;
    const isPerpetualRefire =
      !isFirstFire && stage.perpetualEveryDays !== undefined && stageIdx === STAGES.length - 1;
    if (!isFirstFire && !isPerpetualRefire) {
      skipped++; summary.push({ id: s.id, stmt: s.statement_number, stage: stageIdx, tone: "—", channel: "—", status: "skip", reason: "stage already sent" });
      continue;
    }

    // Throttle:
    //   • Perpetual re-fires: gate by the stage's own cadence (e.g. 3 days).
    //   • All other sends: 48h base throttle to prevent accidental double-fires.
    if (!force && s.last_reminder_sent_at) {
      const lastMs = Date.parse(s.last_reminder_sent_at as string);
      const elapsedMs = Date.now() - lastMs;
      const minIntervalMs = isPerpetualRefire
        ? (stage.perpetualEveryDays as number) * 24 * 60 * 60 * 1000
        : 48 * 60 * 60 * 1000;
      if (elapsedMs < minIntervalMs) {
        const reason = isPerpetualRefire
          ? `<${stage.perpetualEveryDays}d since last (perpetual cadence)`
          : "<48h since last";
        skipped++; summary.push({ id: s.id, stmt: s.statement_number, stage: stageIdx, tone: stage.toneLabel, channel: "—", status: "skip", reason });
        continue;
      }
    }

    if (dry) {
      summary.push({ id: s.id, stmt: s.statement_number, stage: stageIdx, tone: STAGES[stageIdx].toneLabel, channel: STAGES[stageIdx].whatsApp ? "email+wa" : "email", status: "would-send" });
      continue;
    }

    const r = await sendOneReminder(admin, {
      statement: s, stageIdx, appUrl, triggeredBy: "cron", triggeredByUserId: null, ccPools,
    });
    if (!r.emailSent && !r.whatsAppSent) {
      errors++;
      summary.push({ id: s.id, stmt: s.statement_number, stage: stageIdx, tone: r.toneLabel, channel: "email+wa", status: "error" });
    } else {
      sent++;
      summary.push({
        id: s.id, stmt: s.statement_number, stage: stageIdx, tone: r.toneLabel,
        channel: `${r.emailSent ? "email" : ""}${r.emailSent && r.whatsAppSent ? "+" : ""}${r.whatsAppSent ? "wa" : ""}`,
        status: "sent",
      });
    }
  }

  // ── Second pass: deposits, top-ups and ad-hoc PIs ──────────────────────
  // These live outside billing_statements and were historically undunned.
  // Handled by their own dispatcher so this cron's statement path — which
  // drives live monthly invoicing — stays untouched.
  const other = await runOtherReceivablesPass(admin, { dry, force, ccPools });
  sent += other.sent; skipped += other.skipped; errors += other.errors;

  const todayIst = new Date(Date.now() + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10);
  await pingCronHealth("payment-reminder", errors > 0 ? "error" : "ok", { sent, skipped, errors });
  return NextResponse.json({
    date: todayIst, dry,
    considered: (statements || []).length + other.considered,
    sent, skipped, errors,
    summary, other_summary: other.summary,
  });
}

interface OtherPassOpts {
  dry: boolean;
  force: boolean;
  ccPools: { accounts: string[]; managerAndAdmin: string[]; adminOnly: string[] };
}

async function runOtherReceivablesPass(
  admin: SupabaseClient,
  { dry, force, ccPools }: OtherPassOpts,
) {
  const rows = await fetchDunnableReceivables(admin);
  let sent = 0, skipped = 0, errors = 0;
  const summary: { kind: string; ref: string; stage: number; status: string; reason?: string }[] = [];

  for (const r of rows) {
    if (!r.followup_enabled) {
      skipped++;
      summary.push({ kind: r.kind, ref: r.reference, stage: -1, status: "skip", reason: "follow-up disabled" });
      continue;
    }
    if (!r.email && !r.phone) {
      skipped++;
      summary.push({ kind: r.kind, ref: r.reference, stage: -1, status: "skip", reason: "no contact" });
      continue;
    }
    if (!r.due_date) {
      skipped++;
      summary.push({ kind: r.kind, ref: r.reference, stage: -1, status: "skip", reason: "no due date" });
      continue;
    }

    const days = daysOverdueFromDueDate(r.due_date);
    const stageIdx = pickStageForKind(r.kind, days);
    const gate = shouldFire(r.kind, stageIdx, r.reminder_count, r.last_reminder_sent_at, force);
    if (!gate.fire) {
      skipped++;
      summary.push({ kind: r.kind, ref: r.reference, stage: stageIdx, status: "skip", reason: gate.reason });
      continue;
    }

    if (dry) {
      summary.push({ kind: r.kind, ref: r.reference, stage: stageIdx, status: "would-send" });
      continue;
    }

    const res = await sendReceivableReminder(admin, {
      kind: r.kind, id: r.id, reference: r.reference, partyName: r.party_name,
      email: r.email, phone: r.phone, amount: r.amount, dueDate: r.due_date,
      daysOverdue: days, stageIdx, payLinkUrl: r.payment_link_url,
      triggeredBy: "cron", triggeredByUserId: null, ccPools,
    });
    if (!res.emailSent && !res.whatsAppSent) {
      errors++;
      summary.push({ kind: r.kind, ref: r.reference, stage: stageIdx, status: "error", reason: res.errors[0] });
    } else {
      sent++;
      summary.push({ kind: r.kind, ref: r.reference, stage: stageIdx, status: "sent" });
    }
  }

  return { considered: rows.length, sent, skipped, errors, summary };
}
