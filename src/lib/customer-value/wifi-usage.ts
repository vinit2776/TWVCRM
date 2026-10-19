/**
 * Customer Value — shaping one customer's Wi-Fi usage from our own ledger
 * (wifi_client_daily / wifi_client_hourly; migrations 00625 and 00627).
 *
 * Pure. Everything is in IST: the console's day buckets begin at IST midnight and
 * its hour buckets at the IST hour, so a bucket's start time converts straight to
 * the local day and hour. A day or hour the ledger holds no site row for is a gap
 * (capture was down or the console had nothing), never zero usage.
 *
 * Direction: the console reports from the access point's side, so `tx_bytes` is
 * what was sent to the device (its download) and `rx_bytes` what the device sent
 * (its upload). That is the UniFi convention, not something this code can verify
 * from the data.
 */

export interface DayRow { mac: string; day_start: string; rx_bytes: number; tx_bytes: number }
export interface HourRow { mac: string; hour_start: string; rx_bytes: number; tx_bytes: number }

const IST_MS = 5.5 * 3_600_000;
const DAY_MS = 86_400_000;

export const WINDOW_DAYS = 30;
export const SERIES_DAYS = 95;
/** First-cut rules for the usage profile; tunable once there is real data to calibrate against. */
export const PROFILE_RULES = {
  /** Local hours outside [from, to) and all of Sunday count as after hours. */
  afterHours: { from: 7, to: 21 },
  nightUserShare: 0.3,
  daytimeUserShare: 0.1,
  videoCallUploadShare: 0.4,
  heavyDownloaderShare: 0.8,
  heavyGbPerDeviceDay: 5,
  lightGbPerDeviceDay: 0.5,
} as const;

/** IST calendar day (YYYY-MM-DD) of an instant. */
export function istDay(iso: string | number): string {
  const ms = typeof iso === "number" ? iso : Date.parse(iso);
  return new Date(ms + IST_MS).toISOString().slice(0, 10);
}

/** IST weekday (0 = Monday) and hour (0 to 23) of an instant. */
export function istWeekHour(iso: string): { weekday: number; hour: number } {
  const d = new Date(Date.parse(iso) + IST_MS);
  return { weekday: (d.getUTCDay() + 6) % 7, hour: d.getUTCHours() };
}

const total = (r: { rx_bytes: number; tx_bytes: number }) => r.rx_bytes + r.tx_bytes;

export interface DaySeriesPoint {
  day: string;
  bytes: number;
  /** False when the ledger holds no site row for the day, so the figure is unknown rather than zero. */
  known: boolean;
}

/** One point per IST day for the last `SERIES_DAYS` days ending today, oldest first. */
export function dailySeries(mine: DayRow[], siteDays: string[], now: Date): DaySeriesPoint[] {
  const known = new Set(siteDays.map(istDay));
  const bytesByDay = new Map<string, number>();
  for (const r of mine) {
    const d = istDay(r.day_start);
    bytesByDay.set(d, (bytesByDay.get(d) ?? 0) + total(r));
  }
  const today = istDay(now.getTime());
  const out: DaySeriesPoint[] = [];
  for (let i = SERIES_DAYS - 1; i >= 0; i--) {
    const day = istDay(Date.parse(`${today}T12:00:00Z`) - i * DAY_MS - IST_MS + IST_MS);
    out.push({ day, bytes: bytesByDay.get(day) ?? 0, known: known.has(day) || bytesByDay.has(day) });
  }
  return out;
}

export interface DeviceUsage {
  mac: string;
  bytes: number;
  download: number;
  upload: number;
  activeDays: number;
}

export interface UsageSummary {
  /** Days of the window the ledger knows about at all. */
  knownDays: number;
  bytes: number;
  download: number;
  upload: number;
  /** Days with any usage from this customer's devices. */
  activeDays: number;
  /** Devices with any usage in the window. */
  activeDevices: number;
  /** This customer's bytes over every device's bytes at the center in the window; null when the center total is unknown. */
  centerShare: number | null;
  perDevice: DeviceUsage[];
}

