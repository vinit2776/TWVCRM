import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
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

  const { data: settings, error } = await supabase
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

  for (const { key, value } of updates) {
    const { error } = await supabase
      .from("app_settings")
      .update({ value, updated_by: dbUser.id })
      .eq("key", key);

    if (error) {
      return NextResponse.json({ error: `Failed to update ${key}: ${error.message}` }, { status: 500 });
    }
  }

  logAudit(supabase, {
    entityType: "app_setting",
    entityId: "batch",
    action: "update",
    performedBy: dbUser.id,
    changes: Object.fromEntries(updates.map(u => [u.key, { old: "***", new: "***" }])),
  });

  return NextResponse.json({ message: "Settings updated" });
}
