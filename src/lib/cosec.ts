/**
 * Matrix COSEC Devices API client.
 *
 * All calls are server-side only — device credentials never reach the browser.
 * Protocol: plain HTTP, Basic Auth, GET (or POST for binary credential data).
 * Response format: XML (parsed) or text.
 *
 * API base: http://<device_ip>:<device_port>/device.cgi/<endpoint>?action=<action>&...
 */

import type { SupabaseClient } from "@supabase/supabase-js";

export interface CosecDevice {
  ip: string;
  port: number;
  password: string; // device admin password
}

export interface CosecEvent {
  rollOverCount: number;
  seqNumber: number;
  date: string;    // DD/M/YYYY from device
  time: string;    // HH:MM:SS from device
  eventId: number;
  refUserId: number;
  detail1: number;
  detail2: number;
  detail3: number;
  eventTime: Date; // parsed UTC date
}

// COSEC event IDs (verified against live Matrix COSEC device firmware)
// Device reports: 101 = access granted, 201 = access denied, 405 = enrollment complete
export const COSEC_EVENT = {
  ACCESS_GRANTED: 101,
  ACCESS_DENIED: 201,
  ENROLLMENT_COMPLETE: 405,
} as const;

// For event 201 (ACCESS_DENIED), detail-1 encodes the denial reason
export const COSEC_DENIAL_REASON: Record<number, string> = {
  1: "Credential not recognized",
  2: "Invalid credential",
  3: "User inactive or not enrolled",
  4: "Validity expired",
  5: "Anti-passback violation",
  6: "Outside access window",
};

// detail-3 in access granted events (101) encodes IN/OUT direction
// 10 (decimal) → IN (bit 4 = 0), 20 (decimal) → OUT (bit 4 = 1)
export function parseDirection(detail3: number): "IN" | "OUT" {
  return (detail3 & 0x10) === 0 ? "IN" : "OUT";
}

// ─── Private helpers ──────────────────────────────────────────────────────────

function basicAuth(password: string): string {
  return "Basic " + Buffer.from(`admin:${password}`).toString("base64");
}

function deviceUrl(device: CosecDevice, endpoint: string, params: Record<string, string | number>): string {
  const base = `http://${device.ip}:${device.port}/device.cgi/${endpoint}`;
  const qs = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join("&");
  return qs ? `${base}?${qs}` : base;
}

