/**
 * Ruijie Cloud API client — voucher issuance for Ruijie Reyee locations
 * (currently: Nungambakkam Arcade, RAP2200(E) + NBR6210-E via Ruijie Cloud).
 *
 * Uses the Ruijie Cloud REST API: https://cloud-as.ruijienetworks.com/service/api/...
 * Reference: Ruijie Cloud API Reference Manual V2.0.3, section 2.3 (Voucher
 * Management) and 2.7 (User Group Management).
 *
 * Unlike UniFi, a Ruijie voucher does not take an exact duration at creation
 * time — it references a pre-configured "User Group" package with a fixed
 * timePeriod/quota, set up in the Ruijie Cloud console (IT owns this; the CRM
 * only reads the list). createRuijieVoucher() picks the closest "CRM_"-prefixed
 * package to the requested duration, mirroring the ±20% tolerance-matching
 * already used for repository-mode vouchers.
 *
 * KNOWN GAP (as of 2026-07): the Ruijie Cloud API has no voucher revoke/disable
 * endpoint, and no way to reset a MAC-bound voucher. Contract termination and
 * device-replacement flows cannot act on Ruijie vouchers via API yet — see
 * docs/modules/vouchers.md. There is deliberately no revokeRuijieVoucher()
 * export here; do not add one that doesn't call a real endpoint.
 */
import { unstable_cache } from "next/cache";

const RUIJIE_APP_ID = process.env.RUIJIE_APP_ID || "";
const RUIJIE_APP_SECRET = process.env.RUIJIE_APP_SECRET || "";
const RUIJIE_CLOUD_URL_PREFIX = process.env.RUIJIE_CLOUD_URL_PREFIX || "https://cloud-as.ruijienetworks.com";
// Fixed literal required by Ruijie's access-token endpoint (documented as-is, not a secret).
const RUIJIE_TOKEN_QUERY_VALUE = "d63dss0a81e4415a889ac5b78fsc904a";
// CRM-managed packages are distinguished from IT's manually-created tenant/cabin
// packages by this prefix (see docs/modules/vouchers.md).
const CRM_PACKAGE_PREFIX = "CRM_";

// ─── Per-location site config ─────────────────────────────────────────────────

export interface RuijieSiteConfig {
  /** Ruijie Cloud network group ID (site identifier). */
  groupId: number;
}

export function siteConfigFromLocation(location: {
  ruijie_group_id?: number | null;
}): RuijieSiteConfig | null {
  if (!location.ruijie_group_id) return null;
  return { groupId: location.ruijie_group_id };
}

/**
 * Returns true if this location is configured to use the Ruijie Cloud API.
 */
export function isRuijieLocation(location: {
  wifi_voucher_mode?: string | null;
}): boolean {
  return location.wifi_voucher_mode === "ruijie_api";
}

// ─── Token management ──────────────────────────────────────────────────────
// Ruijie's own docs contradict themselves on token lifetime (30 days in one
// section, 30-minute idle expiry in another). Cache conservatively under the
// stricter claim and always retry once on an expired-token response (code 4)
// rather than trust a fixed TTL.

let cachedToken: { token: string; fetchedAt: number } | null = null;
const TOKEN_CACHE_MS = 25 * 60 * 1000; // 25 min

