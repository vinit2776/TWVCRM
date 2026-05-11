import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { resend, EMAIL_FROM, EMAIL_REPLY_TO } from "@/lib/mailer";
import { pingCronHealth } from "@/lib/cron-ping";
import { listVendorsMissingEmail, loadVendorEmailNagSettings } from "@/lib/finance-intelligence";

export const maxDuration = 60;

/**
 * GET /api/cron/vendor-email-digest
 *
 * Runs every Monday morning via Vercel cron (schedule: "0 4 * * 1" → 9:30 AM IST).
 * Sends a single digest to `digest_recipients` listing vendors who lack a
 * contact_email, ranked by how painful that gap is (pending bills first,
 * then dismissal frequency, then most recent activity).
 *
 * Body of email:
 *   • Headline: count of gaps + high-priority count
 *   • Table: vendor name, pending bills, 90-day spend, last bill date
 *   • CTA: link to /accounting/vendor-email-audit
 *
 * Skipped if fi_vendor_email_digest_enabled is false or no recipients
 * are configured.
 */

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

function rupees(n: number): string {
  return n.toLocaleString("en-IN", { maximumFractionDigits: 0 });
}

export async function GET(request: NextRequest) {
  if (!isAuthorised(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = await createAdminClient();

  // Feature gate
  const settings = await loadVendorEmailNagSettings(supabase);
  if (!settings.enabled || !settings.digest_enabled) {
    await pingCronHealth("vendor-email-digest", "ok", { reason: "feature disabled" });
    return NextResponse.json({ skipped: true, reason: "feature disabled" });
  }

  // Recipients (re-use the existing digest list)
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
    await pingCronHealth("vendor-email-digest", "error", { reason: "no recipients" });
    return NextResponse.json({ error: "No digest_recipients configured" }, { status: 400 });
  }

  const gaps = await listVendorsMissingEmail(supabase);
  if (gaps.length === 0) {
    await pingCronHealth("vendor-email-digest", "ok", { reason: "no gaps" });
    return NextResponse.json({ skipped: true, reason: "no vendor email gaps" });
  }

  const highPriority = gaps.filter((g) => g.pending_bills_count > 0).length;
  const totalBilled = gaps.reduce((s, g) => s + g.total_billed_last_90d, 0);

  // ── Render HTML email ──
  const rows = gaps
    .slice(0, 25) // cap to avoid mega-emails
    .map(
      (g) => `
      <tr>
        <td style="padding:6px 8px;border-bottom:1px solid #e5e7eb;">${escapeHtml(g.vendor_name)}</td>
        <td style="padding:6px 8px;border-bottom:1px solid #e5e7eb;text-align:center;color:${
          g.pending_bills_count > 0 ? "#b91c1c;font-weight:600" : "#6b7280"
        }">${g.pending_bills_count}</td>
        <td style="padding:6px 8px;border-bottom:1px solid #e5e7eb;text-align:right;">${g.bills_last_90d}</td>
        <td style="padding:6px 8px;border-bottom:1px solid #e5e7eb;text-align:right;">₹${rupees(g.total_billed_last_90d)}</td>
        <td style="padding:6px 8px;border-bottom:1px solid #e5e7eb;text-align:center;color:${
          g.dismissals_in_window > 0 ? "#b45309;font-weight:600" : "#9ca3af"
        }">${g.dismissals_in_window || "—"}</td>
      </tr>`,
    )
    .join("");

  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || "https://twv-crm.vercel.app";
  const auditUrl = `${baseUrl}/accounting/vendor-email-audit`;

  const html = `
  <div style="font-family:-apple-system,BlinkMacSystemFont,Helvetica,Arial,sans-serif;max-width:680px;margin:0 auto;color:#111827;">
    <h2 style="color:#b45309;margin:0 0 8px 0;">Vendor Email Audit — Weekly Digest</h2>
    <p style="margin:0 0 16px 0;color:#374151;">
      <strong>${gaps.length}</strong> vendor${gaps.length === 1 ? " has" : "s have"} no email address on file
      ${
        highPriority > 0
          ? `· <span style="color:#b91c1c;font-weight:600;">${highPriority} with pending bills</span>`
          : ""
      }
      · ₹${rupees(totalBilled)} billed in last 90 days
    </p>
    <p style="margin:0 0 16px 0;color:#374151;">
      Payment confirmations cannot reach these vendors until their email is added.
      The accounts team can fix all of them in one go from the audit page.
    </p>

    <table style="width:100%;border-collapse:collapse;font-size:13px;">
      <thead>
        <tr style="background:#f9fafb;">
          <th style="padding:8px;text-align:left;border-bottom:2px solid #d1d5db;">Vendor</th>
          <th style="padding:8px;text-align:center;border-bottom:2px solid #d1d5db;">Pending</th>
          <th style="padding:8px;text-align:right;border-bottom:2px solid #d1d5db;">90-day bills</th>
          <th style="padding:8px;text-align:right;border-bottom:2px solid #d1d5db;">Value</th>
          <th style="padding:8px;text-align:center;border-bottom:2px solid #d1d5db;">Skipped</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>

    ${
      gaps.length > 25
        ? `<p style="margin-top:12px;color:#6b7280;font-size:12px;">Showing top 25 of ${gaps.length} — see all on the audit page.</p>`
        : ""
    }

    <div style="margin-top:20px;padding:16px;background:#f3f4f6;border-radius:8px;text-align:center;">
      <a href="${auditUrl}" style="display:inline-block;background:#b45309;color:#fff;padding:10px 20px;text-decoration:none;border-radius:6px;font-weight:600;">
        Open Audit Page →
      </a>
    </div>

    <p style="margin-top:16px;color:#9ca3af;font-size:11px;">
      This digest is sent weekly. You can toggle it off in app_settings (key: fi_vendor_email_digest_enabled).
    </p>
  </div>`;

  try {
    await resend.emails.send({
      from: EMAIL_FROM,
      replyTo: EMAIL_REPLY_TO,
      to: recipients,
      subject: `Vendor Email Audit — ${gaps.length} gap${gaps.length === 1 ? "" : "s"}${highPriority > 0 ? ` (${highPriority} urgent)` : ""}`,
      html,
    });
    await pingCronHealth("vendor-email-digest", "ok", {
      count: gaps.length,
      high_priority: highPriority,
      recipients: recipients.length,
    });
    return NextResponse.json({ ok: true, sent_to: recipients.length, vendors_listed: gaps.length });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await pingCronHealth("vendor-email-digest", "error", { error: msg });
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
