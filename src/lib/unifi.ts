/**
 * UniFi Network API client — Nungambakkam LGF only.
 *
 * Uses the legacy UniFi Network REST API via the UniFi cloud connector:
 *   https://api.ui.com/v1/connector/consoles/{consoleId}/proxy/network/api/s/default
 *
 * Other locations continue using the import-based voucher stack.
 */

const UNIFI_API_BASE_URL = process.env.UNIFI_API_BASE_URL || "";
const UNIFI_API_KEY      = process.env.UNIFI_API_KEY      || "";

function ensureConfig() {
  if (!UNIFI_API_BASE_URL || !UNIFI_API_KEY) {
    throw new Error(
      "[unifi] UNIFI_API_BASE_URL and UNIFI_API_KEY must be set. " +
      "Run: npx vercel env pull"
    );
  }
}

export async function unifiRequest<T>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  ensureConfig();
  const url = `${UNIFI_API_BASE_URL}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      "X-API-KEY": UNIFI_API_KEY,
      "Accept": "application/json",
      "Content-Type": "application/json",
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

// ─── Types ───────────────────────────────────────────────────────────────────

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
  /** Max simultaneous devices (default 1) */
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
 */
export async function createUnifiVoucher(
  opts: CreateVoucherOptions
): Promise<{ id: string; code: string }> {
  const body: Record<string, unknown> = {
    cmd: "create-voucher",
    expire: opts.durationMinutes,
    expire_number: opts.durationMinutes,
    expire_unit: 1,        // 1 = minutes
    n: 1,
    note: opts.note,
    quota: opts.quota ?? 1,
  };

  if (opts.rxRateLimitKbps)        body.qos_rate_max_down  = opts.rxRateLimitKbps;
  if (opts.txRateLimitKbps)        body.qos_rate_max_up    = opts.txRateLimitKbps;
  if (opts.dataUsageLimitMBytes)   body.qos_usage_quota    = opts.dataUsageLimitMBytes;

  const result = await unifiRequest<Array<{ create_time: number }>>(
    "/cmd/hotspot",
    { method: "POST", body: JSON.stringify(body) }
  );

  const createTime = result[0]?.create_time;
  if (!createTime) throw new Error("[unifi] createVoucher: missing create_time in response");

  // Fetch the created voucher to get its _id and code
  const vouchers = await unifiRequest<UnifiVoucher[]>(
    `/stat/voucher?create_time=${createTime}`
  );

  const voucher = vouchers.find(v => v.note === opts.note && v.create_time === createTime)
    ?? vouchers[0];

  if (!voucher) throw new Error("[unifi] createVoucher: could not find created voucher");

  return { id: voucher._id, code: voucher.code };
}

/**
 * Revoke (delete) a voucher by its UniFi internal _id.
 * Call this on contract cancellation / booking cancellation.
 * Safe to call if the voucher is already expired or deleted — errors are logged, not thrown.
 */
export async function revokeUnifiVoucher(voucherId: string): Promise<void> {
  try {
    await unifiRequest(`/stat/voucher/${voucherId}`, { method: "DELETE" });
  } catch (err) {
    // If the voucher is already gone that's fine — log and continue
    console.warn(`[unifi] revokeVoucher ${voucherId} failed (may already be deleted):`, err);
  }
}

/**
 * Fetch details of a specific voucher by _id.
 */
export async function getUnifiVoucher(voucherId: string): Promise<UnifiVoucher | null> {
  try {
    const vouchers = await unifiRequest<UnifiVoucher[]>(`/stat/voucher/${voucherId}`);
    return vouchers[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * Fetch the SSID of the hotspot/captive-portal network (open security).
 * Returns the name of the first WLAN with security = "open", or null if not found.
 */
export async function getUnifiHotspotSsid(): Promise<string | null> {
  try {
    const wlans = await unifiRequest<Array<{ name: string; security: string; enabled: boolean }>>(
      "/list/wlanconf"
    );
    // The hotspot network is "open" — clients hit the captive portal login
    const hotspot = wlans.find((w) => w.security === "open" && w.enabled !== false);
    return hotspot?.name ?? null;
  } catch {
    return null;
  }
}

/**
 * Returns true if the given location should use the UniFi API.
 * Pass the location row from the DB; if unifi_site_id is set, this returns true.
 */
export function isUnifiLocation(location: { unifi_site_id?: string | null }): boolean {
  return Boolean(location?.unifi_site_id);
}

/**
 * Calculate exact voucher duration in minutes from now until a contract/booking end date.
 * Adds a small buffer (default 60 min) so sessions don't cut out at the stroke of midnight.
 */
export function calcVoucherMinutes(endDate: string | Date, bufferMinutes = 60): number {
  const end = new Date(endDate);
  const now = new Date();
  const diffMs = end.getTime() - now.getTime();
  const diffMinutes = Math.ceil(diffMs / 60_000);
  return Math.max(diffMinutes + bufferMinutes, 1);
}