async function fetchAccessToken(): Promise<string> {
  if (!RUIJIE_APP_ID || !RUIJIE_APP_SECRET) {
    throw new Error("[ruijie] RUIJIE_APP_ID / RUIJIE_APP_SECRET env vars are not set.");
  }
  const res = await fetch(
    `${RUIJIE_CLOUD_URL_PREFIX}/service/api/oauth20/client/access_token?token=${RUIJIE_TOKEN_QUERY_VALUE}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ appid: RUIJIE_APP_ID, secret: RUIJIE_APP_SECRET }),
    }
  );
  const data = (await res.json()) as { code: number; msg?: string; accessToken?: string };
  if (!res.ok || data.code !== 0 || !data.accessToken) {
    throw new Error(`[ruijie] access_token request failed: ${data.msg || res.statusText}`);
  }
  return data.accessToken;
}

async function getAccessToken(): Promise<string> {
  const now = Date.now();
  if (cachedToken && now - cachedToken.fetchedAt < TOKEN_CACHE_MS) {
    return cachedToken.token;
  }
  const token = await fetchAccessToken();
  cachedToken = { token, fetchedAt: now };
  return token;
}

// ─── Core request helper ───────────────────────────────────────────────────

interface RuijieResponse {
  code: number;
  msg?: string;
  [key: string]: unknown;
}

async function ruijieRequest<T extends RuijieResponse>(
  path: string,
  options: RequestInit = {},
  query: Record<string, string | number> = {},
  allowRetry = true
): Promise<T> {
  const token = await getAccessToken();
  const params = new URLSearchParams({
    ...Object.fromEntries(Object.entries(query).map(([k, v]) => [k, String(v)])),
    access_token: token,
  });
  const url = `${RUIJIE_CLOUD_URL_PREFIX}${path}?${params.toString()}`;

  const res = await fetch(url, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
  });

  const data = (await res.json()) as T;

  // code 4 = expired access_token per the API reference — refresh once and retry.
  if (data.code === 4 && allowRetry) {
    cachedToken = null;
    return ruijieRequest<T>(path, options, query, false);
  }

  if (!res.ok || data.code !== 0) {
    throw new Error(`[ruijie] ${options.method || "GET"} ${path} → ${res.status}: ${data.msg || res.statusText}`);
  }

  return data;
}

// ─── User Group (package) lookup ───────────────────────────────────────────

export interface RuijiePackage {
  /** userGroupId — passed to voucher/create. */
  id: number;
  /** profile UUID — passed to voucher/create. */
  authProfileId: string;
  name: string;
  timePeriodMinutes: number;
}

interface UserGroupListResponse extends RuijieResponse {
  data?: Array<{ id: number; authProfileId: string; userGroupName: string; timePeriod: number }>;
}

async function listRuijiePackages(groupId: number): Promise<RuijiePackage[]> {
  const data = await ruijieRequest<UserGroupListResponse>(
    `/service/api/intl/usergroup/list/${groupId}`,
    { method: "GET" },
    { pageIndex: 0, pageSize: 200 }
  );
  return (data.data || []).map((g) => ({
    id: g.id,
    authProfileId: g.authProfileId,
    name: g.userGroupName,
    timePeriodMinutes: g.timePeriod,
  }));
}

/** Packages change rarely — cache the list for 5 minutes. */
function cachedListRuijiePackages(groupId: number): Promise<RuijiePackage[]> {
  return unstable_cache(() => listRuijiePackages(groupId), [`ruijie:packages:${groupId}`], {
    revalidate: 300,
  })();
}

/**
 * Pick the closest "CRM_"-prefixed package to a target contract length,
 * using the same ±20% tolerance as repository-mode voucher matching.
 * IT's manually-created tenant/cabin packages are never matched here.
 */
export function matchRuijiePackage(
  packages: RuijiePackage[],
  targetDays: number
): { pkg: RuijiePackage; matchWarning: string | null } | { error: string } {
  const crmPackages = packages.filter((p) => p.name.startsWith(CRM_PACKAGE_PREFIX));
  if (crmPackages.length === 0) {
    return { error: "No CRM_ voucher packages configured for this location. Ask IT to create them in Ruijie Cloud." };
  }

  const targetMinutes = targetDays * 24 * 60;
  const TOLERANCE = 0.2;
  const minAcceptable = targetMinutes * (1 - TOLERANCE);
  const maxAcceptable = targetMinutes * (1 + TOLERANCE);

  const withinTolerance = crmPackages.filter(
    (p) => p.timePeriodMinutes >= minAcceptable && p.timePeriodMinutes <= maxAcceptable
  );

  if (withinTolerance.length === 0) {
    const available = crmPackages
      .map((p) => `${p.name} (${Math.round(p.timePeriodMinutes / 1440)}d)`)
      .join(", ");
    const targetLabel = targetDays < 1 ? `${Math.round(targetDays * 24)}-hour` : `${Math.round(targetDays)}-day`;
    return {
      error: `No CRM_ package matches a ${targetLabel} target within tolerance. Available: ${available}`,
    };
  }

  const sorted = [...withinTolerance].sort(
    (a, b) => Math.abs(a.timePeriodMinutes - targetMinutes) - Math.abs(b.timePeriodMinutes - targetMinutes)
  );
  const pkg = sorted[0];
  const targetLabel = targetDays < 1 ? `${Math.round(targetDays * 24)}-hour` : `${Math.round(targetDays)}-day`;
  const matchWarning =
    pkg.timePeriodMinutes !== targetMinutes
      ? `Exact ${targetLabel} package not available. Using closest match: ${pkg.name} (${Math.round(pkg.timePeriodMinutes / 1440)} days).`
      : null;

  return { pkg, matchWarning };
}

// ─── Voucher creation ───────────────────────────────────────────────────────

export interface RuijieVoucherResult {
  uuid: string;
  code: string;
  expiryTime: string;
}

interface VoucherCreateResponse extends RuijieResponse {
  voucherData?: {
    count: number;
    list: Array<{ uuid: string; codeNo: string; expiryTime: string }>;
  };
}

async function createRuijieVoucher(opts: {
  groupId: number;
  userGroupId: number;
  authProfileId: string;
  comment: string;
}): Promise<RuijieVoucherResult> {
  const body = {
    quantity: 1,
    profile: opts.authProfileId,
    userGroupId: opts.userGroupId,
    comment: opts.comment,
  };

  const data = await ruijieRequest<VoucherCreateResponse>(
    `/service/api/open/auth/voucher/create/${opts.groupId}`,
    { method: "POST", body: JSON.stringify(body) },
    {}
  );

  const voucher = data.voucherData?.list?.[0];
  if (!voucher) throw new Error("[ruijie] createVoucher: no voucher returned in response");

  return { uuid: voucher.uuid, code: voucher.codeNo, expiryTime: voucher.expiryTime };
}

/**
 * Issue one voucher for a contract seat or booking: look up this site's
 * CRM_ packages, pick the closest match to targetDays, and create the
 * voucher against it. Shared by both the contract and booking issuance
 * routes — the package-matching logic doesn't care which one is calling.
 *
 * @param site        Ruijie site config (groupId)
 * @param targetDays  Target length in days (contracts: tenure_months * 30;
 *                    bookings: duration_hours / 24) — Ruijie can't do exact
 *                    durations, only pick from pre-set packages, so very short
 *                    bookings will fail to match until short CRM_ packages exist.
 * @param comment     Alias stored on the voucher, e.g. "{contract_number}_seat{N}"
 *                    or "booking_{id}_seat{N}"
 */
export async function issueRuijieVoucher(
  site: RuijieSiteConfig,
  targetDays: number,
  comment: string
): Promise<{ result: RuijieVoucherResult; matchWarning: string | null } | { error: string }> {
  const packages = await cachedListRuijiePackages(site.groupId);
  const matched = matchRuijiePackage(packages, targetDays);
  if ("error" in matched) return matched;

  const result = await createRuijieVoucher({
    groupId: site.groupId,
    userGroupId: matched.pkg.id,
    authProfileId: matched.pkg.authProfileId,
    comment,
  });

  return { result, matchWarning: matched.matchWarning };
}

// ─── Voucher listing (for the monitoring panel) ────────────────────────────

export interface RuijieVoucherSummary {
  uuid: string;
  code: string;
  packageName: string;
  status: string; // "1" unused | "2" in-use | "3" expired
  timePeriodMinutes: number;
  maxClients: number;
  currentClients: number;
  usedQuota: number;
  createTime: number;
  expiryTime: number | null;
  comment: string;
}

interface VoucherListResponse extends RuijieResponse {
  voucherData?: {
    count: number;
    list: Array<{
      uuid: string;
      voucherCode: string;
      packageName: string;
      status: string;
      timePeriod: number;
      maxClients: number;
      currentClients: number;
      usedQuota: number;
      createTime: number;
      expiryTime?: number;
      comment: string;
    }>;
  };
}

/**
 * Look up one voucher by its exact code — for manually linking a voucher that
 * was already issued outside the CRM (e.g. by IT, before this integration
 * existed) to a contract/seat. Staff must have already verified the code
 * belongs to the right customer's device; this is a lookup, not a search.
 */
export async function findRuijieVoucherByCode(groupId: number, code: string): Promise<RuijieVoucherSummary | null> {
  const vouchers = await listRuijieVouchers(groupId);
  const normalized = code.trim().toLowerCase();
  return vouchers.find((v) => v.code.toLowerCase() === normalized) ?? null;
}

/** Full voucher list for a site — not cached, this backs a live monitoring view. */
export async function listRuijieVouchers(groupId: number): Promise<RuijieVoucherSummary[]> {
  const data = await ruijieRequest<VoucherListResponse>(
    `/service/api/open/auth/voucher/getList/${groupId}`,
    { method: "GET" },
    { start: 0, pageSize: 200 }
  );
  return (data.voucherData?.list || []).map((v) => ({
    uuid: v.uuid,
    code: v.voucherCode,
    packageName: v.packageName,
    status: v.status,
    timePeriodMinutes: v.timePeriod,
    maxClients: v.maxClients,
    currentClients: v.currentClients,
    usedQuota: v.usedQuota,
    createTime: v.createTime,
    expiryTime: v.expiryTime ?? null,
    comment: v.comment,
  }));
}

// ─── Device status (for the monitoring panel) ──────────────────────────────

export interface RuijieDevice {
  serialNumber: string;
  productClass: string;
  commonType: string;
  onlineStatus: string; // "ON" | "OFF" | "NEVER_ONLINE"
  name: string;
  aliasName: string;
  softwareVersion: string;
  newestSoftwareVersion: string;
  staNums: number;
  staActiveNums: number;
  radio1ChannelUtil?: number;
  radio2ChannelUtil?: number;
  lastOnline: number;
}

interface DeviceListResponse extends RuijieResponse {
  deviceList?: Array<Record<string, unknown>>;
  totalCount?: number;
}

/**
 * List devices of a given type under a group. Ruijie's API returns HTTP 500
 * (not an empty list) for a device type with zero registered devices — treat
 * that as "none of this type" rather than surfacing it as an error.
 */
async function listRuijieDevicesByType(groupId: number, commonType: "AP" | "Gateway" | "Switch"): Promise<RuijieDevice[]> {
  try {
    const data = await ruijieRequest<DeviceListResponse>(
      "/service/api/maint/devices",
      { method: "GET" },
      { common_type: commonType, group_id: groupId, page: 0, per_page: 50 }
    );
    return (data.deviceList || []) as unknown as RuijieDevice[];
  } catch {
    return [];
  }
}

export async function listRuijieDevices(groupId: number): Promise<RuijieDevice[]> {
  const [aps, gateways, switches] = await Promise.all([
    listRuijieDevicesByType(groupId, "AP"),
    listRuijieDevicesByType(groupId, "Gateway"),
    listRuijieDevicesByType(groupId, "Switch"),
  ]);
  return [...aps, ...gateways, ...switches];
}

export interface RuijieDevicePerformance {
  cpuRate: number;
  memoryRate: number;
  flashRate: number;
}

interface PerformanceResponse extends RuijieResponse {
  data?: { cpuRate: number; memoryRate: number; flashRate: number };
}

/** CPU/memory snapshot for one device. Returns null if unavailable rather than throwing. */
export async function getRuijieDevicePerformance(sn: string): Promise<RuijieDevicePerformance | null> {
  try {
    const data = await ruijieRequest<PerformanceResponse>(
      "/logbizagent/logbiz/api/sys/current_performance",
      { method: "GET" },
      { sn }
    );
    if (!data.data) return null;
    return {
      cpuRate: data.data.cpuRate,
      memoryRate: data.data.memoryRate,
      flashRate: data.data.flashRate,
    };
  } catch {
    return null;
  }
}

// ─── Connected clients (for the monitoring panel) ──────────────────────────

export interface RuijieClient {
  mac: string;
  ssid: string;
  band: string;
  userIp: string;
  rssiInt: number;
  score: number;
  scoreReason: string;
  onlineTime: number;
  wifiUp: number;
  wifiDown: number;
  deviceAliasName: string;
}

interface ClientListResponse extends RuijieResponse {
  list?: Array<Record<string, unknown>>;
  count?: number;
}

/** Currently-connected clients for a site. */
export async function listRuijieClients(groupId: number): Promise<RuijieClient[]> {
  const data = await ruijieRequest<ClientListResponse>(
    "/logbizagent/logbiz/api/sta/sta_users",
    {
      method: "POST",
      body: JSON.stringify({ groupId, pageSize: 100, pageIndex: 0, staType: "currentUser" }),
    },
    {}
  );
  return (data.list || []) as unknown as RuijieClient[];
}