async function cosecGet(device: CosecDevice, endpoint: string, params: Record<string, string | number>, timeoutMs = 8000): Promise<string> {
  const url = deviceUrl(device, endpoint, params);
  const res = await fetch(url, {
    method: "GET",
    headers: { Authorization: basicAuth(device.password) },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    throw new Error(`COSEC HTTP ${res.status} for ${endpoint}`);
  }
  return res.text();
}

/** Parse a simple key=value text response from the device */
function parseTextResponse(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of text.trim().split(/\s+/)) {
    const eq = line.indexOf("=");
    if (eq > 0) result[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return result;
}

/** Extract a single tag value from XML response */
function xmlValue(xml: string, tag: string): string {
  const m = xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
  return m ? m[1] : "";
}

/** Extract all occurrences of an XML block */
function xmlBlocks(xml: string, tag: string): string[] {
  const blocks: string[] = [];
  const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) blocks.push(m[0]);
  return blocks;
}

function assertResponseCode(text: string, context: string) {
  // Text responses: "Response-Code=0" means success
  const code = text.match(/Response-Code=(\d+)/i)?.[1];
  if (code && code !== "0") {
    throw new Error(`COSEC error ${code} in ${context}`);
  }
  // XML responses: <response-code>0</response-code>
  const xmlCode = xmlValue(text, "response-code");
  if (xmlCode && xmlCode !== "0") {
    throw new Error(`COSEC error ${xmlCode} in ${context}`);
  }
}

// ─── Connection test ─────────────────────────────────────────────────────────

export interface CosecPingResult {
  ok: boolean;
  deviceName?: string;
  appVersion?: string;
  error?: string;
  latencyMs?: number;
}

export async function pingDevice(device: CosecDevice): Promise<CosecPingResult> {
  const start = Date.now();
  try {
    const xml = await cosecGet(device, "device-basic-config", {
      action: "get",
      format: "xml",
    });
    const name = xmlValue(xml, "name");
    const app = xmlValue(xml, "app");
    return {
      ok: true,
      deviceName: name || "Unknown",
      appVersion: app || "Unknown",
      latencyMs: Date.now() - start,
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      latencyMs: Date.now() - start,
    };
  }
}

// ─── User lifecycle ───────────────────────────────────────────────────────────

export interface ProvisionUserParams {
  cosecUserId: string;       // "C{id}", "E{id}", "B{id}" — max 15 chars
  cosecRefId: number;        // numeric, max 8 digits
  name: string;              // max 15 chars
  userActive: boolean;
  validUntil?: Date;
  pin?: string;              // 1-6 digits
  selfEnrollmentEnable?: boolean;
  byPassFinger?: boolean;    // allow PIN-only (no biometric required)
  card1?: string;            // NFC card CSN
  userGroup?: number;        // 0-999 for grouping employees by dept
}

export async function provisionUser(device: CosecDevice, params: ProvisionUserParams): Promise<void> {
  const p: Record<string, string | number> = {
    action: "set",
    "user-id": params.cosecUserId,
    "ref-user-id": params.cosecRefId,
    name: params.name.slice(0, 15),
    "user-active": params.userActive ? 1 : 0,
  };

  if (params.validUntil) {
    p["validity-enable"] = 1;
    p["validity-date-dd"] = params.validUntil.getDate();
    p["validity-date-mm"] = params.validUntil.getMonth() + 1;
    p["validity-date-yyyy"] = params.validUntil.getFullYear();
  }

  if (params.pin) p["user-pin"] = params.pin;
  if (params.selfEnrollmentEnable !== undefined) {
    p["self-enrollment-enable"] = params.selfEnrollmentEnable ? 1 : 0;
  }
  if (params.byPassFinger !== undefined) {
    p["by-pass-finger"] = params.byPassFinger ? 1 : 0;
  }
  if (params.card1) p["card1"] = params.card1;
  if (params.userGroup !== undefined) p["user-group"] = params.userGroup;

  const text = await cosecGet(device, "users", p);
  assertResponseCode(text, `provisionUser(${params.cosecUserId})`);
}

export async function setUserActive(device: CosecDevice, cosecUserId: string, active: boolean): Promise<void> {
  const text = await cosecGet(device, "users", {
    action: "set",
    "user-id": cosecUserId,
    "user-active": active ? 1 : 0,
  });
  assertResponseCode(text, `setUserActive(${cosecUserId}, ${active})`);
}

/**
 * Re-activate a user and push a fresh valid_until date to the device.
 * Only touches user-active and validity fields — leaves PIN, card, biometric untouched.
 * Pass validUntil=null to remove the validity limit (access never expires).
 */
export async function refreshUserValidity(
  device: CosecDevice,
  cosecUserId: string,
  validUntil: Date | null
): Promise<void> {
  const p: Record<string, string | number> = {
    action: "set",
    "user-id": cosecUserId,
    "user-active": 1,
  };
  if (validUntil) {
    p["validity-enable"] = 1;
    p["validity-date-dd"]   = validUntil.getDate();
    p["validity-date-mm"]   = validUntil.getMonth() + 1;
    p["validity-date-yyyy"] = validUntil.getFullYear();
  } else {
    p["validity-enable"] = 0;
  }
  const text = await cosecGet(device, "users", p);
  assertResponseCode(text, `refreshUserValidity(${cosecUserId})`);
}

export async function setUserPin(device: CosecDevice, cosecUserId: string, pin: string): Promise<void> {
  const text = await cosecGet(device, "users", {
    action: "set",
    "user-id": cosecUserId,
    "user-pin": pin,
  });
  assertResponseCode(text, `setUserPin(${cosecUserId})`);
}

export async function setCardNumber(device: CosecDevice, cosecUserId: string, cardNumber: string): Promise<void> {
  const text = await cosecGet(device, "users", {
    action: "set",
    "user-id": cosecUserId,
    "card1": cardNumber,
  });
  assertResponseCode(text, `setCardNumber(${cosecUserId})`);
}

export async function deleteUserFromDevice(device: CosecDevice, cosecUserId: string): Promise<void> {
  const text = await cosecGet(device, "users", {
    action: "delete",
    "user-id": cosecUserId,
  });
  assertResponseCode(text, `deleteUser(${cosecUserId})`);
}

// ─── Card scanning ────────────────────────────────────────────────────────────

export interface ReadCardResult {
  cardNumber: string;
  cardType: string;
}

/**
 * Poll the device for a card tap.
 *
 * card-read-write?action=read returns IMMEDIATELY with the most recently
 * tapped card CSN (or card-no=0 if no card has been tapped since the last
 * read). It does NOT block waiting for a tap — so we poll every second
 * until a card CSN is returned or the timeout expires.
 *
 * fp-index is a fingerprint-slot parameter and must NOT be sent here;
 * it was previously included by mistake and caused the device to look
 * at biometric reader context instead of the card reader.
 */
export async function readCardFromDevice(
  device: CosecDevice,
  timeoutMs = 20000
): Promise<ReadCardResult> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;

    try {
      const url = deviceUrl(device, "card-read-write", {
        action: "read",
        format: "xml",
        // Note: fp-index intentionally omitted — it is for fingerprint slots,
        // not card reading, and caused the device to return card-no=0.
      });

      const res = await fetch(url, {
        method: "GET",
        headers: { Authorization: basicAuth(device.password) },
        signal: AbortSignal.timeout(Math.min(3000, remaining)),
      });

      if (res.ok) {
        const xml = await res.text();
        const code = xmlValue(xml, "response-code");
        // response-code=0 (or empty) means success — check for card-no
        if (!code || code === "0") {
          const cardNo  = xmlValue(xml, "card-no");
          const cardType = xmlValue(xml, "Card-type");
          if (cardNo && cardNo !== "0") {
            return { cardNumber: cardNo, cardType };
          }
          // card-no=0 → no tap yet, fall through to next poll
        }
        // non-zero response code → device not ready, fall through
      }
    } catch {
      // Network error or per-attempt abort — keep polling until deadline
    }

    // Wait 1 second before the next poll (skip if almost out of time)
    const wait = Math.min(1000, deadline - Date.now());
    if (wait > 50) await new Promise(r => setTimeout(r, wait));
  }

  throw new Error(
    "No card detected within 20 seconds. Tap the card on the reader and try again."
  );
}

