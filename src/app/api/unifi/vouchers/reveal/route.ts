/**
 * POST /api/unifi/vouchers/reveal
 *
 * Reveals the full voucher code for a given UniFi voucher _id.
 * Access is logged to the audit trail.
 * Auth required: any authenticated user.
 */
import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { cachedUnifiRequest, siteConfigForLocationId, type SiteConfig } from "@/lib/unifi";
import { unifiConfigErrorResponse } from "@/lib/unifi-http";
import { logAudit } from "@/lib/audit";
import type { UnifiVoucher } from "@/lib/unifi";

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 401 });

  let body: { voucher_id?: string; location_id?: string };
  try {
    body = await request.json() as { voucher_id?: string; location_id?: string };
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { voucher_id, location_id } = body;
  if (!location_id || typeof location_id !== "string") {
    return NextResponse.json({ error: "location_id is required" }, { status: 400 });
  }
  if (!voucher_id || typeof voucher_id !== "string") {
    return NextResponse.json({ error: "voucher_id is required" }, { status: 400 });
  }

  let siteCfg: SiteConfig;
  try {
    siteCfg = await siteConfigForLocationId(location_id);
  } catch (err) {
    return unifiConfigErrorResponse(err);
  }

  // If the CRM recorded where this voucher was issued and it is not this
  // location's console, refuse rather than look the code up on the wrong console.
  const admin = createAdminClient();
  const [issuedHere, linkedHere] = await Promise.all([
    admin.from("voucher_issuances").select("unifi_console_id").eq("unifi_voucher_id", voucher_id).not("unifi_console_id", "is", null).limit(1),
    admin.from("unifi_adhoc_voucher_links").select("unifi_console_id").eq("unifi_voucher_id", voucher_id).not("unifi_console_id", "is", null).limit(1),
  ]);
  const recordedConsole = issuedHere.data?.[0]?.unifi_console_id ?? linkedHere.data?.[0]?.unifi_console_id;
  if (recordedConsole && recordedConsole !== siteCfg.consoleId) {
    return NextResponse.json(
      { error: "This voucher was issued on a different UniFi console than this location's. Open it from the location it was issued for." },
      { status: 409 }
    );
  }

  try {
    // Use cached list (60s TTL) — avoids re-fetching 19 MB on every reveal
    const vouchers = await cachedUnifiRequest<UnifiVoucher[]>("/stat/voucher", {}, 60, siteCfg);
    const voucher = vouchers.find((v) => v._id === voucher_id);

    if (!voucher) {
      return NextResponse.json({ error: "Voucher not found" }, { status: 404 });
    }

    // Log the access to the audit trail (fire and forget)
    void logAudit(admin, {
      entityType: "unifi_voucher",
      entityId: voucher_id,
      action: "view",
      performedBy: dbUser.id,
      changes: {
        code_revealed: { old: null, new: "ACCESSED" },
        voucher_note: { old: null, new: voucher.note ?? null },
        accessed_by_role: { old: null, new: dbUser.role },
      },
    });

    return NextResponse.json({
      code: voucher.code,
      note: voucher.note ?? null,
      duration: voucher.duration,
      status: voucher.status,
    });
  } catch (err) {
    console.error("[api/unifi/vouchers/reveal] fetch failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to reach UniFi device" },
      { status: 502 }
    );
  }
}
