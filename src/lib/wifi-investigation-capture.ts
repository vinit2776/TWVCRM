import { isIP } from "node:net";
import type { SupabaseClient } from "@supabase/supabase-js";
import { siteConfigFromLocation, unifiRequest, type SiteConfig } from "@/lib/unifi";
import { getCachedSetting } from "@/lib/app-settings-cache";
import {
  resolveDevices,
  type AdhocLink,
  type GuestRecord,
  type LabelRow,
  type WifiDevice,
} from "@/lib/customer-value/wifi-devices";
import { unifiManagedLocations } from "@/lib/wifi-ledger-capture";

// Scheduled capture of the records needed to say who was on the network at a given
// time (migration 00744, docs/plans/wifi-device-history-and-lookup.md): Wi-Fi
// sessions, which person each device belongs to, and the center's public IP.
//
// Off until app_settings.wifi_investigation_enabled is 'true'. Read-only against
// UniFi; writes only the investigation tables; messages nobody. Idempotent: each
// run re-reads a little before the newest stored session, so a missed run is
// caught up and a session still open is completed by a later run.

export const INVESTIGATION_ENABLED_KEY = "wifi_investigation_enabled";
/** Records older than this are deleted by the daily purge (12 months). */
export const INVESTIGATION_RETENTION_DAYS = 365;
/** First run for a center: how far back to ask the console for sessions. */
const FIRST_RUN_LOOKBACK_DAYS = 30;
/** Re-read this long before the newest stored session so open sessions are completed. */
const OVERLAP_HOURS = 6;
/** Sessions are requested one day at a time so no single response is huge. */
const WINDOW_MS = 24 * 3_600_000;
/** A run never asks for more than this many day-windows, so a long outage is caught up over a few runs. */
const MAX_WINDOWS_PER_RUN = 31;
const WRITE_CHUNK = 500;
const GUEST_LOOKBACK_DAYS = 7;

export interface SessionRow {
  location_id: string;
  mac: string;
  assoc_time: string;
  disassoc_time: string | null;
  duration_seconds: number | null;
  ip: string | null;
  hostname: string | null;
  ap_mac: string | null;
  essid: string | null;
  is_guest: boolean | null;
  rx_bytes: number;
  tx_bytes: number;
}

const MAC_RE = /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/;
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);
const bytes = (v: unknown): number => (isNum(v) && v > 0 ? Math.round(v) : 0);

function iso(seconds: number): string | null {
  const d = new Date(seconds * 1000);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** UniFi session records to rows. Malformed records are skipped, never failing the batch; the same MAC and start time collapse to one row. */
export function parseSessionRows(locationId: string, raw: unknown): SessionRow[] {
  if (!Array.isArray(raw)) return [];
  const byKey = new Map<string, SessionRow>();
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const rec = r as Record<string, unknown>;
    const mac = typeof rec.mac === "string" ? rec.mac.toLowerCase().replace(/-/g, ":") : "";
    if (!MAC_RE.test(mac) || !isNum(rec.assoc_time)) continue;
    const assoc = iso(rec.assoc_time);
    if (!assoc) continue;
    const duration = isNum(rec.duration) && rec.duration >= 0 ? Math.round(rec.duration) : null;
    const disassocSeconds = isNum(rec.disassoc_time) && rec.disassoc_time >= rec.assoc_time ? rec.disassoc_time : duration !== null ? rec.assoc_time + duration : null;
    const ip = str(rec.ip);
    byKey.set(`${mac}|${assoc}`, {
      location_id: locationId,
      mac,
      assoc_time: assoc,
      disassoc_time: disassocSeconds !== null ? iso(disassocSeconds) : null,
      duration_seconds: duration,
      ip: ip && isIP(ip) ? ip : null,
      hostname: str(rec.hostname),
      ap_mac: str(rec.ap_mac),
      essid: str(rec.essid),
      is_guest: typeof rec.is_guest === "boolean" ? rec.is_guest : null,
      rx_bytes: bytes(rec.rx_bytes),
      tx_bytes: bytes(rec.tx_bytes),
    });
  }
  return [...byKey.values()];
}

