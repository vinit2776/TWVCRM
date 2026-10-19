import type { SupabaseClient } from "@supabase/supabase-js";
import { siteConfigFromLocation, unifiRequest, type SiteConfig } from "@/lib/unifi";

// Scheduled capture of the UniFi console's Wi-Fi usage into our own ledger:
// hourly (wifi_client_hourly, wifi_site_hourly; migration 00625; the console keeps
// about 7 days) and daily (wifi_client_daily, wifi_site_daily; 00627; about 90
// days), copied before they age out.
//
// Idempotent and self-healing: each run asks for everything since a little
// before the last stored hour and upserts it, so a missed run is simply caught
// up by the next, and the hour still in progress is overwritten with fuller
// numbers on the following run. Read-only against UniFi; writes only the two
// ledger tables; messages nobody.

/** How far back the console keeps hourly figures; asking for more returns nothing extra. */
export const CONSOLE_HOURLY_RETENTION_DAYS = 7;
/** How far back the console keeps daily figures (about 90 days); a little over, so nothing near the edge is missed. */
export const CONSOLE_DAILY_RETENTION_DAYS = 95;
/** Re-read this many days before the last stored day, so the day that was in progress is completed. */
const DAILY_OVERLAP_DAYS = 2;
/** Re-read this far before the last stored hour, so the hour that was in progress is completed. */
const OVERLAP_HOURS = 3;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const WRITE_CHUNK = 500;

export interface ClientHourRow {
  location_id: string;
  mac: string;
  hour_start: string;
  rx_bytes: number;
  tx_bytes: number;
}

