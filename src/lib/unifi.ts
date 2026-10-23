/**
 * UniFi Network API client — multi-location support.
 *
 * Uses the UniFi cloud connector REST API:
 *   https://api.ui.com/v1/connector/consoles/{consoleId}/proxy/network/api/s/{siteName}
 *
 * Every request needs a `SiteConfig` naming the console + site to target.
 * There is deliberately NO default console: a call without one throws
 * `UnifiConfigError` instead of quietly talking to some other site's console
 * (the original single-site setup defaulted to Nungambakkam, which is wrong
 * for every other location).
 *
 * Locations store their own `unifi_console_id` and `unifi_site_id` in the DB.
 * Get a config with `siteConfigFromLocation()` (you hold the row),
 * `siteConfigForLocationId()` (you hold an id) or `siteConfigForStoredVoucher()`
 * (you hold a voucher — uses the console it was issued on).
 */
import { unstable_cache } from "next/cache";
import { createAdminClient } from "@/lib/supabase/server";
import { decryptSecret } from "@/lib/crypto-secrets";

// ─── Constants ────────────────────────────────────────────────────────────────

// UniFi's built-in site slug; only a site *name* default, never a console.
const DEFAULT_SITE_NAME = "default";
// Shared fallback key for consoles without their own row in unifi_console_credentials.
const UNIFI_API_KEY      = process.env.UNIFI_API_KEY    || "";
const UNIFI_API_ROOT     = "https://api.ui.com/v1/connector/consoles";

/** A UniFi call was attempted without a console/site that can be trusted. Never retried, never defaulted. */
export class UnifiConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnifiConfigError";
  }
}

// ─── Per-location site config ─────────────────────────────────────────────────

export interface SiteConfig {
  /** UniFi cloud console id — always explicit, never defaulted. */
  consoleId: string;
  /** UniFi site name (slug), e.g. "default". */
  siteName: string;
}

/**
 * Build a SiteConfig from a location row. Throws `UnifiConfigError` when the
 * location has no `unifi_console_id` — there is no env-var fallback.
 */
export function siteConfigFromLocation(location: {
  unifi_console_id?: string | null;
  unifi_site_id?: string | null;
  code?: string | null;
}): SiteConfig {
  const consoleId = location.unifi_console_id?.trim();
  if (!consoleId) {
    throw new UnifiConfigError(
      `Location${location.code ? ` ${location.code}` : ""} has no UniFi console ID set. ` +
      "Set it under Network → Configuration. (There is no default console, so nothing was sent to UniFi.)"
    );
  }
  return { consoleId, siteName: location.unifi_site_id?.trim() || DEFAULT_SITE_NAME };
}

/**
 * Resolve a location id to its UniFi site config (service-role lookup, for
 * flows that only hold a location id — cron jobs, approvals, list endpoints).
 * Throws `UnifiConfigError` for a missing id, an unknown location or a
 * location without its own console.
 */
export async function siteConfigForLocationId(
  locationId: string | null | undefined
): Promise<SiteConfig> {
  if (!locationId) {
    throw new UnifiConfigError("A location is required to reach a UniFi console — none was given.");
  }
  const { data, error } = await createAdminClient()
    .from("locations")
    .select("code, unifi_console_id, unifi_site_id")
    .eq("id", locationId)
    .maybeSingle();
  if (error) throw new UnifiConfigError(`Could not look up the location's UniFi console: ${error.message}`);
  if (!data) throw new UnifiConfigError("Location not found, so its UniFi console is unknown.");
  return siteConfigFromLocation(data);
}

/**
 * Site config for something that was already issued (revoke / reveal / email).
 * Uses the console recorded at issue time; only rows that predate the record
 * fall back to the location's console. The site name comes from the location
 * only while that location still points at the same console.
 */
export async function siteConfigForStoredVoucher(stored: {
  consoleId?: string | null;
  locationId?: string | null;
}): Promise<SiteConfig> {
  const consoleId = stored.consoleId?.trim();
  if (!consoleId) return siteConfigForLocationId(stored.locationId);
  let siteName = DEFAULT_SITE_NAME;
  if (stored.locationId) {
    const { data } = await createAdminClient()
      .from("locations")
      .select("unifi_console_id, unifi_site_id")
      .eq("id", stored.locationId)
      .maybeSingle();
    if (data?.unifi_console_id === consoleId && data.unifi_site_id?.trim()) siteName = data.unifi_site_id.trim();
  }
  return { consoleId, siteName };
}