// ─── Commands ─────────────────────────────────────────────────────────────────

export async function openDoor(device: CosecDevice): Promise<void> {
  const text = await cosecGet(device, "command", {
    action: "opendoor",
    "extra-info1": "TWVO", // TWV Open — identifies source in event log
  });
  assertResponseCode(text, "openDoor");
}

// ─── Event polling ────────────────────────────────────────────────────────────

export interface PollEventsResult {
  events: CosecEvent[];
  lastRollOverCount: number;
  lastSeqNumber: number;
}

export async function pollEvents(
  device: CosecDevice,
  rollOverCount: number,
  seqNumber: number,
  maxEvents = 100
): Promise<PollEventsResult> {
  const xml = await cosecGet(device, "events", {
    action: "getevent",
    "roll-over-count": rollOverCount,
    "seq-number": seqNumber,
    "no-of-events": maxEvents,
    format: "xml",
  });

  const blocks = xmlBlocks(xml, "Events");
  if (blocks.length === 0) {
    return { events: [], lastRollOverCount: rollOverCount, lastSeqNumber: seqNumber };
  }

  const events: CosecEvent[] = [];
  let lastRollOver = rollOverCount;
  let lastSeq = seqNumber;

  for (const block of blocks) {
    const roc = parseInt(xmlValue(block, "roll-over-count") || "0", 10);
    const seq = parseInt(xmlValue(block, "seq-No"), 10);
    const dateStr = xmlValue(block, "date"); // DD/M/YYYY
    const timeStr = xmlValue(block, "time"); // HH:MM:SS
    const eventId = parseInt(xmlValue(block, "event-id"), 10);
    const detail1 = parseInt(xmlValue(block, "detail-1") || "0", 10);
    const detail2 = parseInt(xmlValue(block, "detail-2") || "0", 10);
    const detail3 = parseInt(xmlValue(block, "detail-3") || "0", 10);

    // detail-1 is the ref-user-id in user events
    const refUserId = detail1;

    // Parse device local time — device reports in local time (IST)
    let eventTime = new Date();
    if (dateStr && timeStr) {
      const [day, month, year] = dateStr.split("/").map(Number);
      const [hh, mm, ss] = timeStr.split(":").map(Number);
      // Treat as IST (UTC+5:30) and convert
      eventTime = new Date(Date.UTC(year, month - 1, day, hh - 5, mm - 30, ss));
    }

    events.push({ rollOverCount: roc, seqNumber: seq, date: dateStr, time: timeStr, eventId, refUserId, detail1, detail2, detail3, eventTime });

    if (roc > lastRollOver || (roc === lastRollOver && seq > lastSeq)) {
      lastRollOver = roc;
      lastSeq = seq;
    }
  }

  return { events, lastRollOverCount: lastRollOver, lastSeqNumber: lastSeq };
}

