import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { setupGmailWatch, stopGmailWatch, getLatestHistoryId } from "@/lib/gmail";

/**
 * GET: Check current Gmail Watch status
 * POST: Setup or renew Gmail Watch
 */

export async function GET(_request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Check user is admin
  const { data: dbUser } = await supabase
    .from("users")
    .select("role")
    .eq("auth_id", user.id)
    .single();

  if (dbUser?.role !== "admin") {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  }

  // Get stored watch info
  const [historyRes, expiryRes] = await Promise.all([
    supabase
      .from("app_settings")
      .select("value, updated_at")
      .eq("key", "gmail_history_id")
      .single(),
    supabase
      .from("app_settings")
      .select("value, updated_at")
      .eq("key", "gmail_watch_expiry")
      .single(),
  ]);

  return NextResponse.json({
    data: {
      historyId: historyRes.data?.value || null,
      watchExpiry: expiryRes.data?.value || null,
      lastUpdated: historyRes.data?.updated_at || null,
      watchEmail: process.env.GMAIL_WATCH_EMAIL || "cases@theworkvilla.com",
      isConfigured: !!(process.env.GMAIL_CLIENT_ID && process.env.GMAIL_REFRESH_TOKEN),
    },
  });
}

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Check user is admin
  const { data: dbUser } = await supabase
    .from("users")
    .select("id, role")
    .eq("auth_id", user.id)
    .single();

  if (dbUser?.role !== "admin") {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  }

  const body = await request.json().catch(() => ({}));
  const action = body.action || "setup";

  try {
    if (action === "stop") {
      await stopGmailWatch();
      return NextResponse.json({ message: "Gmail Watch stopped" });
    }

    // Setup or renew watch
    const watchResult = await setupGmailWatch();

    // Store the historyId and expiry
    await upsertSetting(supabase, "gmail_history_id", watchResult.historyId);
    await upsertSetting(supabase, "gmail_watch_expiry", watchResult.expiration);

    return NextResponse.json({
      message: "Gmail Watch setup successfully",
      data: {
        historyId: watchResult.historyId,
        expiration: watchResult.expiration,
        watchEmail: process.env.GMAIL_WATCH_EMAIL,
      },
    });
  } catch (error) {
    console.error("Gmail Watch setup failed:", error);
    return NextResponse.json(
      {
        error: "Failed to setup Gmail Watch",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
}

async function upsertSetting(
  supabase: Awaited<ReturnType<typeof createClient>>,
  key: string,
  value: string
) {
  const { data: existing } = await supabase
    .from("app_settings")
    .select("id")
    .eq("key", key)
    .single();

  if (existing) {
    await supabase
      .from("app_settings")
      .update({ value })
      .eq("key", key);
  } else {
    await supabase.from("app_settings").insert({ key, value });
  }
}