function ipv4Octets(ip: string): number[] | null {
  const p = ip.split(".").map(Number);
  return p.length === 4 && p.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) ? p : null;
}

/** True for an address another network could see: not private, loopback, link-local or carrier-shared (100.64.0.0/10). */
export function isPublicIp(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const o = ipv4Octets(ip);
    if (!o) return false;
    const [a, b] = o;
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    return true;
  }
  if (v === 6) {
    const l = ip.toLowerCase();
    return !(l === "::1" || l === "::" || l.startsWith("fe80:") || l.startsWith("fc") || l.startsWith("fd"));
  }
  return false;
}

/**
 * The center's public IP from `/stat/health`: the wan subsystem's `wan_ip`. Null when the
 * console doesn't report one or it is not a public address (behind a carrier's shared
 * address, a lookup by public IP could not be trusted, so nothing is recorded).
 */
export function parsePublicIp(health: unknown): string | null {
  if (!Array.isArray(health)) return null;
  const wan = health.find((s) => s && typeof s === "object" && (s as Record<string, unknown>).subsystem === "wan") as Record<string, unknown> | undefined;
  const ip = str(wan?.wan_ip);
  return ip && isPublicIp(ip) ? ip : null;
}

export interface AssignmentInput {
  contract_id: string;
  contract_member_id: string | null;
  seat_number: number | null;
  voucher_issuance_id: string | null;
  source: "voucher_guest" | "adhoc_voucher" | "manual_label";
}

export interface IssuanceKeyRow {
  id: string;
  contract_id: string;
  seat_number: number;
  contract_member_id: string | null;
}

/** What each resolved device should be assigned to. Only confirmed matches (seat voucher, ad-hoc voucher, linked label); never a guess. */
export function buildAssignments(devices: WifiDevice[], issuances: IssuanceKeyRow[]): Map<string, AssignmentInput> {
  const bySeat = new Map(issuances.map((i) => [`${i.contract_id}:${i.seat_number}`, i]));
  const out = new Map<string, AssignmentInput>();
  for (const d of devices) {
    const issuance = d.seat !== null ? bySeat.get(`${d.contractId}:${d.seat}`) : undefined;
    const source = d.how.includes("seat") ? "voucher_guest" : d.how.includes("adhoc") ? "adhoc_voucher" : "manual_label";
    out.set(d.mac, {
      contract_id: d.contractId,
      contract_member_id: issuance?.contract_member_id ?? null,
      seat_number: d.seat,
      voucher_issuance_id: issuance?.id ?? null,
      source,
    });
  }
  return out;
}

/** True when the open assignment already says what the device resolves to now. */
export function sameAssignment(open: { contract_id: string | null; contract_member_id: string | null; seat_number: number | null; voucher_issuance_id: string | null }, next: AssignmentInput): boolean {
  return open.contract_id === next.contract_id
    && open.contract_member_id === next.contract_member_id
    && open.seat_number === next.seat_number
    && open.voucher_issuance_id === next.voucher_issuance_id;
}

/** Day windows (unix seconds) from `startMs` to `endMs`, oldest first, capped so one run stays bounded. */
export function sessionWindows(startMs: number, endMs: number): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = [];
  for (let s = startMs; s < endMs && out.length < MAX_WINDOWS_PER_RUN; s += WINDOW_MS) {
    out.push({ start: Math.floor(s / 1000), end: Math.floor(Math.min(s + WINDOW_MS, endMs) / 1000) });
  }
  return out;
}

export function sessionStartMs(newestAssoc: string | null, now: Date): number {
  const floor = now.getTime() - FIRST_RUN_LOOKBACK_DAYS * 86_400_000;
  if (!newestAssoc) return floor;
  return Math.max(floor, new Date(newestAssoc).getTime() - OVERLAP_HOURS * 3_600_000);
}