// ─── Cosec user ID helpers ────────────────────────────────────────────────────

/** Build a deterministic 15-char COSEC user ID from a UUID */
export function contractCosecId(contractId: string): string {
  return `C${contractId.replace(/-/g, "").slice(0, 14)}`;
}

/** Contract member (named seat holder) — range 1-49999 for ref-user-id */
export function memberCosecId(memberId: string): string {
  return `M${memberId.replace(/-/g, "").slice(0, 14)}`;
}

export function employeeCosecId(employeeId: string): string {
  return `E${employeeId.replace(/-/g, "").slice(0, 14)}`;
}

export function bookingCosecId(bookingId: string): string {
  return `B${bookingId.replace(/-/g, "").slice(0, 14)}`;
}

/**
 * Deterministic numeric ref-user-id from a UUID.
 * Maps into a range (min..max inclusive) using a simple hash so the
 * same UUID always produces the same number and different ranges don't overlap.
 */
export function uuidToRefId(uuid: string, min: number, max: number): number {
  const hex = uuid.replace(/-/g, "").slice(0, 8);
  const n = parseInt(hex, 16) >>> 0; // unsigned 32-bit
  return min + (n % (max - min + 1));
}

/** Generate a random 6-digit enrollment PIN */
export function generatePin(): string {
  return String(Math.floor(100000 + Math.random() * 900000));
}

// ─── Contract member provisioning ──────────────────────────────────────────────

export interface ProvisionMemberAccessParams {
  memberId: string;
  memberName: string;
  memberPhone: string;
  locationId: string;
  contractEndDate: string | null; // ISO date, or null for no expiry
}

export interface ProvisionMemberAccessResult {
  provisionedDeviceCount: number;
  pin: string | null;
  skippedReason?: string;
}

/**
 * Provision a contract member onto every enabled entry-point COSEC device at
 * their contract's location, and SMS them the enrollment PIN.
 *
 * Shared by three call sites that all need the same idempotent behavior:
 * member creation (immediately, if the contract is already operational),
 * contract activation (backfill for members added while still in draft),
 * and manual re-provision from the admin UI. Safe to call more than once —
 * the device call and the `cosec_access_users` upsert key on
 * (device_id, cosec_user_id).
 */
