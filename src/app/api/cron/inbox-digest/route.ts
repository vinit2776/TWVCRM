import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { resend, EMAIL_FROM, EMAIL_REPLY_TO } from "@/lib/mailer";
import { formatCurrency } from "@/lib/utils";
import {
  AGING_ESCALATE_HOURS,
  HANDOFF_STATE_LABELS,
  INBOX_OPEN_STATES,
  bucketFor,
  type HandoffState,
} from "@/lib/tally-handoff";
import { isHandoffV2Enabled } from "@/lib/tally-handoff-server";
import { withCronHealth } from "@/lib/cron-ping";

/**
 * GET /api/cron/inbox-digest
 *
 * Daily 09:30 IST (04:00 UTC) sweep of open Accounts Inbox items. Sends a
 * single digest email to the accounts inbox with:
 *   - Counts per bucket
 *   - Table of every open item (party, statement, state, amount, aging)
 *   - Aging > 48h items flagged in red
 *   - Link to /accounting/inbox
 *
 * Skipped silently if:
 *   - tally_handoff_v2_enabled is false (legacy mode, no inbox)
 *   - There are zero open items (no point pinging accounts about nothing)
 *
 * Vercel cron schedule: "0 4 * * *" (in vercel.json).
 */

export const maxDuration = 60;
export const dynamic = "force-dynamic";

const ACCOUNTS_INBOX_EMAIL = EMAIL_REPLY_TO;

function isAuthorised(request: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true; // dev: open
  return request.headers.get("authorization") === `Bearer ${secret}`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );
}

interface DigestRow {
  statement_id: string;
  statement_number: string | null;
  total_amount: number;
  handoff_state: HandoffState;
  updated_at: string;
  contract: {
    contract_number: string | null;
    lead: { first_name: string | null; last_name: string | null; company: string | null } | null;
  } | null;
}

