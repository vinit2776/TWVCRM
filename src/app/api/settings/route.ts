import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";

// GET — fetch all settings (admin only, secrets masked)
export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users")
    .select("id, role")
    .eq("auth_id", user.id)
    .single();

  if (!dbUser || dbUser.role !== "admin") {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  }

  const adminSupabase = await createAdminClient();
  const { data: settings, error } = await adminSupabase
    .from("app_settings")
    .select("*")
    .order("key");

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Mask secret values — show only last 4 chars
  const SECRET_KEYS = ["razorpay_key_secret", "razorpay_webhook_secret"];
  const masked = (settings || []).map((s) => {
    if (SECRET_KEYS.includes(s.key) && s.value && s.value.length > 4) {
      return { ...s, value: "••••" + s.value.slice(-4) };
    }
    return s;
  });

  return NextResponse.json({ data: masked });
}

// PATCH — update settings (admin only)
export async function PATCH(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users")
    .select("id, role")
    .eq("auth_id", user.id)
    .single();

  if (!dbUser || dbUser.role !== "admin") {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  }

  const body = await request.json();
  const VALID_KEYS = [
    "razorpay_key_id",
    "razorpay_key_secret",
    "razorpay_webhook_secret",
    "razorpay_enabled",
    "upi_id",
    "upi_qr_code_path",
    "crm_gst_enabled",
    "tally_sync_enabled",
    "facility_classifier_ui_enabled",
    "facility_category_autofill_enabled",
  ];

  const updates: { key: string; value: string }[] = [];
  for (const [key, value] of Object.entries(body)) {
    if (VALID_KEYS.includes(key) && typeof value === "string") {
      // Skip masked values (don't overwrite secret with dots)
      if (value.startsWith("••••")) continue;
      updates.push({ key, value });
    }
  }

  if (updates.length === 0) {
    return NextResponse.json({ error: "No valid settings to update" }, { status: 400 });
  }

  const SECRET_KEYS_WRITE = ["razorpay_key_secret", "razorpay_webhook_secret"];

  const adminSupabase = await createAdminClient();

  // Fetch current values before overwriting so the audit trail can record
  // which keys changed (secrets are stored as "[REDACTED]" — never logged).
  const { data: existingRows } = await adminSupabase
    .from("app_settings")
    .select("key, value")
    .in("key", updates.map((u) => u.key));
  const existingMap = Object.fromEntries((existingRows || []).map((r) => [r.key, r.value]));

  for (const { key, value } of updates) {
    // Use upsert to handle both existing and missing rows
    const { error } = await adminSupabase
      .from("app_settings")
      .upsert({ key, value, updated_by: dbUser.id }, { onConflict: "key" });

    if (error) {
      return NextResponse.json({ error: `Failed to update ${key}: ${error.message}` }, { status: 500 });
    }
  }

  // Audit each key individually so the trail is searchable per setting.
  // Secret values are never stored in the audit log — only whether they changed.
  for (const { key, value } of updates) {
    const isSecret = SECRET_KEYS_WRITE.includes(key);
    const oldVal = existingMap[key];
    const changed = oldVal !== value;

    logAudit(adminSupabase, {
      entityType: "app_setting",
      entityId: key,
      action: "update",
      performedBy: dbUser.id,
      changes: {
        [key]: isSecret
          ? { old: "[REDACTED]", new: changed ? "[REDACTED — NEW VALUE]" : "[REDACTED — UNCHANGED]" }
          : { old: oldVal ?? null, new: value },
      },
    });
  }

  return NextResponse.json({ message: "Settings updated" });
}