async function upsertChunks<T extends object>(supabase: SupabaseClient, table: string, rows: T[], onConflict: string): Promise<void> {
  for (let i = 0; i < rows.length; i += WRITE_CHUNK) {
    const { error } = await supabase.from(table).upsert(rows.slice(i, i + WRITE_CHUNK), { onConflict });
    if (error) throw new Error(`${table} write failed: ${error.message}`);
  }
}

async function captureSessions(supabase: SupabaseClient, locationId: string, cfg: SiteConfig, now: Date): Promise<number> {
  const { data: last, error } = await supabase
    .from("wifi_session_log")
    .select("assoc_time")
    .eq("location_id", locationId)
    .order("assoc_time", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`session log read failed: ${error.message}`);

  let stored = 0;
  for (const w of sessionWindows(sessionStartMs((last?.assoc_time as string | undefined) ?? null, now), now.getTime())) {
    const raw = await unifiRequest<unknown>(`/stat/session?type=all&start=${w.start}&end=${w.end}`, {}, cfg);
    const rows = parseSessionRows(locationId, raw);
    await upsertChunks(supabase, "wifi_session_log", rows, "location_id,mac,assoc_time");
    stored += rows.length;
  }
  return stored;
}

async function loadChunked<T>(ids: string[], load: (batch: string[]) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await load(ids.slice(i, i + 200));
    if (error) throw new Error(`read failed: ${error.message}`);
    out.push(...(data ?? []));
  }
  return out;
}

async function captureAssignments(supabase: SupabaseClient, locationId: string, cfg: SiteConfig, now: Date): Promise<number> {
  const { data: contractRows, error: cErr } = await supabase.from("contracts").select("id, contract_number").eq("location_id", locationId);
  if (cErr) throw new Error(`read failed: ${cErr.message}`);
  const contracts = (contractRows ?? []) as Array<{ id: string; contract_number: string }>;
  if (contracts.length === 0) return 0;
  const contractIds = contracts.map((c) => c.id);

  const guestStart = Math.floor(now.getTime() / 1000) - GUEST_LOOKBACK_DAYS * 86_400;
  const [issuanceRows, adhocLinks, labelRes, guests, openRes] = await Promise.all([
    loadChunked<IssuanceKeyRow & { revoked_at: string | null }>(contractIds, (b) =>
      supabase.from("voucher_issuances").select("id, contract_id, seat_number, revoked_at, contract_member_id").in("contract_id", b)),
    loadChunked<AdhocLink>(contractIds, (b) => supabase.from("unifi_adhoc_voucher_links").select("note, contract_id").eq("location_id", locationId).in("contract_id", b)),
    supabase.from("unifi_device_labels").select("mac, label, contract_id").eq("location_id", locationId),
    unifiRequest<GuestRecord[]>(`/stat/guest?_start=${guestStart}`, {}, cfg),
    supabase.from("wifi_device_assignments").select("mac, contract_id, contract_member_id, seat_number, voucher_issuance_id").eq("location_id", locationId).is("valid_to", null),
  ]);
  if (labelRes.error) throw new Error(`read failed: ${labelRes.error.message}`);
  if (openRes.error) throw new Error(`read failed: ${openRes.error.message}`);

  const devices = resolveDevices({
    contracts,
    guests: Array.isArray(guests) ? guests : [],
    issuances: issuanceRows.map((i) => ({ contract_id: i.contract_id, seat_number: i.seat_number, revoked_at: i.revoked_at, member_name: null })),
    adhocLinks,
    labels: (labelRes.data ?? []) as LabelRow[],
  });
  const wanted = buildAssignments(devices, issuanceRows);

  const open = new Map((openRes.data ?? []).map((r) => [r.mac as string, r]));
  let changed = 0;
  // A device the console no longer lists is left as it was: absence from a 7-day guest
  // list says nothing about who owns it, so only a different resolution changes a row.
  for (const [mac, next] of wanted) {
    const cur = open.get(mac);
    if (cur && sameAssignment(cur, next)) continue;
    const { error } = await supabase.rpc("wifi_reassign_device", {
      p_location_id: locationId,
      p_mac: mac,
      p_contract_id: next.contract_id,
      p_contract_member_id: next.contract_member_id,
      p_seat_number: next.seat_number,
      p_voucher_issuance_id: next.voucher_issuance_id,
      p_source: next.source,
      p_valid_from: now.toISOString(),
    });
    if (error) throw new Error(`wifi_reassign_device write failed: ${error.message}`);
    changed++;
  }
  return changed;
}

