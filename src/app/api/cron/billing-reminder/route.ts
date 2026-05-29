import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { resend, EMAIL_FROM, EMAIL_REPLY_TO } from "@/lib/mailer";
import { pingCronHealth } from "@/lib/cron-ping";

export const maxDuration = 30;

/**
 * GET /api/cron/billing-reminder
 *
 * REMINDER ONLY — never bills, never dispatches. Automatic month-end billing is
 * paused; proformas are generated manually from the Billing page. This cron is a
 * safety net so the manual run isn't forgotten.
 *
 * Fires on days 28–31 at ~10:00 IST (vercel.json: "30 4 28-31 * *"). On the actual
 * last day of the month (IST), if next month's rent proformas have NOT been
 * generated yet, it emails admin/accounts a nudge with a link to the Billing page.
 * State-gated: once billing has run for next month, no reminder is sent.
 *
 * Query: ?force=1 — skip the last-day + already-run guards (for testing).
 */
export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const force = new URL(request.url).searchParams.get("force") === "1";

  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
  const nowIST = new Date(Date.now() + IST_OFFSET_MS);
  const todayDate = nowIST.getUTCDate();
  const curMonth = nowIST.getUTCMonth() + 1; // 1-12
  const curYear = nowIST.getUTCFullYear();
  const daysInMonth = new Date(curYear, curMonth, 0).getDate();

  // Only nudge on the actual last day of the month (unless forced)
  if (!force && todayDate !== daysInMonth) {
    return NextResponse.json({ skipped: true, reason: `Not last day (day ${todayDate}/${daysInMonth})` });
  }

  // The month rent proformas would cover = NEXT month
  const prepaidMonth = curMonth === 12 ? 1 : curMonth + 1;
  const prepaidYear = curMonth === 12 ? curYear + 1 : curYear;
  const prepaidLabel = new Date(prepaidYear, prepaidMonth - 1)
    .toLocaleDateString("en-IN", { month: "long", year: "numeric" });

  const admin = createAdminClient();

  // Has billing already run for next month? Count rent proformas covering it.
  const { count } = await admin
    .from("billing_statements")
    .select("id", { count: "exact", head: true })
    .eq("statement_type", "rent")
    .eq("prepaid_month", prepaidMonth)
    .eq("prepaid_year", prepaidYear)
    .is("voided_at", null);

  if (!force && (count ?? 0) > 0) {
    await pingCronHealth("billing-reminder", "ok", { already_run: true, prepaid: prepaidLabel });
    return NextResponse.json({ reminded: false, reason: `Already run for ${prepaidLabel} (${count} proformas)` });
  }

  const { data: recipients } = await admin
    .from("users")
    .select("email")
    .in("role", ["admin", "accounts", "manager"])
    .eq("is_active", true);

  const emails = (recipients || []).map((r: { email: string }) => r.email).filter(Boolean) as string[];
  if (emails.length === 0) {
    await pingCronHealth("billing-reminder", "ok", { no_recipients: true });
    return NextResponse.json({ reminded: false, reason: "No recipients" });
  }

  const appUrl = (process.env.NEXT_PUBLIC_APP_URL || "https://twv-crm.vercel.app").trim();
  const html = `
    <div style="font-family:sans-serif;max-width:600px;margin:0 auto;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
      <div style="background:#015E65;padding:20px 32px;">
        <h1 style="color:white;margin:0;font-size:20px;">The WorkVilla</h1>
        <p style="color:#00AE6C;margin:4px 0 0;font-size:12px;">Billing Reminder</p>
      </div>
      <div style="padding:32px;">
        <div style="background:#fff3cd;border:1px solid #ffc107;border-radius:6px;padding:14px 18px;font-size:14px;color:#856404;">
          ⏰ <strong>Monthly proforma billing for ${prepaidLabel} has not been run yet.</strong>
          Today is the last day of the month — please generate and send the rent proformas before month-end.
        </div>
        <p style="color:#333;font-size:14px;margin-top:16px;">Automatic billing is paused, so this step is manual. Open the Billing page, click <strong>Preview</strong> to check the amounts, then <strong>Run &amp; Send</strong>.</p>
        <div style="text-align:center;margin:24px 0;">
          <a href="${appUrl}/billing?tab=statements" style="background:#015E65;color:white;padding:10px 24px;text-decoration:none;border-radius:6px;font-weight:bold;display:inline-block;font-size:14px;">Open Billing</a>
        </div>
      </div>
      <div style="background:#015E65;padding:12px 32px;text-align:center;">
        <p style="color:#fff;margin:0;font-size:10px;">SREE DESIGN INFRASTRUCTURE PVT LTD | The WorkVilla</p>
      </div>
    </div>`;

  for (const email of emails) {
    resend.emails.send({
      from: EMAIL_FROM,
      replyTo: EMAIL_REPLY_TO,
      to: [email],
      subject: `⏰ Proforma billing for ${prepaidLabel} is due — run it before month-end`,
      html,
    }).catch(console.error);
  }

  await pingCronHealth("billing-reminder", "ok", { reminded: emails.length, prepaid: prepaidLabel });
  return NextResponse.json({ reminded: emails.length, prepaid: prepaidLabel });
}
