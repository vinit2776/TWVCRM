/**
 * Matrix COSEC Devices API client.
 *
 * All calls are server-side only — device credentials never reach the browser.
 * Protocol: plain HTTP, Basic Auth, GET (or POST for binary credential data).
 * Response format: XML (parsed) or text.
 *
 * API base: http://<device_ip>:<device_port>/device.cgi/<endpoint>?action=<action>&...
 */

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

// COSEC event IDs relevant to TWV
export const COSEC_EVENT = {
  ACCESS_GRANTED: 0,
  ACCESS_DENIED_INVALID_CREDENTIAL: 1,
  ACCESS_DENIED_INACTIVE: 2,
  ACCESS_DENIED_VALIDITY_EXPIRED: 3,
  ACCESS_DENIED_TIMEZONE: 6,
  ENROLLMENT_COMPLETE: 405,
} as const;

// detail-3 in access events encodes IN/OUT direction
// bit 4 = 0 → Entry, bit 4 = 1 → Exit (from appendix)
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

async function cosecGet(device: CosecDevice, endpoint: string, params: Record<string, string | number>): Promise<string> {
  const url = deviceUrl(device, endpoint, params);
  const res = await fetch(url, {
    method: "GET",
    headers: { Authorization: basicAuth(device.password) },
    // Short timeout — device is on LAN, should respond in <3s
    signal: AbortSignal.timeout(8000),
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
 * Initiate a card read on the device.
 * The device waits for the next card tap (up to ~15s) and returns the CSN.
 * This API call blocks until the card is tapped or times out.
 */
export async function readCardFromDevice(device: CosecDevice): Promise<ReadCardResult> {
  // Use longer timeout since we're waiting for physical card tap
  const url = deviceUrl(device, "card-read-write", {
    action: "read",
    "fp-index": 1,
    format: "xml",
  });
  const res = await fetch(url, {
    method: "GET",
    headers: { Authorization: basicAuth(device.password) },
    signal: AbortSignal.timeout(20000), // 20s for card tap
  });
  if (!res.ok) throw new Error(`COSEC HTTP ${res.status} reading card`);
  const xml = await res.text();

  const code = xmlValue(xml, "response-code");
  if (code && code !== "0") {
    throw new Error(`COSEC card read error ${code}. Is a card present on the reader?`);
  }

  const cardNo = xmlValue(xml, "card-no");
  const cardType = xmlValue(xml, "Card-type");
  if (!cardNo || cardNo === "0") throw new Error("No card detected. Please tap the card on the reader.");

  return { cardNumber: cardNo, cardType };
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

export function employeeCosecId(employeeId: string): string {
  return `E${employeeId.replace(/-/g, "").slice(0, 14)}`;
}

export function bookingCosecId(bookingId: string): string {
  return `B${bookingId.replace(/-/g, "").slice(0, 14)}`;
}