async function handler(request: NextRequest) {
  if (!isAuthorised(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = await createAdminClient();

  if (!(await isHandoffV2Enabled(supabase))) {
    return NextResponse.json({ skipped: "v2 not enabled" });
  }

  const { data, error } = await supabase
    .from("billing_statements")
    .select(`
      id, statement_number, total_amount, handoff_state, updated_at,
      contract:contracts!billing_statements_contract_id_fkey(
        contract_number,
        lead:leads!contracts_lead_id_fkey(first_name, last_name, company)
      )
    `)
    .in("handoff_state", INBOX_OPEN_STATES as readonly string[])
    .order("updated_at", { ascending: true });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const rows = ((data || []) as unknown as Array<{
    id: string;
    statement_number: string | null;
    total_amount: number;
    handoff_state: HandoffState;
    updated_at: string;
    contract: {
      contract_number: string | null;
      lead: { first_name: string | null; last_name: string | null; company: string | null } | null;
    } | null;
  }>).map((r): DigestRow => ({
    statement_id: r.id,
    statement_number: r.statement_number,
    total_amount: Number(r.total_amount),
    handoff_state: r.handoff_state,
    updated_at: r.updated_at,
    contract: r.contract,
  }));

  if (rows.length === 0) {
    return NextResponse.json({ skipped: "no open items" });
  }

  // ── Buckets + counts ─────────────────────────────────────────────────────
  const now = Date.now();
  let gstToIssue = 0;
  let paymentsToRecord = 0;
  let agingOver48h = 0;

  for (const r of rows) {
    const bucket = bucketFor(r.handoff_state, false);
    if (bucket === "gst_to_issue") gstToIssue += 1;
    else if (bucket === "payment_to_record") paymentsToRecord += 1;
    const agingHours = Math.round((now - Date.parse(r.updated_at)) / 3_600_000);
    if (agingHours >= AGING_ESCALATE_HOURS) agingOver48h += 1;
  }

  // ── Compose email ────────────────────────────────────────────────────────
  const appUrl = (process.env.NEXT_PUBLIC_APP_URL || process.env.APP_URL || "https://twv-crm.vercel.app").trim();
  const subject = `[Tally inbox] ${rows.length} open item${rows.length === 1 ? "" : "s"}${agingOver48h > 0 ? ` · ${agingOver48h} aging > 48h` : ""}`;

  const tableRows = rows.map((r) => {
    const partyName =
      r.contract?.lead?.company
      || [r.contract?.lead?.first_name, r.contract?.lead?.last_name].filter(Boolean).join(" ")
      || "(unnamed)";
    const agingHours = Math.round((now - Date.parse(r.updated_at)) / 3_600_000);
    const agingDisplay = agingHours < 1 ? "just now" : agingHours < 24 ? `${agingHours}h` : `${Math.floor(agingHours / 24)}d`;
    const agingStyle = agingHours >= AGING_ESCALATE_HOURS ? "color:#a32d2d;font-weight:500;" : "color:#666;";
    return `
      <tr style="border-top:1px solid #eee;">
        <td style="padding:8px 12px 8px 0;">${escapeHtml(partyName)}</td>
        <td style="padding:8px 12px;color:#666;font-size:12px;">${escapeHtml(r.contract?.contract_number ?? "—")}<br/>${escapeHtml(r.statement_number ?? "")}</td>
        <td style="padding:8px 12px;font-size:13px;">${escapeHtml(HANDOFF_STATE_LABELS[r.handoff_state])}</td>
        <td style="padding:8px 12px;text-align:right;font-variant-numeric:tabular-nums;">${formatCurrency(r.total_amount)}</td>
        <td style="padding:8px 12px;text-align:right;${agingStyle}">${agingDisplay}</td>
      </tr>
    `;
  }).join("");

  const html = `
    <div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#111;">
      <h2 style="margin:0 0 8px;font-size:18px;font-weight:500;">Tally Inbox — daily digest</h2>
      <p style="margin:0 0 16px;color:#666;font-size:14px;">
        ${rows.length} open item${rows.length === 1 ? "" : "s"} as of ${new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })} IST.
      </p>

      <table style="border-collapse:collapse;margin:0 0 16px;font-size:14px;">
        <tr>
          <td style="padding:6px 16px 6px 0;color:#666;">GST to issue</td>
          <td><strong>${gstToIssue}</strong></td>
        </tr>
        <tr>
          <td style="padding:6px 16px 6px 0;color:#666;">Payments to record</td>
          <td><strong>${paymentsToRecord}</strong></td>
        </tr>
        ${agingOver48h > 0 ? `
        <tr>
          <td style="padding:6px 16px 6px 0;color:#a32d2d;">Aging &gt; 48h</td>
          <td><strong style="color:#a32d2d;">${agingOver48h}</strong></td>
        </tr>` : ""}
      </table>

      <table style="border-collapse:collapse;width:100%;font-size:13px;border-top:1px solid #ddd;">
        <thead>
          <tr style="background:#f5f5f5;">
            <th style="padding:8px 12px 8px 0;text-align:left;font-weight:500;">Customer</th>
            <th style="padding:8px 12px;text-align:left;font-weight:500;">Contract / Statement</th>
            <th style="padding:8px 12px;text-align:left;font-weight:500;">State</th>
            <th style="padding:8px 12px;text-align:right;font-weight:500;">Amount</th>
            <th style="padding:8px 12px;text-align:right;font-weight:500;">Aging</th>
          </tr>
        </thead>
        <tbody>${tableRows}</tbody>
      </table>

      <p style="margin:24px 0 0;">
        <a href="${appUrl}/accounting/inbox" style="display:inline-block;padding:10px 20px;background:#111;color:#fff;text-decoration:none;border-radius:4px;">Open Tally Inbox</a>
      </p>
    </div>
  `;

  const result = await resend.emails.send({
    from: EMAIL_FROM,
    to: ACCOUNTS_INBOX_EMAIL,
    subject,
    html,
  });

  if (result.error) {
    return NextResponse.json({ error: result.error.message, rows: rows.length }, { status: 500 });
  }

  return NextResponse.json({
    sent: true,
    to: ACCOUNTS_INBOX_EMAIL,
    open_items: rows.length,
    gst_to_issue: gstToIssue,
    payments_to_record: paymentsToRecord,
    aging_over_48h: agingOver48h,
  });
}

export const GET = withCronHealth("cron/inbox-digest", handler);