async function capturePublicIp(supabase: SupabaseClient, locationId: string, cfg: SiteConfig, now: Date): Promise<boolean> {
  const ip = parsePublicIp(await unifiRequest<unknown>("/stat/health", {}, cfg));
  if (!ip) return false;
  const { error } = await supabase.rpc("wifi_record_public_ip", { p_location_id: locationId, p_ip: ip, p_seen_at: now.toISOString() });
  if (error) throw new Error(`wifi_record_public_ip write failed: ${error.message}`);
  return true;
}

export interface InvestigationLocationSummary {
  location_id: string;
  sessions: number | null;
  assignments_changed: number | null;
  public_ip_recorded: boolean | null;
  /** Plain classification only: never the console's own text. */
  failed_parts: Array<"sessions" | "assignments" | "public_ip">;
}

/** Each part runs on its own, so a console that refuses one call still lets the others be stored. */
export async function captureLocationInvestigation(
  supabase: SupabaseClient,
  { locationId, cfg, now = new Date() }: { locationId: string; cfg: SiteConfig; now?: Date }
): Promise<InvestigationLocationSummary> {
  const summary: InvestigationLocationSummary = { location_id: locationId, sessions: null, assignments_changed: null, public_ip_recorded: null, failed_parts: [] };
  const run = async <T>(part: InvestigationLocationSummary["failed_parts"][number], fn: () => Promise<T>): Promise<T | null> => {
    try {
      return await fn();
    } catch (err) {
      console.error(`[wifi-investigation-capture] ${part} failed:`, err instanceof Error ? err.message : err);
      summary.failed_parts.push(part);
      return null;
    }
  };
  summary.sessions = await run("sessions", () => captureSessions(supabase, locationId, cfg, now));
  summary.assignments_changed = await run("assignments", () => captureAssignments(supabase, locationId, cfg, now));
  summary.public_ip_recorded = await run("public_ip", () => capturePublicIp(supabase, locationId, cfg, now));
  return summary;
}

export async function captureAllInvestigation(
  supabase: SupabaseClient,
  { now = new Date(), budgetMs = 50_000 }: { now?: Date; budgetMs?: number } = {}
): Promise<{ enabled: boolean; locations: InvestigationLocationSummary[]; skipped: number }> {
  if ((await getCachedSetting(supabase, INVESTIGATION_ENABLED_KEY)) !== "true") return { enabled: false, locations: [], skipped: 0 };

  const targets = await unifiManagedLocations(supabase);
  const started = Date.now();
  const locations: InvestigationLocationSummary[] = [];
  let skipped = 0;
  for (const loc of targets) {
    if (Date.now() - started > budgetMs) { skipped++; continue; }
    locations.push(await captureLocationInvestigation(supabase, { locationId: loc.id, cfg: siteConfigFromLocation(loc), now }));
  }
  return { enabled: true, locations, skipped };
}

export async function purgeInvestigationRecords(supabase: SupabaseClient, now = new Date()): Promise<{ sessions: number; assignments: number; public_ips: number }> {
  const before = new Date(now.getTime() - INVESTIGATION_RETENTION_DAYS * 86_400_000).toISOString();
  const { data, error } = await supabase.rpc("wifi_investigation_purge", { p_before: before });
  if (error) throw new Error(`purge failed: ${error.message}`);
  const row = (Array.isArray(data) ? data[0] : data) as { sessions: number | string; assignments: number | string; public_ips: number | string } | null;
  return { sessions: Number(row?.sessions ?? 0), assignments: Number(row?.assignments ?? 0), public_ips: Number(row?.public_ips ?? 0) };
}