export interface SiteHourRow {
  location_id: string;
  hour_start: string;
  wlan_bytes: number;
  num_sta: number | null;
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * The console's hourly buckets start at :30 past the UTC hour (they are aligned to
 * the site's IST hour), so the bucket's own start time is kept exactly as
 * reported. Rounding it to a UTC hour would shift every row 30 minutes early and
 * put usage in the wrong IST hour.
 */
function bucketIso(ms: number): string {
  return new Date(ms).toISOString();
}

/** Keeps only well-formed rows, so one odd row from the console can't fail the whole write. */
export function parseClientRows(locationId: string, raw: unknown): ClientHourRow[] {
  if (!Array.isArray(raw)) return [];
  const byKey = new Map<string, ClientHourRow>();
  for (const r of raw as Array<Record<string, unknown>>) {
    if (typeof r?.user !== "string" || !/^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/i.test(r.user) || !isNum(r.time)) continue;
    const rx = isNum(r.rx_bytes) && r.rx_bytes > 0 ? Math.round(r.rx_bytes) : 0;
    const tx = isNum(r.tx_bytes) && r.tx_bytes > 0 ? Math.round(r.tx_bytes) : 0;
    if (rx === 0 && tx === 0) continue;
    const mac = r.user.toLowerCase();
    const hour = bucketIso(r.time);
    // A device reported twice in one hour (it moved between access points) is one row.
    const key = `${mac}|${hour}`;
    const prev = byKey.get(key);
    if (prev) {
      prev.rx_bytes += rx;
      prev.tx_bytes += tx;
    } else {
      byKey.set(key, { location_id: locationId, mac, hour_start: hour, rx_bytes: rx, tx_bytes: tx });
    }
  }
  return [...byKey.values()];
}

export function parseSiteRows(locationId: string, raw: unknown): SiteHourRow[] {
  if (!Array.isArray(raw)) return [];
  const byHour = new Map<string, SiteHourRow>();
  for (const r of raw as Array<Record<string, unknown>>) {
    if (!isNum(r?.time)) continue;
    const hour = bucketIso(r.time);
    byHour.set(hour, {
      location_id: locationId,
      hour_start: hour,
      wlan_bytes: isNum(r.wlan_bytes) && r.wlan_bytes > 0 ? Math.round(r.wlan_bytes) : 0,
      num_sta: isNum(r.num_sta) ? Math.round(r.num_sta) : null,
    });
  }
  return [...byHour.values()];
}

/** Where to start asking: shortly before the last stored hour, never before the console's own limit. */
export function captureWindowStart(lastStoredHour: string | null, now: Date): number {
  const floor = now.getTime() - CONSOLE_HOURLY_RETENTION_DAYS * DAY_MS;
  if (!lastStoredHour) return floor;
  return Math.max(floor, new Date(lastStoredHour).getTime() - OVERLAP_HOURS * HOUR_MS);
}

export interface ClientDayRow {
  location_id: string;
  mac: string;
  day_start: string;
  rx_bytes: number;
  tx_bytes: number;
}

export interface SiteDayRow {
  location_id: string;
  day_start: string;
  wlan_bytes: number;
  num_sta: number | null;
}

/** The daily report has the same shape as the hourly one; only the bucket is a day (it starts at IST midnight). */
export function parseClientDayRows(locationId: string, raw: unknown): ClientDayRow[] {
  return parseClientRows(locationId, raw).map(({ hour_start, ...r }) => ({ ...r, day_start: hour_start }));
}

export function parseSiteDayRows(locationId: string, raw: unknown): SiteDayRow[] {
  return parseSiteRows(locationId, raw).map(({ hour_start, ...r }) => ({ ...r, day_start: hour_start }));
}

/** Where to start asking for daily figures: a couple of days before the last stored day, never before the console's own limit. */
export function dailyWindowStart(lastStoredDay: string | null, now: Date): number {
  const floor = now.getTime() - CONSOLE_DAILY_RETENTION_DAYS * DAY_MS;
  if (!lastStoredDay) return floor;
  return Math.max(floor, new Date(lastStoredDay).getTime() - DAILY_OVERLAP_DAYS * DAY_MS);
}

export interface LocationWifiCapture {
  clientRows: number;
  siteRows: number;
  clientDayRows: number;
  siteDayRows: number;
  /** Newest hour now stored for the site, or null when nothing came back. */
  through: string | null;
}

async function upsertChunks<T extends object>(supabase: SupabaseClient, table: string, rows: T[], onConflict: string): Promise<void> {
  for (let i = 0; i < rows.length; i += WRITE_CHUNK) {
    const { error } = await supabase.from(table).upsert(rows.slice(i, i + WRITE_CHUNK), { onConflict });
    if (error) throw new Error(`${table} write failed: ${error.message}`);
  }
}

export async function captureLocationWifi(
  supabase: SupabaseClient,
  { locationId, cfg, now = new Date() }: { locationId: string; cfg: SiteConfig; now?: Date }
): Promise<LocationWifiCapture> {
  const { data: last, error: lastErr } = await supabase
    .from("wifi_site_hourly")
    .select("hour_start")
    .eq("location_id", locationId)
    .order("hour_start", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (lastErr) throw new Error(`ledger read failed: ${lastErr.message}`);

  const start = captureWindowStart((last?.hour_start as string | undefined) ?? null, now);
  const body = (attrs: string[]) => JSON.stringify({ attrs, start, end: now.getTime() });

  const [clientRaw, siteRaw] = await Promise.all([
    unifiRequest<unknown>("/stat/report/hourly.user", { method: "POST", body: body(["rx_bytes", "tx_bytes", "time"]) }, cfg),
    unifiRequest<unknown>("/stat/report/hourly.site", { method: "POST", body: body(["wlan_bytes", "num_sta", "time"]) }, cfg),
  ]);

  const clients = parseClientRows(locationId, clientRaw);
  const site = parseSiteRows(locationId, siteRaw);
  await upsertChunks(supabase, "wifi_client_hourly", clients, "location_id,mac,hour_start");
  await upsertChunks(supabase, "wifi_site_hourly", site, "location_id,hour_start");

  // Daily figures go second: if the console refuses them, the hourly rows above are already safe.
  const { data: lastDay, error: lastDayErr } = await supabase
    .from("wifi_site_daily")
    .select("day_start")
    .eq("location_id", locationId)
    .order("day_start", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (lastDayErr) throw new Error(`ledger read failed: ${lastDayErr.message}`);
  const dayStart = dailyWindowStart((lastDay?.day_start as string | undefined) ?? null, now);
  const dayBody = (attrs: string[]) => JSON.stringify({ attrs, start: dayStart, end: now.getTime() });
  const [clientDayRaw, siteDayRaw] = await Promise.all([
    unifiRequest<unknown>("/stat/report/daily.user", { method: "POST", body: dayBody(["rx_bytes", "tx_bytes", "time"]) }, cfg),
    unifiRequest<unknown>("/stat/report/daily.site", { method: "POST", body: dayBody(["wlan_bytes", "num_sta", "time"]) }, cfg),
  ]);
  const clientDays = parseClientDayRows(locationId, clientDayRaw);
  const siteDays = parseSiteDayRows(locationId, siteDayRaw);
  await upsertChunks(supabase, "wifi_client_daily", clientDays, "location_id,mac,day_start");
  await upsertChunks(supabase, "wifi_site_daily", siteDays, "location_id,day_start");

  const through = site.reduce<string | null>((m, r) => (m === null || r.hour_start > m ? r.hour_start : m), null);
  return { clientRows: clients.length, siteRows: site.length, clientDayRows: clientDays.length, siteDayRows: siteDays.length, through };
}

export interface LocationWifiSummary {
  location_id: string;
  status: "ok" | "error";
  client_rows: number;
  site_rows: number;
  client_day_rows: number;
  site_day_rows: number;
  /** Plain classification only: never the console's own text, which can carry its internal addresses. */
  error_kind?: "console" | "write" | "internal";
}

interface LocationRow {
  id: string;
  unifi_console_id: string | null;
  unifi_site_id: string | null;
  wifi_voucher_mode: string | null;
}

export async function captureAllWifi(
  supabase: SupabaseClient,
  { now = new Date(), budgetMs = 50_000 }: { now?: Date; budgetMs?: number } = {}
): Promise<{ locations: LocationWifiSummary[]; skipped: number }> {
  const { data, error } = await supabase
    .from("locations")
    .select("id, unifi_console_id, unifi_site_id, wifi_voucher_mode")
    .not("unifi_site_id", "is", null);
  if (error) throw new Error(`location read failed: ${error.message}`);

  // Same test as the AP-health cron for "this center is UniFi managed".
  const targets = ((data ?? []) as LocationRow[]).filter((l) => l.wifi_voucher_mode === "unifi_api" || Boolean(l.unifi_console_id));

  const started = Date.now();
  const locations: LocationWifiSummary[] = [];
  let skipped = 0;
  for (const loc of targets) {
    if (Date.now() - started > budgetMs) { skipped++; continue; }
    try {
      const r = await captureLocationWifi(supabase, { locationId: loc.id, cfg: siteConfigFromLocation(loc), now });
      locations.push({ location_id: loc.id, status: "ok", client_rows: r.clientRows, site_rows: r.siteRows, client_day_rows: r.clientDayRows, site_day_rows: r.siteDayRows });
    } catch (err) {
      const message = err instanceof Error ? err.message : "";
      locations.push({
        location_id: loc.id,
        status: "error",
        client_rows: 0,
        site_rows: 0,
        client_day_rows: 0,
        site_day_rows: 0,
        error_kind: message.startsWith("[unifi]") ? "console" : message.includes("write failed") ? "write" : "internal",
      });
    }
  }
  return { locations, skipped };
}
