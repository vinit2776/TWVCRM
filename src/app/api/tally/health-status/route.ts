/**
 * GET /api/tally/health-status
 *
 * Dashboard endpoint — returns the current bridge health for the
 * TallyBridgeHealthCard component. User-session auth (not agent token).
 *
 * Derives "online" from last_seen_at: bridge is considered offline if
 * the last heartbeat is >90s ago (bridge pings every ~60s).
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";

const OFFLINE_THRESHOLD_SECONDS = 90;

export async function GET(_request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const adminClient = createAdminClient();

  // Fetch sync enabled setting
  const { data: setting } = await adminClient
    .from("app_settings")
    .select("value")
    .eq("key", "tally_sync_enabled")
    .single();

  const syncEnabled = setting?.value === "true";

  // Fetch bridge health (most recent heartbeat)
  const { data: bridge } = await adminClient
    .from("tally_bridge_health")
    .select("*")
    .order("last_seen_at", { ascending: false })
    .limit(1)
    .single();

  // Pending / failed counts
  const { count: pendingCount } = await adminClient
    .from("tally_sync_jobs")
    .select("*", { count: "exact", head: true })
    .eq("status", "pending");

  const { count: failedCount } = await adminClient
    .from("tally_sync_jobs")
    .select("*", { count: "exact", head: true })
    .eq("status", "failed");

  // Determine online: last heartbeat within threshold
  let online = false;
  if (bridge?.last_seen_at) {
    const lastSeen = new Date(bridge.last_seen_at).getTime();
    const ageSeconds = (Date.now() - lastSeen) / 1000;
    online = ageSeconds < OFFLINE_THRESHOLD_SECONDS;
  }

  return NextResponse.json({
    sync_enabled:         syncEnabled,
    online,
    tally_connected:      bridge?.tally_connected ?? false,
    tally_company_name:   bridge?.tally_company_name ?? null,
    tally_company_gstin:  bridge?.tally_company_gstin ?? null,
    gstin_mismatch:       bridge?.tally_company_gstin
                            ? bridge.tally_company_gstin !== (setting?.value ?? "")
                            : false,
    pending_count:        pendingCount ?? 0,
    failed_count:         failedCount ?? 0,
    last_seen_at:         bridge?.last_seen_at ?? null,
    last_sync_at:         bridge?.last_sync_at ?? null,
    version:              bridge?.version ?? null,
  });
}
