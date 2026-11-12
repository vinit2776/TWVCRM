import { describe, expect, it } from "vitest";
import { PROFILE_RULES, buildHeatmap, dailySeries, istDay, istWeekHour, profileTags, summariseUsage, type DayRow, type HourRow } from "@/lib/customer-value/wifi-usage";

// 2026-10-19 is a Monday. The console's day starts at IST midnight = 18:30 UTC the day before.
const NOW = new Date("2026-10-19T09:00:00Z");
const dayStart = (ymd: string) => new Date(Date.parse(`${ymd}T00:00:00Z`) - 5.5 * 3_600_000).toISOString();
const GB = 1e9;
const day = (mac: string, ymd: string, rx: number, tx: number): DayRow => ({ mac, day_start: dayStart(ymd), rx_bytes: rx, tx_bytes: tx });

describe("IST helpers", () => {
  it("maps the console's day bucket to the IST day it belongs to", () => {
    expect(istDay("2026-10-18T18:30:00.000Z")).toBe("2026-10-19");
  });

  it("maps an hour bucket to IST weekday (Monday = 0) and hour", () => {
    expect(istWeekHour("2026-10-19T05:30:00.000Z")).toEqual({ weekday: 0, hour: 11 });
    expect(istWeekHour("2026-10-24T18:30:00.000Z")).toEqual({ weekday: 6, hour: 0 }); // Sunday 00:00 IST
  });
});

describe("dailySeries", () => {
  it("has one point per day ending today and marks days the ledger knows nothing about as unknown", () => {
    const s = dailySeries([day("a", "2026-10-18", 1, 2)], [dayStart("2026-10-17")], NOW);
    expect(s).toHaveLength(95);
    expect(s.at(-1)!.day).toBe("2026-10-19");
    expect(s.find((p) => p.day === "2026-10-18")).toEqual({ day: "2026-10-18", bytes: 3, known: true });
    expect(s.find((p) => p.day === "2026-10-17")).toEqual({ day: "2026-10-17", bytes: 0, known: true });
    expect(s.find((p) => p.day === "2026-10-16")).toEqual({ day: "2026-10-16", bytes: 0, known: false });
  });
});

describe("summariseUsage", () => {
  const rows = [day("a", "2026-10-18", GB, 3 * GB), day("a", "2026-10-17", 0, GB), day("b", "2026-10-18", GB, 0), day("a", "2026-08-01", 50 * GB, 50 * GB)];

  it("sums the last 30 days, split by direction, and ignores older days", () => {
    const s = summariseUsage(rows, 20 * GB, 40, NOW);
    expect(s.bytes).toBe(6 * GB);
    expect(s.download).toBe(4 * GB);
    expect(s.upload).toBe(2 * GB);
    expect(s.activeDays).toBe(2);
    expect(s.activeDevices).toBe(2);
    expect(s.centerShare).toBeCloseTo(0.3);
    expect(s.perDevice[0]).toMatchObject({ mac: "a", bytes: 5 * GB, activeDays: 2 });
  });

  it("has no share when the center total is unknown", () => {
    expect(summariseUsage(rows, null, 40, NOW).centerShare).toBeNull();
    expect(summariseUsage(rows, 0, 40, NOW).centerShare).toBeNull();
  });
});

describe("buildHeatmap", () => {
  const hour = (iso: string, rx: number, tx: number): HourRow => ({ mac: "a", hour_start: iso, rx_bytes: rx, tx_bytes: tx });

  it("puts bytes in the IST weekday and hour and finds the peak and after-hours share", () => {
    const h = buildHeatmap([hour("2026-10-19T05:30:00.000Z", 10, 10), hour("2026-10-19T17:30:00.000Z", 5, 5), hour("2026-10-24T18:30:00.000Z", 10, 0)], 60);
    expect(h.cells[0][11]).toBe(20);
    expect(h.cells[0][23]).toBe(10); // 23:00 IST Monday
    expect(h.cells[6][0]).toBe(10);
    expect(h.peak).toEqual({ weekday: 0, hour: 11, bytes: 20 });
    expect(h.afterHoursShare).toBeCloseTo(20 / 40);
    expect(h.hoursCovered).toBe(60);
  });

  it("has no share or peak with no usage", () => {
    const h = buildHeatmap([], 0);
    expect(h.afterHoursShare).toBeNull();
    expect(h.peak).toBeNull();
  });
});

describe("profileTags", () => {
  const heat = (afterHoursShare: number | null, hoursCovered = 100) => ({ cells: [], max: 0, hoursCovered, afterHoursShare, peak: null });
  const sum = (download: number, upload: number, days: number, devices: number) => ({
    knownDays: 30, bytes: download + upload, download, upload, activeDays: days, activeDevices: devices, centerShare: null, perDevice: [],
  });

  it("tags nothing without usage", () => {
    expect(profileTags(sum(0, 0, 0, 0), heat(null))).toEqual([]);
  });

  it("tags a heavy downloader, a video-call heavy user and a night user from the rules", () => {
    expect(profileTags(sum(900 * GB, 50 * GB, 30, 5), heat(0.5))).toEqual(["Heavy downloader", "Night user"]);
    expect(profileTags(sum(300 * GB, 300 * GB, 30, 5), heat(0.05))).toEqual(["Video-call heavy", "Daytime user"]);
  });

  it("does not judge the hourly pattern on too little history", () => {
    expect(profileTags(sum(20 * GB, 5 * GB, 20, 2), heat(0.9, 10))).not.toContain("Night user");
  });

  it("calls a very quiet customer light", () => {
    const r = PROFILE_RULES.lightGbPerDeviceDay;
    expect(profileTags(sum((r / 4) * GB * 30, 0, 30, 1), heat(0.2))).toContain("Light user");
  });
});
