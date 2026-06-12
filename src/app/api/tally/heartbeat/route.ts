/**
 * POST /api/tally/heartbeat
 *
 * Bridge-only endpoint. The bridge calls this every ~60 seconds.
 * Drives the CRM health card (§7.2) — shows Tally + CRM connectivity
 * status, pending/failed counts, and last-seen timestamp.
 *
 * If the heartbeat stops, the CRM card flips to "⚠️ Bridge offline"
 * (determined by the dashboard component checking last_seen_at age).
 *
 * Auth: Bearer TALLY_AGENT_TOKEN
 *
 * Body:
 * {
 *   bridge_instance_id:   string   ← unique ID set at bridge startup
 *   version:              string   ← bridge version e.g. "1.0.0"
 *   tally_connected:      boolean
 *   tally_company_name:   string   ← currently open company
 *   tally_company_gstin:  string   ← GSTIN of open company (for guard check)
 *   crm_connected:        boolean  ← always true if we're receiving this
 *   pending_count:        number
 *   failed_count:         number
 *   last_sync_at:         string | null   ← ISO timestamp of last successful job
 *   last_error:           string | null
 * }
 */

import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { z } from "zod";

const HeartbeatSchema = z.object({
  bridge_instance_id:   z.string().min(1),
  version:              z.string().nullable().optional(),
  tally_connected:      z.boolean(),
  tally_company_name:   z.string().nullable().optional(),
  tally_company_gstin:  z.string().nullable().optional(),
  crm_connected:        z.boolean().default(true),
  pending_count:        z.number().int().min(0).default(0),
  failed_count:         z.number().int().min(0).default(0),
  last_sync_at:         z.string().nullable().optional(),
  last_error:           z.string().nullable().optional(),
  // Remote diagnostics (bridge v1.3.13+): e.g. the Tally voucher-type list,
  // refreshed hourly. Stored in app_settings for inspection from the CRM.
  diag:                 z.object({ voucher_types: z.array(z.string()).max(500) }).optional(),
});

function authGuard(request: NextRequest): boolean {
  return request.headers.get("authorization") === `Bearer ${process.env.TALLY_AGENT_TOKEN}`;
}

export async function POST(request: NextRequest) {
  if (!authGuard(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = HeartbeatSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid payload", details: parsed.error.flatten() }, { status: 400 });
  }

  const data = parsed.data;
  const supabase = createAdminClient();

  // Upsert — one row per bridge instance (typically just one)
  const { error } = await supabase
    .from("tally_bridge_health")
    .upsert(
      {
        bridge_instance_id:  data.bridge_instance_id,
        version:             data.version ?? null,
        tally_connected:     data.tally_connected,
        tally_company_name:  data.tally_company_name ?? null,
        tally_company_gstin: data.tally_company_gstin ?? null,
        crm_connected:       true,   // always true — we received the ping
        pending_count:       data.pending_count,
        failed_count:        data.failed_count,
        last_seen_at:        new Date().toISOString(),
        last_sync_at:        data.last_sync_at ?? null,
        last_error:          data.last_error ?? null,
      },
      { onConflict: "bridge_instance_id" }
    );

  if (error) {
    console.error("[tally/heartbeat] upsert error:", error.message);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }

  // Persist diagnostics (best-effort) — readable via app_settings 'tally_bridge_diag'
  if (data.diag) {
    await supabase.from("app_settings").upsert(
      { key: "tally_bridge_diag", value: JSON.stringify({ ...data.diag, at: new Date().toISOString() }).slice(0, 20000) },
      { onConflict: "key" }
    );
  }

  // Validate GSTIN guard — warn the bridge if the wrong company is open.
  // Also fetch the published bridge-update target (self-update, bridge v1.3.12+).
  const { data: settings } = await supabase
    .from("app_settings")
    .select("key, value")
    .in("key", ["tally_company_gstin", "tally_bridge_target_version", "tally_bridge_update_sha256"]);

  const settingsMap = Object.fromEntries(
    (settings ?? []).map((s: { key: string; value: string }) => [s.key, s.value])
  );

  const expectedGstin = settingsMap["tally_company_gstin"] ?? "";
  const gstinMismatch =
    expectedGstin &&
    data.tally_company_gstin &&
    data.tally_company_gstin !== expectedGstin;

  // Self-update: tell the bridge a newer version is published. The bridge
  // compares against its own VERSION and downloads via GET /api/tally/update-package.
  const targetVersion = (settingsMap["tally_bridge_target_version"] ?? "").trim();
  const updateSha256  = (settingsMap["tally_bridge_update_sha256"] ?? "").trim();
  const update = targetVersion && updateSha256 && targetVersion !== (data.version ?? "")
    ? { target_version: targetVersion, sha256: updateSha256 }
    : null;

  return NextResponse.json({
    ok: true,
    gstin_mismatch: gstinMismatch ?? false,
    update,
    // Bridge should surface a tray warning + refuse to post if this is true
    ...(gstinMismatch && {
      warning: `Wrong company open. Expected GSTIN ${expectedGstin}, got ${data.tally_company_gstin}. Bridge will not post until the correct company is loaded.`,
    }),
  });
}