export async function provisionMemberAccess(
  admin: SupabaseClient,
  params: ProvisionMemberAccessParams
): Promise<ProvisionMemberAccessResult> {
  const { data: devices } = await admin
    .from("cosec_devices")
    .select("id, device_ip, device_port, device_password")
    .eq("location_id", params.locationId)
    .eq("is_enabled", true)
    .eq("device_category", "entry_point"); // business_centre devices are booking-only

  if (!devices || devices.length === 0) {
    return { provisionedDeviceCount: 0, pin: null, skippedReason: "No enabled entry-point devices at this location" };
  }

  const cosecUserId = memberCosecId(params.memberId);
  const cosecRefId = uuidToRefId(params.memberId, 1, 49999);
  const pin = generatePin();
  const validUntil = params.contractEndDate ? new Date(params.contractEndDate) : undefined;
  const now = new Date().toISOString();

  const results = await Promise.allSettled(devices.map(async (dev) => {
    await provisionUser(
      { ip: dev.device_ip, port: dev.device_port, password: dev.device_password },
      {
        cosecUserId,
        cosecRefId,
        name: params.memberName.slice(0, 15),
        userActive: false, // stays inactive until biometric/card enrolled
        validUntil,
        pin,
        selfEnrollmentEnable: true,
      }
    );
    await admin.from("cosec_access_users").upsert({
      device_id:         dev.id,
      cosec_user_id:     cosecUserId,
      cosec_ref_id:      cosecRefId,
      user_type:         "member",
      entity_id:         params.memberId,
      enrollment_status: "provisioned",
      access_pin:        pin,
      valid_until:       params.contractEndDate,
      provisioned_at:    now,
      updated_at:        now,
    }, { onConflict: "device_id,cosec_user_id" });
  }));

  let provisionedDeviceCount = 0;
  results.forEach((r, i) => {
    if (r.status === "fulfilled") {
      provisionedDeviceCount++;
    } else {
      console.error(`[cosec] provisionMemberAccess failed on device ${devices[i].id}:`, r.reason);
    }
  });

  if (provisionedDeviceCount > 0 && params.memberPhone) {
    const { dltSms } = await import("@/lib/whatsapp");
    dltSms.otp(params.memberPhone, pin, params.memberId).catch(() => null);
  }

  return {
    provisionedDeviceCount,
    pin: provisionedDeviceCount > 0 ? pin : null,
    skippedReason: provisionedDeviceCount === 0 ? "Provisioning failed on all devices" : undefined,
  };
}

// ─── Manual contract linking ───────────────────────────────────────────────────

export interface CosecUserInfo {
  userId: string;   // e.g. "C1a2b3c4d5e6f7a8" or "M..."
  refUserId: number;
  name: string;
  isActive: boolean;
}

export interface CosecLiveUser {
  userId: string;       // alphanumeric user-id stored on device
  refUserId: number;    // numeric ref-user-id
  name: string;
  isActive: boolean;
  fingerCount: number;  // number of enrolled fingerprints (0 = no biometric)
  cardNumber: string;   // NFC card CSN, empty if none
  hasPin: boolean;      // true if user-pin field is non-empty on the device
}

/**
 * Fetch ALL enrolled users directly from the COSEC device.
 * Uses action=list with format=xml. Returns up to 5000 users.
 * Each <UserInfo> block in the response contains one user's data.
 */
export async function listAllUsersFromDevice(device: CosecDevice): Promise<CosecLiveUser[]> {
  // List response can be large — use a longer timeout than single-record calls
  const xml = await cosecGet(device, "users", {
    action: "list",
    format: "xml",
    "start-ref-user-id": 0,
    count: 5000,
  }, 45000);

  const blocks = xmlBlocks(xml, "UserInfo");
  const users: CosecLiveUser[] = [];

  for (const block of blocks) {
    const userId = xmlValue(block, "user-id");
    const refId  = parseInt(xmlValue(block, "ref-user-id") || "0", 10);
    if (!userId || !refId) continue;

    users.push({
      userId,
      refUserId: refId,
      name: xmlValue(block, "name"),
      isActive: xmlValue(block, "user-active") === "1",
      fingerCount: parseInt(xmlValue(block, "no-of-finger") || "0", 10),
      cardNumber: xmlValue(block, "card1") || "",
      hasPin: xmlValue(block, "user-pin") !== "",
    });
  }

  return users;
}

/**
 * Check whether a specific user has a PIN set on the device.
 * Uses action=get (individual lookup) because the list action does not
 * include user-pin in its response XML.
 */
export async function getUserPin(device: CosecDevice, refUserId: number): Promise<string> {
  try {
    const xml = await cosecGet(device, "users", {
      action: "get",
      "ref-user-id": refUserId,
      format: "xml",
    });
    return xmlValue(xml, "user-pin");
  } catch {
    return "";
  }
}

/** Query a COSEC device to get user info by numeric ref-user-id */
export async function getUserByRefId(device: CosecDevice, refUserId: number): Promise<CosecUserInfo | null> {
  try {
    const xml = await cosecGet(device, "users", {
      action: "get",
      "ref-user-id": refUserId,
      format: "xml",
    });
    const userId = xmlValue(xml, "user-id");
    if (!userId) return null;
    return {
      userId,
      refUserId,
      name: xmlValue(xml, "name"),
      isActive: xmlValue(xml, "user-active") === "1",
    };
  } catch {
    return null;
  }
}