/** Fails loudly for a missing/blank config — the single choke point every request passes through. */
function requireConfig(cfg: SiteConfig | null | undefined): SiteConfig {
  if (!cfg?.consoleId?.trim()) {
    throw new UnifiConfigError(
      "No UniFi console specified for this request. Refusing to fall back to a default console."
    );
  }
  return { consoleId: cfg.consoleId.trim(), siteName: cfg.siteName?.trim() || DEFAULT_SITE_NAME };
}

function resolveBaseUrl(cfg: SiteConfig): string {
  const { consoleId, siteName } = requireConfig(cfg);
  return `${UNIFI_API_ROOT}/${consoleId}/proxy/network/api/s/${siteName}`;
}

// ─── Voucher notes (identify the location on the controller itself) ──────────

/** "PGD | TWV-C-0123_seat1" — the location code leads, so a voucher is recognisable on the controller. */
export function buildVoucherNote(locationCode: string | null | undefined, base: string): string {
  const code = locationCode?.trim();
  return code ? `${code} | ${base}` : base;
}

/** Inverse of buildVoucherNote: drops a leading "<location code> | ", leaves any other note untouched. */
export function stripVoucherNotePrefix(note: string): string {
  const m = note.match(/^[^|]{1,40}? \| (.+)$/);
  return m ? m[1] : note;
}

// ─── API key resolution ───────────────────────────────────────────────────────

const KEY_CACHE_TTL_MS = 5 * 60_000;
const keyCache = new Map<string, { key: string | null; at: number }>();

/** Drop a console's cached key — call after saving or removing it. */
export function clearUnifiKeyCache(consoleId?: string) {
  if (consoleId) keyCache.delete(consoleId);
  else keyCache.clear();
}

/**
 * The API key for a console: its own encrypted key in unifi_console_credentials
 * if one is stored, else the shared UNIFI_API_KEY env var. The cloud connector
 * only proxies for the console's owning account, so consoles owned by a
 * different UniFi account need their own key.
 */
async function resolveApiKey(consoleId: string): Promise<string> {
  const hit = keyCache.get(consoleId);
  let stored: string | null;
  if (hit && Date.now() - hit.at < KEY_CACHE_TTL_MS) {
    stored = hit.key;
  } else {
    const { data, error } = await createAdminClient()
      .from("unifi_console_credentials")
      .select("api_key_encrypted")
      .eq("console_id", consoleId)
      .maybeSingle();
    if (error) {
      // A failed lookup must not silently fall through to a key that belongs
      // to a different account — fail loudly instead.
      throw new Error(`[unifi] could not look up the API key for this console: ${error.message}`);
    }
    stored = data?.api_key_encrypted ? decryptSecret(data.api_key_encrypted) : null;
    keyCache.set(consoleId, { key: stored, at: Date.now() });
  }
  const key = stored || UNIFI_API_KEY;
  if (!key) {
    throw new Error("[unifi] No API key for this console. Save one for the location or set UNIFI_API_KEY.");
  }
  return key;
}

// ─── Core request helpers ─────────────────────────────────────────────────────