/** First IST day of the headline window (the last `WINDOW_DAYS` days, today included). */
export function windowCutoffDay(now: Date): string {
  return istDay(now.getTime() - (WINDOW_DAYS - 1) * DAY_MS);
}

export function summariseUsage(mine: DayRow[], centerBytes: number | null, knownDays: number, now: Date): UsageSummary {
  const cutoff = windowCutoffDay(now);
  const inWindow = mine.filter((r) => istDay(r.day_start) >= cutoff);
  const per = new Map<string, { bytes: number; download: number; upload: number; days: Set<string> }>();
  const days = new Set<string>();
  let download = 0;
  let upload = 0;
  for (const r of inWindow) {
    const d = istDay(r.day_start);
    const p = per.get(r.mac) ?? { bytes: 0, download: 0, upload: 0, days: new Set<string>() };
    p.bytes += total(r);
    p.download += r.tx_bytes;
    p.upload += r.rx_bytes;
    p.days.add(d);
    per.set(r.mac, p);
    if (total(r) > 0) days.add(d);
    download += r.tx_bytes;
    upload += r.rx_bytes;
  }
  const bytes = download + upload;
  return {
    knownDays,
    bytes,
    download,
    upload,
    activeDays: days.size,
    activeDevices: per.size,
    centerShare: centerBytes !== null && centerBytes > 0 ? bytes / centerBytes : null,
    perDevice: [...per.entries()]
      .map(([mac, p]) => ({ mac, bytes: p.bytes, download: p.download, upload: p.upload, activeDays: p.days.size }))
      .sort((a, b) => b.bytes - a.bytes),
  };
}

export interface Heatmap {
  /** bytes[weekday][hour], Monday first. */
  cells: number[][];
  max: number;
  /** Distinct hour buckets the ledger holds for the center, so the page can say how much history it rests on. */
  hoursCovered: number;
  /** Share of bytes outside working hours (see PROFILE_RULES.afterHours), or null with no usage. */
  afterHoursShare: number | null;
  peak: { weekday: number; hour: number; bytes: number } | null;
}

export function buildHeatmap(rows: HourRow[], hoursCovered: number): Heatmap {
  const cells = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
  let all = 0;
  let after = 0;
  for (const r of rows) {
    const { weekday, hour } = istWeekHour(r.hour_start);
    const b = total(r);
    cells[weekday][hour] += b;
    all += b;
    if (weekday === 6 || hour < PROFILE_RULES.afterHours.from || hour >= PROFILE_RULES.afterHours.to) after += b;
  }
  let peak: Heatmap["peak"] = null;
  let max = 0;
  cells.forEach((row, weekday) => row.forEach((bytes, hour) => {
    if (bytes > max) { max = bytes; peak = { weekday, hour, bytes }; }
  }));
  return { cells, max, hoursCovered, afterHoursShare: all > 0 ? after / all : null, peak };
}

export type ProfileTag = "Heavy downloader" | "Video-call heavy" | "Night user" | "Daytime user" | "Light user";

/** Rule-based tags from the window's volume and the hourly pattern; a tag is only given with enough to go on. */
export function profileTags(summary: UsageSummary, heatmap: Heatmap): ProfileTag[] {
  const R = PROFILE_RULES;
  if (summary.bytes <= 0 || summary.activeDevices === 0) return [];
  const tags: ProfileTag[] = [];
  const gbPerDeviceDay = summary.bytes / 1e9 / Math.max(1, summary.activeDays) / summary.activeDevices;
  const uploadShare = summary.upload / summary.bytes;
  const downloadShare = summary.download / summary.bytes;
  if (downloadShare >= R.heavyDownloaderShare && gbPerDeviceDay >= R.heavyGbPerDeviceDay) tags.push("Heavy downloader");
  if (uploadShare >= R.videoCallUploadShare) tags.push("Video-call heavy");
  if (heatmap.afterHoursShare !== null && heatmap.hoursCovered >= 48) {
    if (heatmap.afterHoursShare >= R.nightUserShare) tags.push("Night user");
    else if (heatmap.afterHoursShare <= R.daytimeUserShare) tags.push("Daytime user");
  }
  if (gbPerDeviceDay < R.lightGbPerDeviceDay) tags.push("Light user");
  return tags;
}
