import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { setupGmailWatch } from "@/lib/gmail";
import { pingCronHealth } from "@/lib/cron-ping";

/**
 * GET /api/cron/gmail-watch-renew
 *
 * A Gmail watch expires 7 days after it is created — Google stops posting to
 * Pub/Sub and nothing announces it. There was previously no renewal at all, so
 * the inbound pipeline would have died within a week of being switched on and
 * gone quiet rather than failing loudly.
 *
 * Runs daily (see vercel.json). Renewing is idempotent: calling users.watch()
 * again just extends the existing watch, so a daily run gives six days of slack
 * before mail is missed.
 *
 * No-ops when the pipeline is not configured, so this stays harmless until the
 * GMAIL_* variables are set.
 */
export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!process.env.GMAIL_REFRESH_TOKEN || !process.env.GMAIL_PUBSUB_TOPIC) {
    return NextResponse.json({ skipped: "gmail not configured" });
  }

  const admin = await createAdminClient();

  try {
    const { historyId, expiration } = await setupGmailWatch();

    // expiration is epoch milliseconds as a string.
    const expiresAt = expiration
      ? new Date(Number(expiration)).toISOString()
      : null;

    await upsertSetting(admin, "gmail_watch_expiry", expiresAt ?? "");

    // Only seed the checkpoint — never overwrite a live one, or the messages
    // between the stored id and this renewal would be skipped.
    const { data: existing } = await admin
      .from("app_settings")
      .select("id")
      .eq("key", "gmail_history_id")
      .maybeSingle();

    if (!existing && historyId) {
      await upsertSetting(admin, "gmail_history_id", historyId);
    }

    await pingCronHealth("gmail-watch-renew", "ok", { expiresAt });

    return NextResponse.json({ renewed: true, expiresAt });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    console.error("Gmail watch renewal failed:", message);

    // Surfaces in the cron-health dashboard rather than failing silently — a
    // dead watch is invisible from the app otherwise.
    await pingCronHealth("gmail-watch-renew", "error", { message });

    return NextResponse.json({ error: "Renewal failed" }, { status: 500 });
  }
}

async function upsertSetting(
  admin: Awaited<ReturnType<typeof createAdminClient>>,
  key: string,
  value: string
) {
  const { data: existing } = await admin
    .from("app_settings")
    .select("id")
    .eq("key", key)
    .maybeSingle();

  if (existing) {
    await admin.from("app_settings").update({ value }).eq("key", key);
  } else {
    await admin.from("app_settings").insert({ key, value });
  }
}
