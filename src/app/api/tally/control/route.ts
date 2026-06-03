/**
 * GET  /api/tally/control  — read full sync state (admin only)
 * PATCH /api/tally/control  — update sync state (admin only)
 *
 * Powers the Tally Sync Control admin page. Manages:
 *   - pause / resume (tally_sync_enabled)
 *   - company lock / update / unlock (tally_locked_company) — the wrong-company guard
 *   - ledger mapping
 *   - surfaces live bridge health + detected company
 *
 * The company guard is enforced server-side in /api/tally/pending using
 * tally_locked_company, so the Tally machine config is no longer authoritative.
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { z } from "zod";

const SETTING_KEYS = [
  "tally_sync_enabled",
  "tally_locked_company",
  "tally_sync_paused_reason",
  "tally_company_gstin",
  "tally_ledger_rent_income",
  "tally_ledger_usage_income",
  "tally_ledger_cgst_output",
  "tally_ledger_sgst_output",
  "tally_ledger_igst_output",
  "tally_ledger_round_off",
  "tally_party_ledger_suffix",
  "tally_voucher_series",
  "tally_irn_alarm_hours",
] as const;

const OFFLINE_THRESHOLD_SECONDS = 90;

async function requireAdmin(supabase: Awaited<ReturnType<typeof createClient>>) {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: "Unauthorized", status: 401 as const, dbUser: null };
  const { data: dbUser } = await supabase
    .from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser || dbUser.role !== "admin") {
    return { error: "Admin access required", status: 403 as const, dbUser: null };
  }
  return { error: null, status: 200 as const, dbUser };
}

export async function GET(_request: NextRequest) {
  const supabase = await createClient();
  const auth = await requireAdmin(supabase);
  if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const admin = createAdminClient();

  const { data: settingsRows } = await admin
    .from("app_settings").select("key, value").in("key", SETTING_KEYS as unknown as string[]);
  const s = Object.fromEntries((settingsRows ?? []).map((r: { key: string; value: string }) => [r.key, r.value]));

  // Latest bridge heartbeat
  const { data: bridge } = await admin
    .from("tally_bridge_health").select("*")
    .order("last_seen_at", { ascending: false }).limit(1).maybeSingle();

  // Queue counts
  const { count: pending } = await admin
    .from("tally_sync_jobs").select("*", { count: "exact", head: true }).eq("status", "pending");
  const { count: failed } = await admin
    .from("tally_sync_jobs").select("*", { count: "exact", head: true }).eq("status", "failed");

  let online = false;
  if (bridge?.last_seen_at) {
    online = (Date.now() - new Date(bridge.last_seen_at).getTime()) / 1000 < OFFLINE_THRESHOLD_SECONDS;
  }

  const lockedCompany   = s["tally_locked_company"] ?? "";
  const detectedCompany = bridge?.tally_company_name ?? "";
  const companyMatch = !lockedCompany || !detectedCompany || lockedCompany === detectedCompany;

  return NextResponse.json({
    sync_enabled:        s["tally_sync_enabled"] === "true",
    paused_reason:       s["tally_sync_paused_reason"] ?? "",
    locked_company:      lockedCompany,
    detected_company:    detectedCompany,
    company_match:       companyMatch,
    company_locked:      !!lockedCompany,
    gstin:               s["tally_company_gstin"] ?? "",
    irn_alarm_hours:     s["tally_irn_alarm_hours"] ?? "4",
    ledgers: {
      rent_income:  s["tally_ledger_rent_income"]  ?? "",
      usage_income: s["tally_ledger_usage_income"] ?? "",
      cgst:         s["tally_ledger_cgst_output"]  ?? "",
      sgst:         s["tally_ledger_sgst_output"]  ?? "",
      igst:         s["tally_ledger_igst_output"]  ?? "",
      round_off:    s["tally_ledger_round_off"]    ?? "",
      party_suffix: s["tally_party_ledger_suffix"] ?? "",
      voucher_series: s["tally_voucher_series"]    ?? "",
    },
    bridge: {
      online,
      version:        bridge?.version ?? null,
      tally_connected: bridge?.tally_connected ?? false,
      last_seen_at:   bridge?.last_seen_at ?? null,
      last_sync_at:   bridge?.last_sync_at ?? null,
      last_error:     bridge?.last_error ?? null,
      pending_count:  pending ?? 0,
      failed_count:   failed ?? 0,
    },
  });
}

const PatchSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("pause"),  reason: z.string().max(200).optional() }),
  z.object({ action: z.literal("resume") }),
  z.object({ action: z.literal("lock_company"),   company: z.string().min(1).max(200) }),
  z.object({ action: z.literal("update_company"), company: z.string().min(1).max(200) }),
  z.object({ action: z.literal("unlock_company") }),
  z.object({ action: z.literal("update_ledgers"), ledgers: z.record(z.string(), z.string()) }),
  z.object({ action: z.literal("update_gstin"), gstin: z.string().min(15).max(15) }),
]);

const LEDGER_KEY_MAP: Record<string, string> = {
  rent_income:  "tally_ledger_rent_income",
  usage_income: "tally_ledger_usage_income",
  cgst:         "tally_ledger_cgst_output",
  sgst:         "tally_ledger_sgst_output",
  igst:         "tally_ledger_igst_output",
  round_off:    "tally_ledger_round_off",
  party_suffix: "tally_party_ledger_suffix",
  voucher_series: "tally_voucher_series",
};

export async function PATCH(request: NextRequest) {
  const supabase = await createClient();
  const auth = await requireAdmin(supabase);
  if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

  let body: unknown;
  try { body = await request.json(); }
  catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }

  const parsed = PatchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid payload", details: parsed.error.flatten() }, { status: 400 });
  }
  const data = parsed.data;
  const admin = createAdminClient();
  const userId = auth.dbUser!.id;

  const set = async (key: string, value: string) => {
    await admin.from("app_settings").upsert({ key, value, updated_by: userId }, { onConflict: "key" });
  };

  switch (data.action) {
    case "pause":
      await set("tally_sync_enabled", "false");
      await set("tally_sync_paused_reason", data.reason ?? "");
      break;
    case "resume":
      await set("tally_sync_enabled", "true");
      await set("tally_sync_paused_reason", "");
      break;
    case "lock_company":
    case "update_company":
      await set("tally_locked_company", data.company);
      break;
    case "unlock_company":
      await set("tally_locked_company", "");
      break;
    case "update_gstin":
      await set("tally_company_gstin", data.gstin);
      break;
    case "update_ledgers":
      for (const [k, v] of Object.entries(data.ledgers)) {
        const settingKey = LEDGER_KEY_MAP[k];
        if (settingKey) await set(settingKey, v);
      }
      break;
  }

  void logAudit(admin, {
    entityType: "app_setting" as never,
    entityId:   "tally_sync_control",
    action:     "update" as never,
    performedBy: userId,
    changes:    { action: { old: null, new: JSON.stringify(data) } },
  });

  return NextResponse.json({ ok: true });
}
