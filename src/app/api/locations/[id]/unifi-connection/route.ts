/**
 * /api/locations/[id]/unifi-connection
 *
 * Connects a location to its UniFi console: sets the console + site on the
 * location, switches it to live-API vouchers, and stores the console's own API
 * key encrypted in unifi_console_credentials. The key is verified against the
 * console before anything is saved, and is never returned to the browser.
 *
 *   GET    → { console_id, site_id, mode, has_own_key }
 *   PUT    → { console_id, site_id?, api_key? }  (api_key omitted = keep stored key)
 *   DELETE → removes the stored key (location falls back to the shared env key)
 *
 * admin / it_manager only: this controls who can issue guest Wi-Fi vouchers.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { encryptSecret } from "@/lib/crypto-secrets";
import { clearUnifiKeyCache } from "@/lib/unifi";

const ALLOWED_ROLES = ["admin", "it_manager"];
const API_ROOT = "https://api.ui.com/v1/connector/consoles";

const putSchema = z.object({
  console_id: z.string().trim().min(10).max(200),
  site_id: z.string().trim().min(1).max(100).default("default"),
  api_key: z.string().trim().min(20).max(200).optional(),
});

async function authorize() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  const { data: dbUser } = await supabase
    .from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser || !ALLOWED_ROLES.includes(dbUser.role)) {
    return { error: NextResponse.json({ error: "Admin or IT Manager access required" }, { status: 403 }) };
  }
  return { userId: dbUser.id as string };
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const auth = await authorize();
  if (auth.error) return auth.error;

  const admin = createAdminClient();
  const { data: loc, error } = await admin
    .from("locations")
    .select("unifi_console_id, unifi_site_id, wifi_voucher_mode")
    .eq("id", id)
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!loc) return NextResponse.json({ error: "Location not found" }, { status: 404 });

  let hasOwnKey = false;
  if (loc.unifi_console_id) {
    const { data: cred } = await admin
      .from("unifi_console_credentials")
      .select("console_id")
      .eq("console_id", loc.unifi_console_id)
      .maybeSingle();
    hasOwnKey = Boolean(cred);
  }
  return NextResponse.json({
    data: {
      console_id: loc.unifi_console_id,
      site_id: loc.unifi_site_id,
      mode: loc.wifi_voucher_mode,
      has_own_key: hasOwnKey,
    },
  });
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const auth = await authorize();
  if (auth.error) return auth.error;

  const parsed = putSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request", details: parsed.error.flatten() }, { status: 400 });
  }
  const { console_id, site_id, api_key } = parsed.data;
  const admin = createAdminClient();

  const { data: loc } = await admin
    .from("locations")
    .select("id, unifi_console_id, unifi_site_id, wifi_voucher_mode")
    .eq("id", id)
    .maybeSingle();
  if (!loc) return NextResponse.json({ error: "Location not found" }, { status: 404 });

  // Which key to verify: the one being submitted, else what's already stored.
  if (!api_key) {
    const { data: stored } = await admin
      .from("unifi_console_credentials")
      .select("console_id")
      .eq("console_id", console_id)
      .maybeSingle();
    if (!stored && !process.env.UNIFI_API_KEY) {
      return NextResponse.json({ error: "Enter the console's API key" }, { status: 400 });
    }
  }

  // Verify against the console before saving anything. Read-only GET.
  if (api_key) {
    let status: number;
    try {
      const res = await fetch(
        `${API_ROOT}/${encodeURIComponent(console_id)}/proxy/network/api/s/${encodeURIComponent(site_id)}/list/wlanconf`,
        { headers: { "X-API-KEY": api_key, Accept: "application/json" }, signal: AbortSignal.timeout(20_000) }
      );
      status = res.status;
    } catch {
      return NextResponse.json({ error: "Could not reach UniFi to verify the key. Try again." }, { status: 502 });
    }
    if (status !== 200) {
      const hint =
        status === 401 ? "UniFi rejected the key. Use an account-level key (unifi.ui.com → API) from the account that owns this console."
        : status === 403 ? "That key's account does not own this console, so the cloud connector refuses it."
        : status === 404 ? "Console ID or site not found."
        : `UniFi returned ${status}.`;
      return NextResponse.json({ error: hint }, { status: 422 });
    }

    const { error: credErr } = await admin.from("unifi_console_credentials").upsert({
      console_id,
      api_key_encrypted: encryptSecret(api_key),
      updated_by: auth.userId,
    });
    if (credErr) return NextResponse.json({ error: credErr.message }, { status: 500 });
    clearUnifiKeyCache(console_id);
  }

  const { error: locErr } = await admin
    .from("locations")
    .update({ unifi_console_id: console_id, unifi_site_id: site_id, wifi_voucher_mode: "unifi_api" })
    .eq("id", id);
  if (locErr) return NextResponse.json({ error: locErr.message }, { status: 500 });

  // The key itself is deliberately not part of the audit payload.
  void logAudit(admin, {
    entityType: "location",
    entityId: id,
    action: "update",
    performedBy: auth.userId,
    changes: {
      unifi_console_id: { old: loc.unifi_console_id, new: console_id },
      unifi_site_id: { old: loc.unifi_site_id, new: site_id },
      wifi_voucher_mode: { old: loc.wifi_voucher_mode, new: "unifi_api" },
      ...(api_key ? { unifi_api_key: { old: null, new: "REPLACED" } } : {}),
    },
  });

  return NextResponse.json({ data: { console_id, site_id, mode: "unifi_api" } });
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const auth = await authorize();
  if (auth.error) return auth.error;

  const admin = createAdminClient();
  const { data: loc } = await admin.from("locations").select("unifi_console_id").eq("id", id).maybeSingle();
  if (!loc?.unifi_console_id) return NextResponse.json({ error: "No UniFi console on this location" }, { status: 404 });

  const { error } = await admin.from("unifi_console_credentials").delete().eq("console_id", loc.unifi_console_id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  clearUnifiKeyCache(loc.unifi_console_id);

  void logAudit(admin, {
    entityType: "location", entityId: id, action: "update", performedBy: auth.userId,
    changes: { unifi_api_key: { old: "SET", new: "REMOVED" } },
  });
  return NextResponse.json({ data: { removed: true } });
}
