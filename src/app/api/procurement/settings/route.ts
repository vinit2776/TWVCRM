import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { z } from "zod";
import { PROCUREMENT_APPROVAL_THRESHOLDS } from "@/lib/constants";

const SETTING_KEY = "procurement_approval_threshold";

const patchSchema = z.object({
  threshold: z
    .number()
    .int("Threshold must be a whole number")
    .min(0, "Threshold cannot be negative"),
});

/**
 * GET /api/procurement/settings
 * Returns current procurement approval settings.
 * Readable by all authenticated users (so PRs can show threshold info).
 */
export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data } = await supabase
    .from("app_settings")
    .select("key, value")
    .eq("key", SETTING_KEY)
    .maybeSingle();

  const threshold = data?.value
    ? parseInt(data.value, 10)
    : PROCUREMENT_APPROVAL_THRESHOLDS.ADMIN_REQUIRED_ABOVE;

  return NextResponse.json({
    data: {
      approval_threshold: isNaN(threshold)
        ? PROCUREMENT_APPROVAL_THRESHOLDS.ADMIN_REQUIRED_ABOVE
        : threshold,
    },
  });
}

/**
 * PATCH /api/procurement/settings
 * Updates procurement approval threshold. Admin only.
 */
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
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten().fieldErrors }, { status: 400 });
  }

  const newValue = String(parsed.data.threshold);

  // Fetch old value for audit
  const { data: existing } = await supabase
    .from("app_settings")
    .select("value")
    .eq("key", SETTING_KEY)
    .maybeSingle();

  const oldValue = existing?.value ?? String(PROCUREMENT_APPROVAL_THRESHOLDS.ADMIN_REQUIRED_ABOVE);

  // Upsert the setting
  const { error } = await supabase
    .from("app_settings")
    .upsert({ key: SETTING_KEY, value: newValue, updated_by: dbUser.id }, { onConflict: "key" });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await logAudit(supabase, {
    entityType: "app_setting",
    entityId: SETTING_KEY,
    action: "update",
    performedBy: dbUser.id,
    changes: {
      approval_threshold: { old: oldValue, new: newValue },
    },
  });

  return NextResponse.json({
    data: { approval_threshold: parsed.data.threshold },
    message: "Procurement settings updated",
  });
}
