import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { resend, EMAIL_FROM, EMAIL_REPLY_TO } from "@/lib/mailer";
import { pingCronHealth } from "@/lib/cron-ping";
import {
  evaluateChannel,
  shouldAlert,
  fetchMsg91Templates,
  findTemplateIssues,
  evaluateTemplates,
  templateAlerts,
  mergeTemplateHealth,
  HEALTH_WINDOW_HOURS,
  TEMPLATE_WINDOW_DAYS,
  type ChannelHealth,
  type ChannelStatus,
  type TemplateIssue,
  type TemplateAlert,
  type StoredTemplateState,
} from "@/lib/messaging-health";

/**
 * GET /api/cron/messaging-health
 *
 * Watches the outbound failure rate of each MSG91 channel and emails admins
 * when one goes down or recovers. Runs every 30 minutes (see vercel.json).
 *
 * Alerts fire on a state TRANSITION, tracked in messaging_health_state — a
 * multi-day outage produces one email, not one every half hour. See
 * src/lib/messaging-health.ts for why this monitor exists at all.
 *
 * The MSG91 template audit is a secondary check on the same tick: a template
 * flipping to REJECTED takes down one message type while the channel's overall
 * rate still looks healthy. It is best-effort — a template API failure must
 * not stop the failure-rate alert, which is the load-bearing half.
 */

const ALERT_RECIPIENTS = (process.env.MESSAGING_ALERT_EMAILS ?? "admin@theworkvilla.com")
  .split(",")
  .map((e) => e.trim())
  .filter(Boolean);

const CHANNELS = ["whatsapp", "sms"] as const;
type Channel = (typeof CHANNELS)[number];

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const admin = createAdminClient();
  const now = new Date();
  const since = new Date(now.getTime() - HEALTH_WINDOW_HOURS * 3_600_000).toISOString();

  const { data: rows, error } = await admin
    .from("whatsapp_messages")
    .select("channel, status, error_message")
    .eq("direction", "outbound")
    .gte("created_at", since);

  if (error) {
    console.error("[messaging-health] message fetch failed:", error.message);
    await pingCronHealth("cron/messaging-health", "error", { error: error.message });
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Per-template health needs a much longer window than the channel rate — a
  // low-volume template like gst_invoice_doc sends a handful of times a week,
  // so a 6h window would never reach MIN_SAMPLE_SIZE and would read "idle"
  // forever. See TEMPLATE_WINDOW_DAYS.
  const templateSince = new Date(now.getTime() - TEMPLATE_WINDOW_DAYS * 86_400_000).toISOString();
  const { data: templateRows, error: templateErr } = await admin
    .from("whatsapp_messages")
    .select("channel, status, error_message, template_name")
    .eq("direction", "outbound")
    .eq("channel", "whatsapp")
    .gte("created_at", templateSince);

  if (templateErr) {
    // Non-fatal: the channel check below is the load-bearing half.
    console.error("[messaging-health] template window fetch failed:", templateErr.message);
  }
  const templateHealth = evaluateTemplates(templateRows ?? []);

  // Template audit — best-effort, and only meaningful for WhatsApp.
  let templateIssues: TemplateIssue[] = [];
  let templatesChecked = false;
  const authKey = process.env.MSG91_AUTH_KEY?.trim();
  const sender = process.env.MSG91_WHATSAPP_SENDER?.trim();
  if (authKey && sender) {
    try {
      const remote = await fetchMsg91Templates(sender, authKey);
      templateIssues = findTemplateIssues(remote, [
        process.env.MSG91_WA_TEMPLATE_FACILITY_NUDGE?.trim() ?? "",
        process.env.MSG91_WA_TEMPLATE_FACILITY_ASSIGNED?.trim() ?? "",
      ]);
      templatesChecked = true;
    } catch (err) {
      console.error("[messaging-health] template audit failed:", err);
    }
  }

  const results: Record<string, ChannelHealth & { alerted: boolean }> = {};
  const alerts: Array<{ channel: Channel; previous: ChannelStatus | null; health: ChannelHealth }> = [];
  let tplAlerts: TemplateAlert[] = [];
  let mergedTemplateHealth: Record<string, StoredTemplateState> = {};

  for (const channel of CHANNELS) {
    const health = evaluateChannel((rows ?? []).filter((r) => r.channel === channel));

    const { data: prior } = await admin
      .from("messaging_health_state")
      .select("last_alerted_status, template_health")
      .eq("channel", channel)
      .maybeSingle();

    const previous = (prior?.last_alerted_status as ChannelStatus | null) ?? null;
    const alerting = shouldAlert(previous, health.status);

    if (alerting) alerts.push({ channel, previous, health });

    // Per-template transitions live on the WhatsApp row only — SMS templates
    // are DLT flows, already covered by the channel rate.
    if (channel === "whatsapp") {
      const priorMap = (prior?.template_health ?? {}) as Record<string, StoredTemplateState | undefined>;
      tplAlerts = templateAlerts(templateHealth, priorMap);
      mergedTemplateHealth = mergeTemplateHealth(priorMap, templateHealth, tplAlerts, now.toISOString());
    }

    await admin.from("messaging_health_state").upsert(
      {
        channel,
        status: health.status,
        fail_rate: Number(health.failRate.toFixed(4)),
        sample_size: health.sampleSize,
        failed_count: health.failedCount,
        dominant_error: health.dominantError,
        // Only WhatsApp templates are audited; don't blank the column for SMS.
        ...(channel === "whatsapp" && templatesChecked
          ? { template_issues: templateIssues, templates_checked_at: now.toISOString() }
          : {}),
        ...(channel === "whatsapp" ? { template_health: mergedTemplateHealth } : {}),
        // Only advance the alerted status when we actually sent an email, so a
        // channel that flaps below the alert rules doesn't lose its baseline.
        ...(alerting
          ? { last_alerted_status: health.status, last_alerted_at: now.toISOString() }
          : {}),
        last_checked_at: now.toISOString(),
      },
      { onConflict: "channel" }
    );

    results[channel] = { ...health, alerted: alerting };
  }

  if (alerts.length > 0 || tplAlerts.length > 0) {
    try {
      await sendHealthAlertEmail(alerts, templateIssues, tplAlerts);
    } catch (err) {
      console.error("[messaging-health] alert email failed:", err);
    }
  }

  await pingCronHealth("cron/messaging-health", "ok", {
    whatsapp: results.whatsapp?.status,
    sms: results.sms?.status,
    template_issues: templateIssues.length,
    template_alerts: tplAlerts.length,
  });

  return NextResponse.json({
    window_hours: HEALTH_WINDOW_HOURS,
    channels: results,
    template_issues: templateIssues,
    templates_checked: templatesChecked,
    template_window_days: TEMPLATE_WINDOW_DAYS,
    templates: templateHealth,
    template_alerts: tplAlerts.map((t) => ({ template: t.template, previous: t.previous, status: t.health.status })),
    alerts_sent: alerts.length + tplAlerts.length,
  });
}

