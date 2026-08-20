import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { resend, EMAIL_FROM, EMAIL_REPLY_TO } from "@/lib/mailer";
import { pingCronHealth } from "@/lib/cron-ping";

export const maxDuration = 60;

/**
 * GET /api/cron/kyc-reminder
 *
 * Runs every Saturday via Vercel cron (schedule: "0 4 * * 6" → 9:30 AM IST).
 * Collates all required KYC document slots that are still `deferred` or `pending`
 * across all active/signed contracts, then sends a single digest email to the
 * addresses listed in the `digest_recipients` app setting.
 *
 * Each contract row in the email shows:
 *   • Customer name & company
 *   • Contract number
 *   • One row per outstanding document (label, status, deferred reason if any,
 *     deferred-until date if set)
 */

// ─── Auth ─────────────────────────────────────────────────────────────────────

function isAuthorised(request: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true; // dev: no secret = open
  return request.headers.get("authorization") === `Bearer ${secret}`;
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface OutstandingDoc {
  label: string;
  status: "pending" | "deferred";
  deferred_reason: string | null;
  deferred_until: string | null;
}

interface ContractRow {
  contractId: string;
  contractNumber: string;
  customerName: string;
  company: string | null;
  email: string | null;
  locationName: string | null;
  docs: OutstandingDoc[];
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export async function GET(request: NextRequest) {
  if (!isAuthorised(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = await createAdminClient();

  // ── Fetch recipients from app_settings ────────────────────────────────────
  const { data: setting } = await supabase
    .from("app_settings")
    .select("value")
    .eq("key", "digest_recipients")
    .single();

  let recipients: string[] = [];
  try {
    recipients = JSON.parse(setting?.value || "[]");
  } catch {
    recipients = [];
  }

  if (recipients.length === 0) {
    await pingCronHealth("cron/kyc-reminder", "error", { reason: "no recipients configured" });
    return NextResponse.json({ error: "No digest_recipients configured in app_settings" }, { status: 400 });
  }

  // ── Fetch all required, non-compliant KYC docs across active/signed contracts
  const { data: rows, error } = await supabase
    .from("contract_documents")
    .select(`
      id,
      label,
      status,
      deferred_reason,
      deferred_until,
      contract:contracts!contract_documents_contract_id_fkey (
        id,
        contract_number,
        status,
        lead:leads!contracts_lead_id_fkey (
          first_name,
          last_name,
          company,
          email
        ),
        location:locations!contracts_location_id_fkey (
          name
        )
      )
    `)
    .eq("is_required", true)
    .in("status", ["pending", "deferred"])
    .order("contract_id")
    .order("label");

  if (error) {
    await pingCronHealth("cron/kyc-reminder", "error", { error: error.message });
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Filter to only active/signed/pending_activation contracts
  const ACTIVE_STATUSES = ["active", "signed", "pending_activation"];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const filtered = (rows || []).filter((r: any) =>
    r.contract && ACTIVE_STATUSES.includes(r.contract.status)
  );

  if (filtered.length === 0) {
    await pingCronHealth("cron/kyc-reminder", "ok", { reason: "no outstanding KYC items" });
    return NextResponse.json({ sent: 0, contracts: 0, message: "No outstanding KYC items" });
  }

  // ── Group by contract ─────────────────────────────────────────────────────
  const contractMap = new Map<string, ContractRow>();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const row of filtered as any[]) {
    const c = row.contract;
    const lead = c.lead;
    const cId = c.id as string;

    if (!contractMap.has(cId)) {
      const firstName = lead?.first_name || "";
      const lastName = lead?.last_name || "";
      const fullName = [firstName, lastName].filter(Boolean).join(" ") || "Unknown";

      contractMap.set(cId, {
        contractId: cId,
        contractNumber: c.contract_number,
        customerName: fullName,
        company: lead?.company || null,
        email: lead?.email || null,
        locationName: c.location?.name || null,
        docs: [],
      });
    }

    contractMap.get(cId)!.docs.push({
      label: row.label,
      status: row.status as "pending" | "deferred",
      deferred_reason: row.deferred_reason || null,
      deferred_until: row.deferred_until || null,
    });
  }

  const contracts = Array.from(contractMap.values());

  // ── Build and send email ───────────────────────────────────────────────────
  const dateLabel = new Date().toLocaleDateString("en-IN", {
    weekday: "long", day: "numeric", month: "long", year: "numeric",
    timeZone: "Asia/Kolkata",
  });

  const html = buildKycReminderHtml(dateLabel, contracts);
  const subject = `KYC Pending Reminder — ${contracts.length} contract${contracts.length > 1 ? "s" : ""} · ${dateLabel}`;

  let sent = 0;
  for (const email of recipients) {
    try {
      await resend.emails.send({
        from: EMAIL_FROM,
        replyTo: EMAIL_REPLY_TO,
        to: [email],
        subject,
        html,
      });
      sent++;
    } catch (err) {
      console.error(`[kyc-reminder] Failed to send to ${email}:`, err);
    }
  }

  const totalDocs = contracts.reduce((s, c) => s + c.docs.length, 0);
  await pingCronHealth("cron/kyc-reminder", "ok", { sent, contracts: contracts.length, docs: totalDocs });

  return NextResponse.json({
    date: dateLabel,
    recipients: recipients.length,
    sent,
    contracts: contracts.length,
    total_outstanding_docs: totalDocs,
  });
}

// ─── HTML builder ─────────────────────────────────────────────────────────────

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "numeric", month: "short", year: "numeric",
  });
}

function statusPill(status: "pending" | "deferred"): string {
  const isPending = status === "pending";
  const bg    = isPending ? "#fef3c7" : "#fee2e2";
  const color = isPending ? "#92400e" : "#991b1b";
  const label = isPending ? "Pending" : "Deferred";
  return `<span style="display:inline-block;background:${bg};color:${color};font-size:10px;font-weight:600;padding:2px 7px;border-radius:4px;text-transform:uppercase;letter-spacing:0.4px;">${label}</span>`;
}

function buildKycReminderHtml(dateLabel: string, contracts: ContractRow[]): string {
  const totalDocs = contracts.reduce((s, c) => s + c.docs.length, 0);
  const deferredCount = contracts.reduce((s, c) => s + c.docs.filter(d => d.status === "deferred").length, 0);
  const pendingCount  = contracts.reduce((s, c) => s + c.docs.filter(d => d.status === "pending").length,  0);

  const contractsHtml = contracts.map((c) => {
    const docsHtml = c.docs.map((doc) => `
      <tr>
        <td style="padding:9px 12px;border-bottom:1px solid #f3f4f6;font-size:13px;color:#111827;">${doc.label}</td>
        <td style="padding:9px 12px;border-bottom:1px solid #f3f4f6;text-align:center;">${statusPill(doc.status)}</td>
        <td style="padding:9px 12px;border-bottom:1px solid #f3f4f6;font-size:12px;color:#6b7280;">
          ${doc.deferred_reason
            ? `<span style="color:#b45309;">${doc.deferred_reason}</span>`
            : `<span style="color:#d1d5db;">—</span>`}
        </td>
        <td style="padding:9px 12px;border-bottom:1px solid #f3f4f6;font-size:12px;color:#6b7280;white-space:nowrap;">
          ${doc.deferred_until
            ? `<span style="color:#dc2626;font-weight:600;">Until ${fmtDate(doc.deferred_until)}</span>`
            : `<span style="color:#d1d5db;">—</span>`}
        </td>
      </tr>
    `).join("");

    return `
    <div style="border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;margin-bottom:20px;">
      <!-- Contract header -->
      <div style="background:#015E65;padding:12px 16px;display:flex;align-items:center;justify-content:space-between;">
        <div>
          <span style="color:#ffffff;font-size:15px;font-weight:700;">${c.customerName}</span>
          ${c.company ? `<span style="color:rgba(255,255,255,0.7);font-size:12px;margin-left:8px;">${c.company}</span>` : ""}
        </div>
        <div style="text-align:right;">
          <span style="background:rgba(255,255,255,0.15);color:#ffffff;font-size:11px;font-weight:600;padding:3px 10px;border-radius:4px;">${c.contractNumber}</span>
          ${c.locationName ? `<div style="color:rgba(255,255,255,0.6);font-size:11px;margin-top:4px;">${c.locationName}</div>` : ""}
        </div>
      </div>

      <!-- KYC docs table -->
      <table style="width:100%;border-collapse:collapse;">
        <tr style="background:#f9fafb;">
          <td style="padding:8px 12px;font-size:11px;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:0.4px;border-bottom:1px solid #e5e7eb;">Document</td>
          <td style="padding:8px 12px;font-size:11px;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:0.4px;border-bottom:1px solid #e5e7eb;text-align:center;width:90px;">Status</td>
          <td style="padding:8px 12px;font-size:11px;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:0.4px;border-bottom:1px solid #e5e7eb;">Reason</td>
          <td style="padding:8px 12px;font-size:11px;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:0.4px;border-bottom:1px solid #e5e7eb;width:120px;">Deferred Until</td>
        </tr>
        ${docsHtml}
      </table>

      ${c.email ? `
      <div style="background:#f9fafb;padding:8px 14px;border-top:1px solid #f3f4f6;">
        <span style="font-size:11px;color:#9ca3af;">Customer email: </span>
        <a href="mailto:${c.email}" style="font-size:11px;color:#015E65;">${c.email}</a>
      </div>` : ""}
    </div>`;
  }).join("");

  return `
<div style="font-family:'Segoe UI',Arial,sans-serif;max-width:700px;margin:0 auto;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;background:#ffffff;">

  <!-- Header -->
  <div style="background:#015E65;padding:24px 32px;">
    <h1 style="color:#ffffff;margin:0;font-size:20px;font-weight:700;">The WorkVilla</h1>
    <p style="color:#00AE6C;margin:6px 0 0;font-size:13px;font-weight:500;">Weekly KYC Compliance Reminder</p>
    <p style="color:rgba(255,255,255,0.8);margin:4px 0 0;font-size:12px;">${dateLabel}</p>
  </div>

  <div style="padding:28px 32px;">

    <!-- Summary strip -->
    <table style="width:100%;border-collapse:collapse;margin-bottom:28px;border:1px solid #fca5a5;border-radius:8px;overflow:hidden;">
      <tr>
        <td style="padding:16px 20px;text-align:center;border-right:1px solid #fca5a5;background:#fff5f5;">
          <p style="margin:0;color:#9ca3af;font-size:10px;text-transform:uppercase;letter-spacing:0.5px;">Contracts with gaps</p>
          <p style="margin:4px 0 0;color:#dc2626;font-size:28px;font-weight:700;line-height:1;">${contracts.length}</p>
        </td>
        <td style="padding:16px 20px;text-align:center;border-right:1px solid #fca5a5;background:#fffbeb;">
          <p style="margin:0;color:#9ca3af;font-size:10px;text-transform:uppercase;letter-spacing:0.5px;">Pending</p>
          <p style="margin:4px 0 0;color:#d97706;font-size:28px;font-weight:700;line-height:1;">${pendingCount}</p>
          <p style="margin:4px 0 0;color:#6b7280;font-size:10px;">not yet submitted</p>
        </td>
        <td style="padding:16px 20px;text-align:center;background:#fff5f5;">
          <p style="margin:0;color:#9ca3af;font-size:10px;text-transform:uppercase;letter-spacing:0.5px;">Deferred</p>
          <p style="margin:4px 0 0;color:#dc2626;font-size:28px;font-weight:700;line-height:1;">${deferredCount}</p>
          <p style="margin:4px 0 0;color:#6b7280;font-size:10px;">accepted with reason</p>
        </td>
      </tr>
    </table>

    <p style="color:#374151;font-size:13px;margin:0 0 24px;line-height:1.6;">
      The following contracts have required KYC documents that are either not yet submitted (<strong>Pending</strong>)
      or have been accepted with a deferral reason (<strong>Deferred</strong>). Please follow up with the respective
      customers to collect the outstanding documents.
    </p>

    <!-- Per-contract sections -->
    ${contractsHtml}

    <p style="color:#9ca3af;font-size:11px;margin:24px 0 0;text-align:center;">
      ${totalDocs} outstanding document${totalDocs !== 1 ? "s" : ""} across ${contracts.length} contract${contracts.length !== 1 ? "s" : ""}
      &nbsp;·&nbsp; View contracts at
      <a href="${process.env.NEXT_PUBLIC_APP_URL || "https://twv-crm.vercel.app"}/contracts" style="color:#015E65;">twv-crm.vercel.app/contracts</a>
    </p>

  </div>

  <!-- Footer -->
  <div style="background:#015E65;padding:16px 32px;text-align:center;">
    <p style="color:#ffffff;margin:0;font-size:11px;">SREE DESIGN INFRASTRUCTURE PVT LTD</p>
    <p style="color:rgba(255,255,255,0.7);margin:4px 0 0;font-size:10px;">Prakash Presidium, 110, MG Road, Nungambakkam, Chennai - 600034 | +91 97910 97900</p>
    <p style="color:#00AE6C;margin:4px 0 0;font-size:10px;">www.theworkvilla.com</p>
  </div>

</div>`;
}
