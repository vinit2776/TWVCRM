import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { resend, EMAIL_FROM, EMAIL_REPLY_TO } from "@/lib/mailer";
import { pingCronHealth } from "@/lib/cron-ping";

export const maxDuration = 60;

const APP_URL = (process.env.NEXT_PUBLIC_APP_URL || "https://twv-crm.vercel.app").trim();

function toISTDate(utcNow: Date): string {
  const istOffset = 5.5 * 60 * 60 * 1000;
  return new Date(utcNow.getTime() + istOffset).toISOString().slice(0, 10);
}

function daysBetween(from: string, to: string): number {
  return Math.floor(
    (new Date(to).getTime() - new Date(from).getTime()) / 86_400_000
  );
}

function fmtCurrency(n: number): string {
  return "₹" + n.toLocaleString("en-IN", { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

function fmtDate(d: string): string {
  return new Date(d + "T00:00:00").toLocaleDateString("en-IN", {
    day: "numeric", month: "short", year: "numeric",
  });
}

function agingLabel(days: number): { label: string; color: string; bg: string } {
  if (days <= 0) return { label: `Due in ${Math.abs(days)}d`, color: "#6b7280", bg: "#f3f4f6" };
  if (days <= 30) return { label: `${days}d overdue`, color: "#92400e", bg: "#fef3c7" };
  if (days <= 60) return { label: `${days}d overdue`, color: "#9a3412", bg: "#ffedd5" };
  if (days <= 90) return { label: `${days}d overdue`, color: "#7f1d1d", bg: "#fee2e2" };
  return { label: `${days}d overdue`, color: "#ffffff", bg: "#991b1b" };
}

type Row = {
  statementId: string;
  statementNumber: string;
  periodStart: string;
  periodEnd: string;
  dueDate: string;
  totalAmount: number;
  amountPaid: number;
  amountPending: number;
  daysOverdue: number;
  contractId: string;
  contractNumber: string;
  contractStart: string;
  contractEnd: string;
  customerName: string;
  company: string | null;
  email: string | null;
  phone: string | null;
  reminderEmail: number;
  reminderWhatsapp: number;
  reminderSms: number;
  avgCollectionDays: number | null;
};

/**
 * GET /api/cron/pending-payment-report
 *
 * Daily 9 AM IST pending-payment summary sent to admin, manager, and accounts
 * users. Covers all unpaid / partially-paid finalized statements.
 *
 * Query params:
 *   ?dry=1       — build report, skip sending
 *   ?to=email    — override recipients (test send to a single address)
 */
export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const params = new URL(request.url).searchParams;
  const dry = params.get("dry") === "1";
  const toOverride = params.get("to") || null;
  const admin = createAdminClient();
  const todayIST = toISTDate(new Date());

  // ── 1. Recipients ────────────────────────────────────────────────────────────
  const { data: users } = await admin
    .from("users")
    .select("email, full_name")
    .in("role", ["admin", "manager", "accounts"])
    .eq("is_active", true);

  const allRecipients = (users || []).map((u) => u.email).filter(Boolean) as string[];
  const recipients = toOverride ? [toOverride] : allRecipients;
  if (!recipients.length) {
    return NextResponse.json({ skipped: "No active admin/manager/accounts users found" });
  }

  // ── 2. Unpaid statements ─────────────────────────────────────────────────────
  const { data: statements, error: stmtErr } = await admin
    .from("billing_statements")
    .select(`
      id, statement_number, period_start, period_end, due_date,
      total_amount, payment_status, finalized_at,
      contract:contracts!billing_statements_contract_id_fkey(
        id, contract_number, start_date, end_date,
        lead:leads!contracts_lead_id_fkey(
          first_name, last_name, company, email, phone, mobile
        )
      ),
      billing_payments(amount, payment_date)
    `)
    .in("status", ["finalized", "exported"])
    .in("payment_status", ["unpaid", "partially_paid"])
    .is("voided_at", null)
    .not("due_date", "is", null);

  if (stmtErr || !statements?.length) {
    await pingCronHealth("pending-payment-report", stmtErr ? "error" : "ok");
    if (stmtErr) return NextResponse.json({ error: stmtErr.message }, { status: 500 });
    return NextResponse.json({ sent: 0, message: "No pending statements — nothing to report" });
  }

  const statementIds = statements.map((s) => s.id);

  // ── 3. Reminder send counts ───────────────────────────────────────────────────
  const { data: reminderRows } = await admin
    .from("billing_reminder_sends")
    .select("billing_statement_id, channel")
    .eq("status", "sent")
    .in("billing_statement_id", statementIds);

  const reminderMap: Record<string, { email: number; whatsapp: number; sms: number }> = {};
  for (const r of reminderRows || []) {
    if (!reminderMap[r.billing_statement_id]) {
      reminderMap[r.billing_statement_id] = { email: 0, whatsapp: 0, sms: 0 };
    }
    if (r.channel === "email") reminderMap[r.billing_statement_id].email++;
    if (r.channel === "whatsapp") reminderMap[r.billing_statement_id].whatsapp++;
    if (r.channel === "sms") reminderMap[r.billing_statement_id].sms++;
  }

  // ── 4. Avg collection days per contract ──────────────────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const contractIds = [...new Set(statements.map((s) => (s.contract as any)?.id).filter(Boolean))] as string[];

  const { data: paidStmts } = await admin
    .from("billing_statements")
    .select("contract_id, finalized_at, billing_payments(amount, payment_date)")
    .in("status", ["finalized", "exported"])
    .eq("payment_status", "paid")
    .not("finalized_at", "is", null)
    .in("contract_id", contractIds);

  const avgCollectionMap: Record<string, number> = {};
  if (paidStmts?.length) {
    const contractDays: Record<string, number[]> = {};
    for (const ps of paidStmts) {
      if (!ps.finalized_at || !ps.billing_payments?.length) continue;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const lastPayment = (ps.billing_payments as any[])
        .map((p: { payment_date: string }) => p.payment_date)
        .sort()
        .at(-1) as string | undefined;
      if (!lastPayment) continue;
      const days = daysBetween(ps.finalized_at.slice(0, 10), lastPayment);
      if (days >= 0) {
        contractDays[ps.contract_id] ??= [];
        contractDays[ps.contract_id].push(days);
      }
    }
    for (const [cid, days] of Object.entries(contractDays)) {
      avgCollectionMap[cid] = Math.round(days.reduce((a, b) => a + b, 0) / days.length);
    }
  }

  // ── 5. Build rows ─────────────────────────────────────────────────────────────
  const rows: Row[] = [];
  for (const s of statements) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const contract: any = s.contract;
    if (!contract) continue;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const lead: any = contract.lead;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const amountPaid = ((s.billing_payments as any[]) || [])
      .reduce((sum: number, p: { amount: number }) => sum + p.amount, 0);
    const amountPending = Math.max(0, s.total_amount - amountPaid);
    if (amountPending <= 0) continue;

    const daysOverdue = daysBetween(s.due_date!, todayIST);
    const rem = reminderMap[s.id] || { email: 0, whatsapp: 0, sms: 0 };

    rows.push({
      statementId: s.id,
      statementNumber: s.statement_number,
      periodStart: s.period_start,
      periodEnd: s.period_end,
      dueDate: s.due_date!,
      totalAmount: s.total_amount,
      amountPaid,
      amountPending,
      daysOverdue,
      contractId: contract.id,
      contractNumber: contract.contract_number,
      contractStart: contract.start_date,
      contractEnd: contract.end_date,
      customerName: lead ? `${lead.first_name} ${lead.last_name}`.trim() : "—",
      company: lead?.company || null,
      email: lead?.email || null,
      phone: lead?.mobile || lead?.phone || null,
      reminderEmail: rem.email,
      reminderWhatsapp: rem.whatsapp,
      reminderSms: rem.sms,
      avgCollectionDays: avgCollectionMap[contract.id] ?? null,
    });
  }

  if (!rows.length) {
    await pingCronHealth("pending-payment-report", "ok");
    return NextResponse.json({ sent: 0, message: "All pending amounts resolved — nothing to report" });
  }

  // Sort: most overdue first
  rows.sort((a, b) => b.daysOverdue - a.daysOverdue);

  // ── 6. Aggregate stats ────────────────────────────────────────────────────────
  const totalPending = rows.reduce((s, r) => s + r.amountPending, 0);
  const uniqueCustomers = new Set(rows.map((r) => r.contractId)).size;

  const aging = {
    notDue:   rows.filter((r) => r.daysOverdue <= 0),
    d0_30:    rows.filter((r) => r.daysOverdue > 0 && r.daysOverdue <= 30),
    d31_60:   rows.filter((r) => r.daysOverdue > 30 && r.daysOverdue <= 60),
    d61_90:   rows.filter((r) => r.daysOverdue > 60 && r.daysOverdue <= 90),
    d90plus:  rows.filter((r) => r.daysOverdue > 90),
  };

  const portfolioAvgDays = Object.values(avgCollectionMap).length
    ? Math.round(
        Object.values(avgCollectionMap).reduce((a, b) => a + b, 0) /
        Object.values(avgCollectionMap).length
      )
    : null;

  // ── 7. Build HTML ─────────────────────────────────────────────────────────────
  function agingRow(label: string, items: Row[], dotColor: string) {
    if (!items.length) return "";
    const amt = items.reduce((s, r) => s + r.amountPending, 0);
    return `
      <tr>
        <td style="padding:8px 14px;font-size:13px;color:#374151;">
          <span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${dotColor};margin-right:8px;vertical-align:middle;"></span>
          ${label}
        </td>
        <td style="padding:8px 14px;font-size:13px;color:#374151;text-align:center;">${items.length}</td>
        <td style="padding:8px 14px;font-size:13px;color:#374151;text-align:right;font-weight:600;">${fmtCurrency(amt)}</td>
      </tr>`;
  }

  function detailRows(): string {
    return rows.map((r) => {
      const aging = agingLabel(r.daysOverdue);
      const contactLinks = [
        r.phone ? `<a href="tel:${r.phone}" style="color:#015E65;text-decoration:none;font-size:11px;margin-right:6px;">📞 Call</a>` : "",
        r.email ? `<a href="mailto:${r.email}" style="color:#015E65;text-decoration:none;font-size:11px;margin-right:6px;">✉ Email</a>` : "",
        r.phone ? `<a href="https://wa.me/91${r.phone.replace(/\D/g, "")}" style="color:#015E65;text-decoration:none;font-size:11px;margin-right:6px;">💬 WA</a>` : "",
      ].join("");
      const reminderBadge = `
        <span style="font-size:10px;color:#6b7280;">
          E:${r.reminderEmail} W:${r.reminderWhatsapp} S:${r.reminderSms}
        </span>`;
      const avgBadge = r.avgCollectionDays !== null
        ? `<span style="font-size:10px;color:#6b7280;">${r.avgCollectionDays}d avg</span>`
        : `<span style="font-size:10px;color:#d1d5db;">—</span>`;
      const viewLink = `<a href="${APP_URL}/contracts/${r.contractId}" style="font-size:11px;color:#015E65;text-decoration:none;">View →</a>`;

      return `
        <tr style="border-bottom:1px solid #f3f4f6;">
          <td style="padding:10px 12px;font-size:12px;">
            <div style="font-weight:600;color:#111827;">${r.customerName}</div>
            ${r.company ? `<div style="color:#6b7280;font-size:11px;">${r.company}</div>` : ""}
            ${r.phone ? `<div style="color:#374151;font-size:11px;font-weight:500;margin-top:2px;">${r.phone}</div>` : ""}
            <div style="margin-top:4px;">${contactLinks}</div>
          </td>
          <td style="padding:10px 12px;font-size:12px;color:#374151;">
            <div style="font-weight:500;">${r.contractNumber}</div>
            <div style="color:#9ca3af;font-size:11px;">${fmtDate(r.contractStart)} – ${fmtDate(r.contractEnd)}</div>
          </td>
          <td style="padding:10px 12px;font-size:12px;color:#374151;">
            <div>${r.statementNumber}</div>
            <div style="color:#9ca3af;font-size:11px;">${fmtDate(r.periodStart)} – ${fmtDate(r.periodEnd)}</div>
          </td>
          <td style="padding:10px 12px;font-size:13px;font-weight:700;color:#111827;text-align:right;">
            ${fmtCurrency(r.amountPending)}
            ${r.amountPaid > 0 ? `<div style="font-size:10px;font-weight:400;color:#6b7280;">of ${fmtCurrency(r.totalAmount)}</div>` : ""}
          </td>
          <td style="padding:10px 12px;text-align:center;">
            <span style="display:inline-block;padding:3px 8px;border-radius:4px;font-size:11px;font-weight:600;background:${aging.bg};color:${aging.color};">
              ${aging.label}
            </span>
          </td>
          <td style="padding:10px 12px;text-align:center;">${avgBadge}</td>
          <td style="padding:10px 12px;text-align:center;">${reminderBadge}</td>
          <td style="padding:10px 12px;text-align:center;">${viewLink}</td>
        </tr>`;
    }).join("");
  }

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f9fafb;font-family:system-ui,sans-serif;">
<div style="max-width:900px;margin:24px auto;border:1px solid #e5e7eb;border-radius:10px;overflow:hidden;background:#fff;">

  <!-- Header -->
  <div style="background:#015E65;padding:24px 32px;">
    <h1 style="color:#fff;margin:0;font-size:20px;font-weight:700;">Pending Payment Report</h1>
    <p style="color:rgba(255,255,255,0.75);margin:6px 0 0;font-size:13px;">${fmtDate(todayIST)} &nbsp;·&nbsp; ${rows.length} invoice${rows.length !== 1 ? "s" : ""} across ${uniqueCustomers} customer${uniqueCustomers !== 1 ? "s" : ""}</p>
  </div>

  <!-- Summary cards -->
  <div style="padding:24px 32px;background:#f0fdfa;border-bottom:1px solid #ccfbf1;display:flex;gap:16px;flex-wrap:wrap;">
    <div style="flex:1;min-width:140px;background:#fff;border:1px solid #e5e7eb;border-radius:8px;padding:16px 20px;text-align:center;">
      <div style="font-size:22px;font-weight:800;color:#015E65;">${fmtCurrency(totalPending)}</div>
      <div style="font-size:11px;color:#6b7280;margin-top:4px;text-transform:uppercase;letter-spacing:.5px;">Total Outstanding</div>
    </div>
    <div style="flex:1;min-width:140px;background:#fff;border:1px solid #e5e7eb;border-radius:8px;padding:16px 20px;text-align:center;">
      <div style="font-size:22px;font-weight:800;color:#374151;">${uniqueCustomers}</div>
      <div style="font-size:11px;color:#6b7280;margin-top:4px;text-transform:uppercase;letter-spacing:.5px;">Customers with Dues</div>
    </div>
    <div style="flex:1;min-width:140px;background:#fff;border:1px solid ${aging.d31_60.length + aging.d61_90.length + aging.d90plus.length > 0 ? "#fca5a5" : "#e5e7eb"};border-radius:8px;padding:16px 20px;text-align:center;">
      <div style="font-size:22px;font-weight:800;color:${aging.d31_60.length + aging.d61_90.length + aging.d90plus.length > 0 ? "#b91c1c" : "#374151"};">${aging.d31_60.length + aging.d61_90.length + aging.d90plus.length}</div>
      <div style="font-size:11px;color:#6b7280;margin-top:4px;text-transform:uppercase;letter-spacing:.5px;">Overdue 30+ Days</div>
    </div>
    <div style="flex:1;min-width:140px;background:#fff;border:1px solid ${aging.d90plus.length > 0 ? "#fca5a5" : "#e5e7eb"};border-radius:8px;padding:16px 20px;text-align:center;">
      <div style="font-size:22px;font-weight:800;color:${aging.d90plus.length > 0 ? "#991b1b" : "#374151"};">${aging.d90plus.length}</div>
      <div style="font-size:11px;color:#6b7280;margin-top:4px;text-transform:uppercase;letter-spacing:.5px;">Critical 90+ Days</div>
    </div>
    ${portfolioAvgDays !== null ? `
    <div style="flex:1;min-width:140px;background:#fff;border:1px solid #e5e7eb;border-radius:8px;padding:16px 20px;text-align:center;">
      <div style="font-size:22px;font-weight:800;color:#374151;">${portfolioAvgDays}d</div>
      <div style="font-size:11px;color:#6b7280;margin-top:4px;text-transform:uppercase;letter-spacing:.5px;">Avg Collection Days</div>
    </div>` : ""}
  </div>

  <!-- Aging breakdown -->
  <div style="padding:20px 32px;border-bottom:1px solid #f3f4f6;">
    <h2 style="font-size:13px;font-weight:700;color:#374151;margin:0 0 12px;text-transform:uppercase;letter-spacing:.5px;">Aging Breakdown</h2>
    <table style="width:100%;border-collapse:collapse;font-size:13px;">
      <tr style="background:#f9fafb;">
        <th style="padding:8px 14px;text-align:left;font-size:11px;color:#6b7280;font-weight:600;text-transform:uppercase;">Bucket</th>
        <th style="padding:8px 14px;text-align:center;font-size:11px;color:#6b7280;font-weight:600;text-transform:uppercase;">Invoices</th>
        <th style="padding:8px 14px;text-align:right;font-size:11px;color:#6b7280;font-weight:600;text-transform:uppercase;">Amount</th>
      </tr>
      ${agingRow("Not yet due", aging.notDue, "#6b7280")}
      ${agingRow("1 – 30 days overdue", aging.d0_30, "#f59e0b")}
      ${agingRow("31 – 60 days overdue", aging.d31_60, "#f97316")}
      ${agingRow("61 – 90 days overdue", aging.d61_90, "#ef4444")}
      ${agingRow("90+ days overdue", aging.d90plus, "#991b1b")}
    </table>
  </div>

  <!-- Detail table -->
  <div style="padding:20px 32px 0;">
    <h2 style="font-size:13px;font-weight:700;color:#374151;margin:0 0 12px;text-transform:uppercase;letter-spacing:.5px;">Invoice Detail (Most Overdue First)</h2>
    <div style="overflow-x:auto;">
      <table style="width:100%;border-collapse:collapse;font-size:12px;">
        <thead>
          <tr style="background:#f9fafb;border-bottom:2px solid #e5e7eb;">
            <th style="padding:10px 12px;text-align:left;font-size:11px;color:#6b7280;font-weight:600;text-transform:uppercase;">Customer</th>
            <th style="padding:10px 12px;text-align:left;font-size:11px;color:#6b7280;font-weight:600;text-transform:uppercase;">Contract</th>
            <th style="padding:10px 12px;text-align:left;font-size:11px;color:#6b7280;font-weight:600;text-transform:uppercase;">Invoice</th>
            <th style="padding:10px 12px;text-align:right;font-size:11px;color:#6b7280;font-weight:600;text-transform:uppercase;">Pending</th>
            <th style="padding:10px 12px;text-align:center;font-size:11px;color:#6b7280;font-weight:600;text-transform:uppercase;">Aging</th>
            <th style="padding:10px 12px;text-align:center;font-size:11px;color:#6b7280;font-weight:600;text-transform:uppercase;">Avg Pay</th>
            <th style="padding:10px 12px;text-align:center;font-size:11px;color:#6b7280;font-weight:600;text-transform:uppercase;">Reminders E/W/S</th>
            <th style="padding:10px 12px;text-align:center;font-size:11px;color:#6b7280;font-weight:600;text-transform:uppercase;"></th>
          </tr>
        </thead>
        <tbody>
          ${detailRows()}
        </tbody>
      </table>
    </div>
  </div>

  <!-- CTA -->
  <div style="padding:24px 32px;text-align:center;border-top:1px solid #f3f4f6;margin-top:20px;">
    <p style="color:#6b7280;font-size:13px;margin:0 0 14px;">Review all outstanding invoices and log payments or send manual reminders from the Receivables page.</p>
    <a href="${APP_URL}/accounting?tab=receivables" style="display:inline-block;background:#015E65;color:#fff;text-decoration:none;padding:10px 24px;border-radius:6px;font-size:13px;font-weight:600;">Open Receivables →</a>
  </div>

  <!-- Footer -->
  <div style="background:#f9fafb;padding:14px 32px;text-align:center;border-top:1px solid #e5e7eb;">
    <p style="color:#9ca3af;font-size:11px;margin:0;">SREE DESIGN INFRASTRUCTURE PVT LTD · The WorkVilla &nbsp;·&nbsp; Daily report as of ${todayIST}</p>
  </div>

</div>
</body>
</html>`;

  if (dry) {
    return NextResponse.json({
      dry: true,
      recipients,
      rows: rows.length,
      totalPending,
      agingSummary: {
        notDue: aging.notDue.length,
        d0_30: aging.d0_30.length,
        d31_60: aging.d31_60.length,
        d61_90: aging.d61_90.length,
        d90plus: aging.d90plus.length,
      },
    });
  }

  const { error: mailErr } = await resend.emails.send({
    from: EMAIL_FROM,
    replyTo: EMAIL_REPLY_TO,
    to: recipients,
    subject: `Pending Payments — ${fmtCurrency(totalPending)} outstanding · ${fmtDate(todayIST)}`,
    html,
  });

  await pingCronHealth("pending-payment-report", mailErr ? "error" : "ok");

  if (mailErr) {
    return NextResponse.json({ error: mailErr.message }, { status: 500 });
  }

  return NextResponse.json({
    sent: recipients.length,
    rows: rows.length,
    totalPending,
  });
}
