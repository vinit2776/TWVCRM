/**
 * UniFi Network API client — multi-location support.
 *
 * Uses the UniFi cloud connector REST API:
 *   https://api.ui.com/v1/connector/consoles/{consoleId}/proxy/network/api/s/{siteName}
 *
 * Each exported function accepts an optional `SiteConfig` that identifies which
 * console + site to target. When omitted, env-var defaults are used (backward compat).
 *
 * Locations store their own `unifi_console_id` and `unifi_site_id` in the DB.
 * Pass those values here via `siteConfigFromLocation()`.
 */
import { unstable_cache } from "next/cache";

// ─── Env-var defaults (Nungambakkam LGF / single-controller setup) ────────────

const DEFAULT_CONSOLE_ID = process.env.UNIFI_CONSOLE_ID || "";
const DEFAULT_SITE_NAME  = process.env.UNIFI_SITE_NAME  || "default";
const UNIFI_API_KEY      = process.env.UNIFI_API_KEY    || "";
const UNIFI_API_ROOT     = "https://api.ui.com/v1/connector/consoles";

// ─── Per-location site config ─────────────────────────────────────────────────

export interface SiteConfig {
  /** UniFi cloud console UUID. Defaults to UNIFI_CONSOLE_ID env var. */
  consoleId?: string | null;
  /** UniFi site name (slug), e.g. "default". Defaults to UNIFI_SITE_NAME env var. */
  siteName?: string | null;
}

/**
 * Build a SiteConfig from a location row.
 * Falls back to env-var defaults for unset fields — so existing code
 * with no location row still works without changes.
 */
export function siteConfigFromLocation(location: {
  unifi_console_id?: string | null;
  unifi_site_id?: string | null;
}): SiteConfig {
  return {
    consoleId: location.unifi_console_id || DEFAULT_CONSOLE_ID || undefined,
    siteName:  location.unifi_site_id    || DEFAULT_SITE_NAME  || undefined,
  };
}

function resolveBaseUrl(cfg?: SiteConfig): string {
  const consoleId = cfg?.consoleId || DEFAULT_CONSOLE_ID;
  const siteName  = cfg?.siteName  || DEFAULT_SITE_NAME;
  if (!consoleId) {
    throw new Error(
      "[unifi] No console ID configured. Set UNIFI_CONSOLE_ID env var or location.unifi_console_id."
    );
  }
  if (!UNIFI_API_KEY) {
    throw new Error("[unifi] UNIFI_API_KEY env var is not set.");
  }
  return `${UNIFI_API_ROOT}/${consoleId}/proxy/network/api/s/${siteName}`;
}

// ─── Core request helpers ─────────────────────────────────────────────────────