export async function unifiRequest<T>(
  path: string,
  options: RequestInit = {},
  cfg: SiteConfig
): Promise<T> {
  const baseUrl = resolveBaseUrl(cfg);
  const apiKey = await resolveApiKey(requireConfig(cfg).consoleId);
  const url = `${baseUrl}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      "X-API-KEY":     apiKey,
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
  cfg: SiteConfig
): Promise<T> {
  const { consoleId, siteName } = requireConfig(cfg);
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
 * @param cfg    Site config (console + site) — required, there is no default.
 */
export async function createUnifiVoucher(
  opts: CreateVoucherOptions,
  cfg: SiteConfig
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

  // Sanity check: the voucher must live on the site we meant to target. If it
  // does not, delete it again and fail rather than hand out a code that works
  // on the wrong site.
  const expectedSiteId = await getUnifiSiteInternalId(cfg);
  if (expectedSiteId && voucher.site_id && voucher.site_id !== expectedSiteId) {
    await revokeUnifiVoucher(voucher._id, cfg);
    throw new UnifiConfigError(
      `UniFi created the voucher on a different site (${voucher.site_id}) than the one configured ` +
      `(${cfg.siteName}, ${expectedSiteId}). The voucher was deleted again; check the console ID for this location.`
    );
  }

  return { id: voucher._id, code: voucher.code };
}

const siteIdCache = new Map<string, string>();

/**
 * The internal `_id` UniFi stamps on vouchers (`site_id`) for the configured
 * site, looked up from the console's site list. Returns null when it cannot be
 * determined (the check is then skipped, with a warning, rather than blocking).
 */
export async function getUnifiSiteInternalId(cfg: SiteConfig): Promise<string | null> {
  const { consoleId, siteName } = requireConfig(cfg);
  const cacheKey = `${consoleId}:${siteName}`;
  const hit = siteIdCache.get(cacheKey);
  if (hit) return hit;
  try {
    const res = await fetch(`${UNIFI_API_ROOT}/${consoleId}/proxy/network/api/self/sites`, {
      headers: { "X-API-KEY": await resolveApiKey(consoleId), Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    const json = await res.json() as { data?: Array<{ _id: string; name: string }> };
    const site = res.ok ? json.data?.find((x) => x.name === siteName) : undefined;
    if (!site?._id) {
      console.warn(`[unifi] could not resolve the internal site id for ${siteName} (HTTP ${res.status}); post-issue site check skipped`);
      return null;
    }
    siteIdCache.set(cacheKey, site._id);
    return site._id;
  } catch (err) {
    console.warn("[unifi] site id lookup failed; post-issue site check skipped:", err);
    return null;
  }
}

export interface UnifiConsoleInfo {
  /** The console id exists under the key that was used. */
  found: boolean;
  /** Human name of the console as set in UniFi (e.g. "MWP-TWV"). */
  name: string | null;
}

/**
 * Look a console up in UniFi's cloud host list (api.ui.com/v1/hosts) so an admin
 * can see *which* console an id points at. `apiKey` overrides the stored key
 * (used while saving a new one). Read-only. Throws on transport/auth failure.
 */
export async function getUnifiConsoleInfo(consoleId: string, apiKey?: string): Promise<UnifiConsoleInfo> {
  const key = apiKey || (await resolveApiKey(consoleId));
  let nextToken: string | undefined;
  for (let page = 0; page < 10; page++) {
    const url = new URL("https://api.ui.com/v1/hosts");
    url.searchParams.set("pageSize", "100");
    if (nextToken) url.searchParams.set("nextToken", nextToken);
    const res = await fetch(url, {
      headers: { "X-API-KEY": key, Accept: "application/json" },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`UniFi returned ${res.status} when listing consoles`);
    const json = await res.json() as {
      data?: Array<{ id: string; reportedState?: { name?: string; hostname?: string } | null; userData?: { name?: string } | null }>;
      nextToken?: string;
    };
    const host = json.data?.find((h) => h.id === consoleId);
    if (host) {
      return { found: true, name: host.reportedState?.name || host.userData?.name || host.reportedState?.hostname || null };
    }
    if (!json.nextToken) break;
    nextToken = json.nextToken;
  }
  return { found: false, name: null };
}

/**
 * Revoke (delete) a voucher by its UniFi internal _id.
 * Safe to call if the voucher is already expired or deleted — errors are logged, not thrown.
 *
 * @param voucherId  UniFi internal _id
 * @param cfg        Site config of the console that issued the voucher.
 */
export async function revokeUnifiVoucher(voucherId: string, cfg: SiteConfig): Promise<void> {
  // Outside the try on purpose: a missing console is a config error to surface,
  // not a "voucher already deleted" case to swallow.
  requireConfig(cfg);
  try {
    // `DELETE /stat/voucher/{id}` is not a delete — UniFi answers 200 with the
    // voucher list and removes nothing, so revocations silently did nothing.
    // The hotspot command is what actually deletes (verified on the Perungudi
    // console: the voucher is gone from /stat/voucher afterwards).
    await unifiRequest(
      "/cmd/hotspot",
      { method: "POST", body: JSON.stringify({ cmd: "delete-voucher", _id: voucherId }) },
      cfg
    );
  } catch (err) {
    console.warn(`[unifi] revokeVoucher ${voucherId} failed (may already be deleted):`, err);
  }
}

/**
 * Fetch details of a specific voucher by _id.
 */
export async function getUnifiVoucher(voucherId: string, cfg: SiteConfig): Promise<UnifiVoucher | null> {
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
export async function getUnifiHotspotSsid(cfg: SiteConfig): Promise<string | null> {
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