// ---------------------------------------------------------------------------
// Alert email
// ---------------------------------------------------------------------------

const STATUS_COLOR: Record<ChannelStatus, string> = {
  down:     "#dc2626",
  degraded: "#d97706",
  ok:       "#16a34a",
  idle:     "#6b7280",
};

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!
  );
}

async function sendHealthAlertEmail(
  alerts: Array<{ channel: Channel; previous: ChannelStatus | null; health: ChannelHealth }>,
  templateIssues: TemplateIssue[],
  tplAlerts: TemplateAlert[] = []
) {
  const anyDown =
    alerts.some((a) => a.health.status === "down") || tplAlerts.some((t) => t.health.status === "down");
  const anyDegraded =
    alerts.some((a) => a.health.status === "degraded") || tplAlerts.some((t) => t.health.status === "degraded");
  const worst = anyDown ? "down" : anyDegraded ? "degraded" : "ok";

  const recovered = alerts.filter((a) => a.health.status === "ok");
  const broken = alerts.filter((a) => a.health.status !== "ok");
  const tplBroken = tplAlerts.filter((t) => t.health.status !== "ok");
  const tplRecovered = tplAlerts.filter((t) => t.health.status === "ok");

  // Name the specific template in the subject — "Messaging Alert — WHATSAPP
  // degraded" is not actionable when the channel is fine and one document
  // template is dead.
  const brokenParts = [
    ...broken.map((a) => `${a.channel.toUpperCase()} ${a.health.status}`),
    ...tplBroken.map((t) => `${t.template} ${t.health.status}`),
  ];
  const recoveredParts = [
    ...recovered.map((a) => a.channel.toUpperCase()),
    ...tplRecovered.map((t) => t.template),
  ];
  const subject =
    brokenParts.length > 0
      ? `Messaging Alert — ${brokenParts.join(", ")}`
      : `Messaging Recovered — ${recoveredParts.join(", ")}`;

  const block = (a: { channel: Channel; previous: ChannelStatus | null; health: ChannelHealth }) => {
    const h = a.health;
    const pct = (h.failRate * 100).toFixed(0);
    return `
      <div style="border:1px solid #e5e7eb;border-radius:6px;padding:16px;margin:0 0 14px;">
        <p style="margin:0 0 6px;font-size:15px;font-weight:700;color:#111;">
          ${a.channel.toUpperCase()}
          <span style="color:${STATUS_COLOR[h.status]};">— ${h.status.toUpperCase()}</span>
          ${a.previous ? `<span style="color:#888;font-weight:400;font-size:12px;"> (was ${a.previous})</span>` : ""}
        </p>
        <p style="margin:0 0 8px;font-size:13px;color:#444;">
          ${h.failedCount} of ${h.sampleSize} outbound messages failed (${pct}%) in the last ${HEALTH_WINDOW_HOURS}h.
        </p>
        ${h.diagnosis ? `<p style="margin:0 0 8px;font-size:13px;color:#111;"><strong>Likely cause:</strong> ${escapeHtml(h.diagnosis)}</p>` : ""}
        ${h.dominantError ? `<p style="margin:0;font-size:11px;color:#666;font-family:monospace;word-break:break-all;">${escapeHtml(h.dominantError)}</p>` : ""}
      </div>`;
  };

  const issueRows = templateIssues
    .map(
      (t) => `<tr>
        <td style="padding:6px 12px;border-bottom:1px solid #e5e7eb;font-family:monospace;font-size:12px;">${escapeHtml(t.name)}</td>
        <td style="padding:6px 12px;border-bottom:1px solid #e5e7eb;font-size:12px;">${escapeHtml(t.status)}</td>
        <td style="padding:6px 12px;border-bottom:1px solid #e5e7eb;font-size:12px;">${escapeHtml(t.reason ?? "—")}</td>
      </tr>`
    )
    .join("");

  await resend.emails.send({
    from: EMAIL_FROM,
    replyTo: EMAIL_REPLY_TO,
    to: ALERT_RECIPIENTS,
    subject,
    html: `
      <div style="font-family:sans-serif;max-width:640px;margin:0 auto;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
        <div style="background:${STATUS_COLOR[worst as ChannelStatus]};padding:20px 32px;">
          <h1 style="color:white;margin:0;font-size:20px;">Messaging Health</h1>
        </div>
        <div style="padding:28px 32px;">
          ${alerts.map(block).join("")}
          ${
            tplAlerts.length > 0
              ? `<p style="color:#333;font-size:14px;margin:4px 0 8px;"><strong>Templates that changed state</strong> (last ${TEMPLATE_WINDOW_DAYS} days):</p>
                 <table style="width:100%;border-collapse:collapse;font-size:13px;margin:0 0 18px;">
                   <tr style="background:#f3f4f6;">
                     <th style="padding:6px 12px;text-align:left;border-bottom:2px solid #d1d5db;font-size:11px;">Template</th>
                     <th style="padding:6px 12px;text-align:left;border-bottom:2px solid #d1d5db;font-size:11px;">State</th>
                     <th style="padding:6px 12px;text-align:left;border-bottom:2px solid #d1d5db;font-size:11px;">Failed</th>
                   </tr>
                   ${tplAlerts
                     .map(
                       (t) => `<tr>
                         <td style="padding:6px 12px;border-bottom:1px solid #e5e7eb;font-family:monospace;font-size:12px;">${escapeHtml(t.template)}</td>
                         <td style="padding:6px 12px;border-bottom:1px solid #e5e7eb;color:${STATUS_COLOR[t.health.status]};font-weight:600;">${t.health.status.toUpperCase()}${t.previous ? `<span style="color:#888;font-weight:400;"> (was ${t.previous})</span>` : ""}</td>
                         <td style="padding:6px 12px;border-bottom:1px solid #e5e7eb;">${t.health.failedCount} of ${t.health.sampleSize}</td>
                       </tr>`
                     )
                     .join("")}
                 </table>
                 <p style="color:#666;font-size:12px;margin:0 0 18px;">
                   A template can fail completely while the channel looks healthy — check the document URL it sends (a private-bucket link returns 400 to Meta and surfaces as error 131053).
                 </p>`
              : ""
          }
          ${
            templateIssues.length > 0
              ? `<p style="color:#333;font-size:14px;margin:20px 0 8px;"><strong>Templates not deliverable in MSG91:</strong></p>
                 <table style="width:100%;border-collapse:collapse;font-size:13px;">
                   <tr style="background:#fef2f2;">
                     <th style="padding:6px 12px;text-align:left;border-bottom:2px solid #fecaca;color:#991b1b;font-size:11px;">Template</th>
                     <th style="padding:6px 12px;text-align:left;border-bottom:2px solid #fecaca;color:#991b1b;font-size:11px;">Status</th>
                     <th style="padding:6px 12px;text-align:left;border-bottom:2px solid #fecaca;color:#991b1b;font-size:11px;">Reason</th>
                   </tr>
                   ${issueRows}
                 </table>`
              : ""
          }
          <p style="color:#666;font-size:12px;margin:20px 0 0;">
            MSG91 dashboard: control.msg91.com — check the WhatsApp plan and the number's subscription first.
          </p>
        </div>
        <div style="background:#015E65;padding:12px 32px;text-align:center;">
          <p style="color:#fff;margin:0;font-size:10px;">SREE DESIGN INFRASTRUCTURE PVT LTD | The WorkVilla</p>
        </div>
      </div>
    `,
  });
}
