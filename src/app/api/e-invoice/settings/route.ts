import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";

/**
 * GET /api/e-invoice/settings
 * Returns the public e-invoice configuration (admin only).
 * Excludes encrypted credentials.
 */
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
    return NextResponse.json({ error: "Admin only" }, { status: 403 });
  }

  const { data, error } = await supabase
    .from("app_settings")
    .select("key, value")
    .like("key", "einvoice_%")
    .eq("is_encrypted", false);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const map = new Map<string, string>((data ?? []).map((r) => [r.key, r.value ?? ""]));
  const get = (k: string) => map.get(k) ?? "";

  return NextResponse.json({
    enabled: get("einvoice_enabled") === "true",
    environment: get("einvoice_environment") || "sandbox",
    irp_provider: get("einvoice_irp_provider") || "einvoice6",
    seller_gstin: get("einvoice_seller_gstin"),
    seller_legal_name: get("einvoice_seller_legal_name"),
    seller_trade_name: get("einvoice_seller_trade_name"),
    seller_address1: get("einvoice_seller_address1"),
    seller_address2: get("einvoice_seller_address2"),
    seller_location: get("einvoice_seller_location"),
    seller_pincode: get("einvoice_seller_pincode"),
    seller_state_code: get("einvoice_seller_state_code") || "33",
    default_sac_code: get("einvoice_default_sac_code") || "997212",
    default_gst_rate: parseFloat(get("einvoice_default_gst_rate") || "18"),
    go_live_date: get("einvoice_go_live_date") || "2026-05-15",
    daily_batch_enabled: get("einvoice_daily_batch_enabled") === "true",
    daily_batch_hour_ist: parseInt(get("einvoice_daily_batch_hour_ist") || "23", 10),
    last_successful_auth_at: get("einvoice_last_successful_auth_at") || null,
    cached_token_expires_at: get("einvoice_cached_token_expires_at") || null,
  });
}

/**
 * POST /api/e-invoice/settings
 * Bulk-update public e-invoice configuration. Admin only.
 *
 * NEVER accepts credentials via this endpoint — those have a separate
 * setter that writes encrypted-at-rest.
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users")
    .select("id, role")
    .eq("auth_id", user.id)
    .single();
  if (!dbUser || dbUser.role !== "admin") {
    return NextResponse.json({ error: "Admin only" }, { status: 403 });
  }

  const body = await request.json();

  // Whitelist of editable keys — guards against credential leakage via this endpoint
  const ALLOWED: Record<string, string> = {
    enabled: "einvoice_enabled",
    environment: "einvoice_environment",
    irp_provider: "einvoice_irp_provider",
    seller_gstin: "einvoice_seller_gstin",
    seller_legal_name: "einvoice_seller_legal_name",
    seller_trade_name: "einvoice_seller_trade_name",
    seller_address1: "einvoice_seller_address1",
    seller_address2: "einvoice_seller_address2",
    seller_location: "einvoice_seller_location",
    seller_pincode: "einvoice_seller_pincode",
    seller_state_code: "einvoice_seller_state_code",
    default_sac_code: "einvoice_default_sac_code",
    default_gst_rate: "einvoice_default_gst_rate",
    go_live_date: "einvoice_go_live_date",
    daily_batch_enabled: "einvoice_daily_batch_enabled",
    daily_batch_hour_ist: "einvoice_daily_batch_hour_ist",
  };

  const updates: { key: string; value: string }[] = [];
  for (const [field, dbKey] of Object.entries(ALLOWED)) {
    if (!(field in body)) continue;
    const v = body[field];
    let value: string;
    if (typeof v === "boolean") value = v ? "true" : "false";
    else if (typeof v === "number") value = String(v);
    else value = String(v ?? "");
    updates.push({ key: dbKey, value });
  }

  // Auto-derive state code from GSTIN
  if (body.seller_gstin && typeof body.seller_gstin === "string" && body.seller_gstin.length >= 2) {
    updates.push({ key: "einvoice_seller_state_code", value: body.seller_gstin.slice(0, 2) });
  }

  for (const u of updates) {
    const { error } = await supabase
      .from("app_settings")
      .update({ value: u.value })
      .eq("key", u.key);
    if (error) {
      return NextResponse.json({ error: `Failed to save ${u.key}: ${error.message}` }, { status: 500 });
    }
  }

  await logAudit(supabase, {
    entityType: "app_setting",
    entityId: "einvoice",
    action: "update",
    performedBy: dbUser.id,
    changes: { e_invoice_settings: { old: null, new: updates.length + " keys updated" } },
  });

  return NextResponse.json({ ok: true, updated: updates.length });
}
