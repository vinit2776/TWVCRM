import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { resend, EMAIL_FROM } from "@/lib/mailer";
import webPush from "web-push";
import { withCronHealth } from "@/lib/cron-ping";

export const maxDuration = 60;

// ─── VAPID setup (reuse from lib/push but inline to avoid side effects) ───────
const VAPID_PUBLIC  = (process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY || "").trim();
const VAPID_PRIVATE = (process.env.VAPID_PRIVATE_KEY || "").trim();
const VAPID_SUBJECT = (process.env.VAPID_SUBJECT || "mailto:space@theworkvilla.com").trim();

function setupVapid() {
  if (!VAPID_PUBLIC || !VAPID_PRIVATE) return false;
  try {
    webPush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);
    return true;
  } catch {
    return false;
  }
}

// ─── Authorisation ────────────────────────────────────────────────────────────
// Vercel crons call with Authorization: Bearer <CRON_SECRET>
function isAuthorised(request: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true; // dev fallback
  const authHeader = request.headers.get("authorization");
  return authHeader === `Bearer ${secret}`;
}

// ─── Main handler ─────────────────────────────────────────────────────────────
async function handler(request: NextRequest) {
  if (!isAuthorised(request)) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  const supabase = await createAdminClient();
  const vapidOk  = setupVapid();

  // ── Find locations that require headcount, including their in-charges ──
  const { data: locations, error: locErr } = await supabase
    .from("locations")
    .select("id, name, incharge_user_id_1, incharge_user_id_2")
    .eq("requires_headcount", true)
    .eq("is_active", true);

  if (locErr || !locations?.length) {
    return NextResponse.json({ message: "No locations require headcount" });
  }

  // ── Check which locations are MISSING a reading in the last 4 hours ──
  const now         = new Date();
  const windowStart = new Date(now.getTime() - 4 * 60 * 60 * 1000).toISOString();

  const { data: recentReadings } = await supabase
    .from("space_headcounts")
    .select("location_id")
    .gte("recorded_at", windowStart);

  const doneLocationIds = new Set((recentReadings ?? []).map(r => r.location_id));

  const missing = locations.filter(l => !doneLocationIds.has(l.id));

  if (missing.length === 0) {
    console.log("[headcount-reminder] All locations have recent readings — nothing to do");
    return NextResponse.json({ message: "All readings up to date", checked: locations.length });
  }

  const missingNames = missing.map(l => l.name).join(", ");
  console.log(`[headcount-reminder] Missing readings at: ${missingNames}`);

  // ── Resolve in-charge user IDs for the MISSING locations ──
  // We push only to the people accountable for those specific centres
  // instead of broadcasting to every floor_manager in the company. This
  // is the change the user asked for: location-scoped nudges instead of
  // role-wide blasts.
  const inchargeUserIds = Array.from(new Set(
    missing.flatMap(l => [l.incharge_user_id_1, l.incharge_user_id_2].filter(Boolean) as string[])
  ));

  // Manager role gets the supervisory escalation email (admin dropped).
  const { data: managers } = await supabase
    .from("users")
    .select("email, full_name")
    .eq("role", "manager")
    .eq("is_active", true)
    .not("email", "is", null);

  const results = { pushSent: 0, emailSent: 0, missing: missing.length };

  // ── Send push to designated in-charges of the missing locations ──
  const slotLabel = getSlotLabel(now);

  if (vapidOk && inchargeUserIds.length > 0) {
    const { data: subs } = await supabase
      .from("push_subscriptions")
      .select("endpoint, p256dh, auth")
      .in("user_id", inchargeUserIds);

    if (subs?.length) {
      const payload = JSON.stringify({
        title: `⏰ Headcount due — ${slotLabel}`,
        body: `Please log the headcount for: ${missingNames}`,
        url: "/headcount",
        tag: "headcount-reminder",
      });

      const pushResults = await Promise.allSettled(
        subs.map(sub =>
          webPush.sendNotification(
            { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
            payload
          )
        )
      );
      results.pushSent = pushResults.filter(r => r.status === "fulfilled").length;
    }
  } else if (inchargeUserIds.length === 0) {
    console.warn(`[headcount-reminder] None of the missing locations have an in-charge configured — push skipped, only the manager escalation email will go out`);
  }

  // ── Escalation email to managers ──
  if (managers?.length) {
    const locationList = missing.map(l => `<li><strong>${l.name}</strong></li>`).join("");

    const html = `
      <div style="font-family:sans-serif;max-width:540px;margin:0 auto">
        <div style="background:#015E65;padding:20px 24px;border-radius:8px 8px 0 0">
          <p style="color:white;font-size:18px;font-weight:700;margin:0">Headcount Not Logged</p>
          <p style="color:#00AE6C;font-size:13px;margin:4px 0 0">${slotLabel} · ${now.toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", weekday: "long", day: "numeric", month: "long", year: "numeric" })}</p>
        </div>
        <div style="background:#fff;border:1px solid #e5e7eb;border-top:none;padding:24px;border-radius:0 0 8px 8px">
          <p style="color:#374151;font-size:14px">The following location(s) have <strong>not logged their headcount</strong> for the <strong>${slotLabel}</strong> slot:</p>
          <ul style="margin:12px 0;padding-left:20px;color:#111827;font-size:14px">
            ${locationList}
          </ul>
          <p style="color:#6b7280;font-size:13px">Please follow up with the floor incharge to ensure the reading is recorded.</p>
          <div style="margin-top:20px">
            <a href="${process.env.NEXT_PUBLIC_APP_URL || "https://twv-crm.vercel.app"}/headcount"
               style="background:#015E65;color:white;padding:10px 20px;border-radius:8px;text-decoration:none;font-size:14px;font-weight:600">
              Open Headcount
            </a>
          </div>
        </div>
        <p style="color:#9ca3af;font-size:11px;text-align:center;margin-top:12px">
          The WorkVilla CRM · Automated Escalation
        </p>
      </div>
    `;

    for (const mgr of managers) {
      try {
        const { error } = await resend.emails.send({
          from: EMAIL_FROM,
          to: mgr.email,
          subject: `[Action Required] Headcount not logged — ${slotLabel}`,
          html,
        });
        if (error) {
          console.error(`[headcount-reminder] Failed to email ${mgr.email}:`, error.message);
        } else {
          results.emailSent++;
        }
      } catch (err) {
        console.error(`[headcount-reminder] Failed to email ${mgr.email}:`, err);
      }
    }
  }

  return NextResponse.json({
    message: `Reminder sent for ${missing.length} location(s)`,
    ...results,
    missingLocations: missing.map(l => l.name),
  });
}

// ─── Utility ──────────────────────────────────────────────────────────────────

function getSlotLabel(utcDate: Date): string {
  // Convert UTC to IST (UTC+5:30)
  const istHour = (utcDate.getUTCHours() + 5 + Math.floor((utcDate.getUTCMinutes() + 30) / 60)) % 24;
  if (istHour < 12)  return "10:00 AM";
  if (istHour < 15)  return "2:00 PM";
  return "6:00 PM";
}

export const GET = withCronHealth("cron/headcount-reminder", handler);
