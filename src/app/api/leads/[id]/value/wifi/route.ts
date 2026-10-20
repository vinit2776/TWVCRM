/**
 * GET /api/leads/[id]/value/wifi
 *
 * Wi-Fi sub-tab of the lead's Value tab (docs/customer-value-tab-spec.md,
 * section 5.7): which devices are this customer's, how much they use, when, and
 * how that compares with their share of seats.
 *
 * Usage comes from our own ledger (wifi_client_daily / wifi_client_hourly), never
 * a live console call; the one live read is the console's guest list, to turn a
 * voucher note into a device. Only deliberately linked devices count (see
 * wifi-devices). Read only; admin only. Naming a device goes through the existing
 * /api/unifi/device-labels route.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { cachedUnifiRequest, siteConfigFromLocation } from "@/lib/unifi";
import { loadCenterCohort } from "@/lib/customer-value/center-cohort";
import { fetchAllPages, fetchInChunks } from "@/lib/customer-value/query-helpers";
import {
  deviceDisplayName,
  resolveDevices,
  type AdhocLink,
  type GuestRecord,
  type IssuanceRow,
  type LabelRow,
  type WifiDevice,
} from "@/lib/customer-value/wifi-devices";
import {
  SERIES_DAYS,
  WINDOW_DAYS,
  buildHeatmap,
  dailySeries,
  profileTags,
  summariseUsage,
  windowCutoffDay,
  istDay,
  type DayRow,
  type HourRow,
} from "@/lib/customer-value/wifi-usage";

export const maxDuration = 30;

const paramsSchema = z.object({ id: z.string().uuid() });
const DAY_MS = 86_400_000;

type Status = "ok" | "no_center" | "no_wifi" | "no_devices";

const n = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const parsed = paramsSchema.safeParse(await params);
  if (!parsed.success) return NextResponse.json({ error: "Invalid lead id" }, { status: 400 });
  const leadId = parsed.data.id;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase.from("users").select("role").eq("auth_id", user.id).single();
  if (dbUser?.role !== "admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const now = new Date();
  const cache = { "Cache-Control": "private, max-age=60" };
  const empty = (status: Status, center: { id: string; name: string } | null = null) => ({ status, center });

  try {
    const cohort = await loadCenterCohort(supabase, leadId);
    if (!cohort) return NextResponse.json(empty("no_center"), { headers: cache });
    const center = { id: cohort.centerId, name: cohort.centerName };

    const { data: loc, error: locErr } = await supabase
      .from("locations")
      .select("unifi_console_id, unifi_site_id, wifi_voucher_mode")
      .eq("id", center.id)
      .single();
    if (locErr) throw new Error(locErr.message);
    if (!loc.unifi_site_id || !(loc.wifi_voucher_mode === "unifi_api" || loc.unifi_console_id)) {
      return NextResponse.json(empty("no_wifi", center), { headers: cache });
    }
    const cfg = siteConfigFromLocation(loc);

    const { data: hisContracts, error: cErr } = await supabase
      .from("contracts")
      .select("id, contract_number, status, seats")
      .eq("lead_id", leadId)
      .eq("location_id", center.id);
    if (cErr) throw new Error(cErr.message);
    const contracts = (hisContracts ?? []) as Array<{ id: string; contract_number: string; status: string; seats: number | string | null }>;
    const contractIds = contracts.map((c) => c.id);
    const liveSeats = contracts.filter((c) => c.status === "active" || c.status === "renewal_in_progress").reduce((s, c) => s + n(c.seats), 0);

    const [issuanceRes, adhocRes, labelRes, unitRes, guestResult] = await Promise.all([
      supabase.from("voucher_issuances").select("contract_id, seat_number, revoked_at, member:contract_members!voucher_issuances_member_id_fkey(name)").in("contract_id", contractIds),
      supabase.from("unifi_adhoc_voucher_links").select("note, contract_id").eq("location_id", center.id).in("contract_id", contractIds),
      supabase.from("unifi_device_labels").select("mac, label, contract_id").eq("location_id", center.id),
      supabase.from("space_units").select("capacity").eq("location_id", center.id).eq("is_active", true),
      cachedUnifiRequest<GuestRecord[]>("/stat/guest", {}, 60, cfg).then((g) => ({ ok: true as const, guests: g })).catch(() => ({ ok: false as const, guests: [] as GuestRecord[] })),
    ]);
    for (const r of [issuanceRes, adhocRes, labelRes, unitRes]) if (r.error) throw new Error(r.error.message);

    const capacity = (unitRes.data ?? []).reduce((s, u) => s + n(u.capacity), 0);
    const issuances: IssuanceRow[] = ((issuanceRes.data ?? []) as unknown as Array<{ contract_id: string; seat_number: number; revoked_at: string | null; member: { name: string | null } | { name: string | null }[] | null }>).map((i) => ({
      contract_id: i.contract_id, seat_number: i.seat_number, revoked_at: i.revoked_at,
      member_name: (Array.isArray(i.member) ? i.member[0]?.name : i.member?.name) ?? null,
    }));

    const devices = resolveDevices({
      contracts: contracts.map((c) => ({ id: c.id, contract_number: c.contract_number })),
      guests: guestResult.guests,
      issuances,
      adhocLinks: (adhocRes.data ?? []) as AdhocLink[],
      labels: (labelRes.data ?? []) as LabelRow[],
    });

    const base = { center, consoleReachable: guestResult.ok, seats: liveSeats, capacity: capacity > 0 ? capacity : null };
    if (devices.length === 0) return NextResponse.json({ ...base, status: "no_devices" satisfies Status, devices: [] }, { headers: cache });

    const macs = devices.map((d) => d.mac);
    const seriesFrom = new Date(now.getTime() - (SERIES_DAYS + 1) * DAY_MS).toISOString();
    const windowFrom = new Date(now.getTime() - (WINDOW_DAYS + 1) * DAY_MS).toISOString();

    const [dayRows, hourRows, siteDays, centerDayRows, hoursCoveredRes] = await Promise.all([
      fetchInChunks<DayRow>("wifi daily", macs, (batch, from, to) =>
        supabase.from("wifi_client_daily").select("mac, day_start, rx_bytes, tx_bytes").eq("location_id", center.id).in("mac", batch).gte("day_start", seriesFrom).order("mac").order("day_start").range(from, to)
      ),
      fetchInChunks<HourRow>("wifi hourly", macs, (batch, from, to) =>
        supabase.from("wifi_client_hourly").select("mac, hour_start, rx_bytes, tx_bytes").eq("location_id", center.id).in("mac", batch).order("mac").order("hour_start").range(from, to)
      ),
      fetchAllPages<{ day_start: string }>("wifi site days", (from, to) =>
        supabase.from("wifi_site_daily").select("day_start").eq("location_id", center.id).gte("day_start", seriesFrom).order("day_start").range(from, to)
      ),
      fetchAllPages<{ day_start: string; rx_bytes: number | string; tx_bytes: number | string }>("wifi center days", (from, to) =>
        supabase.from("wifi_client_daily").select("day_start, rx_bytes, tx_bytes").eq("location_id", center.id).gte("day_start", windowFrom).order("day_start").order("mac").range(from, to)
      ),
      supabase.from("wifi_site_hourly").select("hour_start", { count: "exact", head: true }).eq("location_id", center.id),
    ]);
    if (hoursCoveredRes.error) throw new Error(hoursCoveredRes.error.message);

    const mine: DayRow[] = dayRows.map((r) => ({ ...r, rx_bytes: n(r.rx_bytes), tx_bytes: n(r.tx_bytes) }));
    const hours: HourRow[] = hourRows.map((r) => ({ ...r, rx_bytes: n(r.rx_bytes), tx_bytes: n(r.tx_bytes) }));
    // Same days as the customer's own window, so the two figures divide cleanly.
    const cutoff = windowCutoffDay(now);
    const centerInWindow = centerDayRows.filter((r) => istDay(r.day_start) >= cutoff);
    const centerBytes = centerInWindow.length > 0 ? centerInWindow.reduce((s, r) => s + n(r.rx_bytes) + n(r.tx_bytes), 0) : null;

    const series = dailySeries(mine, siteDays.map((d) => d.day_start), now);
    const knownDays = series.slice(-WINDOW_DAYS).filter((p) => p.known).length;
    const summary = summariseUsage(mine, centerBytes, knownDays, now);
    const heatmap = buildHeatmap(hours, hoursCoveredRes.count ?? 0);
    const usageByMac = new Map(summary.perDevice.map((d) => [d.mac, d]));

    return NextResponse.json(
      {
        ...base,
        status: "ok" satisfies Status,
        windowDays: WINDOW_DAYS,
        devices: devices.map((d: WifiDevice) => ({ ...d, name: deviceDisplayName(d), usage: usageByMac.get(d.mac) ?? null })),
        summary: { ...summary, perDevice: undefined },
        series,
        heatmap,
        tags: profileTags(summary, heatmap),
      },
      { headers: cache }
    );
  } catch (err) {
    console.error("[api/leads/value/wifi] failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Failed to load Wi-Fi usage" }, { status: 500 });
  }
}
