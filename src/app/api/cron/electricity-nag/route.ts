import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { resend, EMAIL_FROM, EMAIL_REPLY_TO } from "@/lib/mailer";
import { pingCronHealth } from "@/lib/cron-ping";

/**
 * GET /api/cron/electricity-nag
 *
 * Monthly cron — runs on the 7th of each month (IST).
 * Finds locations with electricity billing enabled that are
 * missing an active (non-revised, non-voided) bill for the
 * previous month and sends a digest to digest_recipients.
 *
 * Skipped if no enabled locations or no recipients configured.
 */

function isAuthorised(request: NextRequest): boolean {
  const auth = request.headers.get("authorization");
  return auth === `Bearer ${process.env.CRON_SECRET}`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );
}

export async function GET(request: NextRequest) {
  if (!isAuthorised(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = createAdminClient();

  // ── Previous month in IST ────────────────────────────────────────────────
  const now = new Date();
  const istNow = new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
  const prevMonth = istNow.getMonth() === 0 ? 12 : istNow.getMonth();
  const prevYear = istNow.getMonth() === 0 ? istNow.getFullYear() - 1 : istNow.getFullYear();
  const monthLabel = new Date(prevYear, prevMonth - 1).toLocaleString("en-IN", {
    month: "long",
    year: "numeric",
  });

  // ── Locations with electricity enabled ───────────────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: configs } = await (supabase as any)
    .from("location_electricity_config")
    .select("location_id, locations(id, name, code)")
    .eq("enabled", true);

  if (!configs || configs.length === 0) {
    await pingCronHealth("cron/electricity-nag", "ok", { reason: "no enabled locations" });
    return NextResponse.json({ skipped: true, reason: "no enabled locations" });
  }

  // ── Bills that exist for previous month (non-revised, non-voided) ────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: bills } = await (supabase as any)
    .from("electricity_bills")
    .select("location_id, status")
    .eq("bill_month", prevMonth)
    .eq("bill_year", prevYear)
    .in("status", ["draft", "invoiced", "dispatched"]);

  const billedLocationIds = new Set<string>(
    (bills ?? []).map((b: { location_id: string }) => b.location_id),
  );

  const missing = (configs as Array<{ location_id: string; locations: { id: string; name: string; code: string } }>)
    .filter((c) => !billedLocationIds.has(c.location_id))
    .map((c) => c.locations);

  if (missing.length === 0) {
    await pingCronHealth("cron/electricity-nag", "ok", { reason: "all locations billed" });
    return NextResponse.json({ ok: true, missing: 0 });
  }

  // ── Recipients ───────────────────────────────────────────────────────────
  const { data: setting } = await supabase
    .from("app_settings")
    .select("value")
    .eq("key", "digest_recipients")
    .maybeSingle();

  let recipients: string[] = [];
  try {
    recipients = JSON.parse(setting?.value || "[]");
  } catch {
    recipients = [];
  }

  if (recipients.length === 0) {
    await pingCronHealth("cron/electricity-nag", "error", { reason: "no recipients" });
    return NextResponse.json({ error: "No digest_recipients configured" }, { status: 400 });
  }

  // ── Email ─────────────────────────────────────────────────────────────────
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? process.env.APP_URL ?? "";
  const rows = missing
    .map(
      (loc) =>
        `<tr>
          <td style="padding:8px 12px;border-bottom:1px solid #f0f0f0">${escapeHtml(loc.name)}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #f0f0f0;color:#888">${escapeHtml(loc.code)}</td>
        </tr>`,
    )
    .join("");

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:sans-serif;color:#222;max-width:600px;margin:auto;padding:24px">
  <h2 style="color:#015E65;margin-bottom:4px">⚡ Electricity Bill Missing</h2>
  <p style="color:#888;margin-top:0">${escapeHtml(monthLabel)}</p>
  <p>${missing.length} location${missing.length === 1 ? "" : "s"} with electricity billing enabled ${missing.length === 1 ? "has" : "have"} no active bill captured for <strong>${escapeHtml(monthLabel)}</strong>.</p>
  <table style="width:100%;border-collapse:collapse;margin:16px 0;border:1px solid #e8e8e8;border-radius:6px;overflow:hidden">
    <thead>
      <tr style="background:#f7f7f7">
        <th style="padding:8px 12px;text-align:left;font-size:12px;color:#666;text-transform:uppercase">Location</th>
        <th style="padding:8px 12px;text-align:left;font-size:12px;color:#666;text-transform:uppercase">Code</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>
  <p>
    <a href="${appUrl}/billing?tab=electricity" style="display:inline-block;background:#015E65;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;font-weight:600">
      Capture Electricity Bill
    </a>
  </p>
  <p style="color:#aaa;font-size:12px;margin-top:32px">This alert is sent on the 7th of each month for bills that are overdue from the previous month.</p>
</body>
</html>`;

  await resend.emails.send({
    from: EMAIL_FROM,
    replyTo: EMAIL_REPLY_TO,
    to: recipients,
    subject: `⚡ ${missing.length} electricity bill${missing.length === 1 ? "" : "s"} missing — ${monthLabel}`,
    html,
  });

  await pingCronHealth("cron/electricity-nag", "ok", { missing: missing.length });

  return NextResponse.json({ ok: true, missing: missing.length, locations: missing.map((l) => l.code) });
}