export async function unifiRequest<T>(
  path: string,
  options: RequestInit = {},
  cfg?: SiteConfig
): Promise<T> {
  const baseUrl = resolveBaseUrl(cfg);
  const url = `${baseUrl}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      "X-API-KEY":     UNIFI_API_KEY,
      "Accept":        "application/json",
      "Content-Type":  "application/json",
      ...(options.headers || {}),
    },
  });

  const data = await res.json() as { meta: { rc: string; msg?: string }; data: T };

  if (!res.ok || data?.meta?.rc !== "ok") {
    throw new Error(
      `[unifi] ${options.method || "GET"} ${path} → ${res.status}: ` +
      (data?.meta?.msg || res.statusText)
    );
  }

  return data.data;
}

/**
 * Cached wrapper — do NOT use for mutations (cmd/hotspot, DELETE).
 */
export function cachedUnifiRequest<T>(
  path: string,
  options: RequestInit = {},
  ttl = 60,
  cfg?: SiteConfig
): Promise<T> {
  const consoleId = cfg?.consoleId || DEFAULT_CONSOLE_ID;
  const siteName  = cfg?.siteName  || DEFAULT_SITE_NAME;
  const cacheKey  = `unifi:${consoleId}:${siteName}:${path}:${JSON.stringify(options.body ?? "")}`;
  return unstable_cache(
    () => unifiRequest<T>(path, options, cfg),
    [cacheKey],
    { revalidate: ttl }
  )();
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface UnifiVoucher {
  _id: string;
  code: string;
  note: string;
  duration: number;       // minutes
  quota: number;          // max simultaneous devices (0 = unlimited)
  used: number;
  status: string;         // "VALID_ONE" | "VALID_MULTI" | "USED_ONE" | "USED_MULTIPLE" | "EXPIRED"
  create_time: number;    // unix seconds
  start_time?: number;
  end_time?: number;
  qos_rate_max_down?: number;  // Kbps
  qos_rate_max_up?: number;    // Kbps
  qos_usage_quota?: number;    // MBytes
  for_hotspot: boolean;
  site_id: string;
}

export interface CreateVoucherOptions {
  /** Duration in minutes — use exact contract/booking window */
  durationMinutes: number;
  /** Label stored on the voucher for identification */
  note: string;
  /** Max simultaneous devices (default 2) */
  quota?: number;
  /** Download speed cap in Kbps (optional) */
  rxRateLimitKbps?: number;
  /** Upload speed cap in Kbps (optional) */
  txRateLimitKbps?: number;
  /** Data usage cap in MBytes (optional) */
  dataUsageLimitMBytes?: number;
}

// ─── Voucher Operations ───────────────────────────────────────────────────────

/**
 * Create a single voucher with an exact duration.
 * Returns the UniFi internal _id and code.
 *
 * @param opts   Voucher parameters
 * @param cfg    Site config (console + site). Omit to use env-var defaults.
 */
export async function createUnifiVoucher(
  opts: CreateVoucherOptions,
  cfg?: SiteConfig
): Promise<{ id: string; code: string }> {
  const body: Record<string, unknown> = {
    cmd:          "create-voucher",
    expire:       opts.durationMinutes,
    expire_number: opts.durationMinutes,
    expire_unit:  1,        // 1 = minutes
    n:            1,
    note:         opts.note,
    quota:        opts.quota ?? 2,  // default 2 devices per voucher
  };

  if (opts.rxRateLimitKbps)      body.qos_rate_max_down = opts.rxRateLimitKbps;
  if (opts.txRateLimitKbps)      body.qos_rate_max_up   = opts.txRateLimitKbps;
  if (opts.dataUsageLimitMBytes) body.qos_usage_quota   = opts.dataUsageLimitMBytes;

  const result = await unifiRequest<Array<{ create_time: number }>>(
    "/cmd/hotspot",
    { method: "POST", body: JSON.stringify(body) },
    cfg
  );

  const createTime = result[0]?.create_time;
  if (!createTime) throw new Error("[unifi] createVoucher: missing create_time in response");

  // Fetch the created voucher to get its _id and code
  const vouchers = await unifiRequest<UnifiVoucher[]>(
    `/stat/voucher?create_time=${createTime}`,
    {},
    cfg
  );

  const voucher = vouchers.find(v => v.note === opts.note && v.create_time === createTime)
    ?? vouchers[0];

  if (!voucher) throw new Error("[unifi] createVoucher: could not find created voucher");

  return { id: voucher._id, code: voucher.code };
}

/**
 * Revoke (delete) a voucher by its UniFi internal _id.
 * Safe to call if the voucher is already expired or deleted — errors are logged, not thrown.
 *
 * @param voucherId  UniFi internal _id
 * @param cfg        Site config. Omit to use env-var defaults.
 */
export async function revokeUnifiVoucher(voucherId: string, cfg?: SiteConfig): Promise<void> {
  try {
    await unifiRequest(`/stat/voucher/${voucherId}`, { method: "DELETE" }, cfg);
  } catch (err) {
    console.warn(`[unifi] revokeVoucher ${voucherId} failed (may already be deleted):`, err);
  }
}

/**
 * Fetch details of a specific voucher by _id.
 */
export async function getUnifiVoucher(voucherId: string, cfg?: SiteConfig): Promise<UnifiVoucher | null> {
  try {
    const vouchers = await unifiRequest<UnifiVoucher[]>(`/stat/voucher/${voucherId}`, {}, cfg);
    return vouchers[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * Fetch the SSID of the hotspot/captive-portal network (open security).
 */
export async function getUnifiHotspotSsid(cfg?: SiteConfig): Promise<string | null> {
  try {
    const wlans = await unifiRequest<Array<{ name: string; security: string; enabled: boolean }>>(
      "/list/wlanconf",
      {},
      cfg
    );
    const hotspot = wlans.find((w) => w.security === "open" && w.enabled !== false);
    return hotspot?.name ?? null;
  } catch {
    return null;
  }
}

/**
 * Returns true if this location is configured to use the UniFi live API.
 * Use wifi_voucher_mode for the definitive check; unifi_site_id is a fallback signal.
 */
export function isUnifiLocation(location: {
  wifi_voucher_mode?: string | null;
  unifi_site_id?: string | null;
}): boolean {
  if (location.wifi_voucher_mode) return location.wifi_voucher_mode === "unifi_api";
  return Boolean(location.unifi_site_id);
}

/**
 * Calculate exact voucher duration in minutes from now until a contract/booking end date.
 * Adds a buffer (default 60 min) so sessions don't cut out at the stroke of midnight.
 */
export function calcVoucherMinutes(endDate: string | Date, bufferMinutes = 60): number {
  const end = new Date(endDate);
  const now = new Date();
  const diffMs = end.getTime() - now.getTime();
  const diffMinutes = Math.ceil(diffMs / 60_000);
  return Math.max(diffMinutes + bufferMinutes, 1);
}
