import { describe, expect, it } from "vitest";
import { CONSOLE_HOURLY_RETENTION_DAYS, captureWindowStart, parseClientRows, parseSiteRows } from "@/lib/wifi-ledger-capture";

const LOC = "loc-1";
const H = 3_600_000;
const T0 = Date.UTC(2026, 9, 19, 8, 0, 0); // 2026-10-19 08:00 UTC

describe("parseClientRows", () => {
  it("normalises the MAC, keeps bytes and drops rows with no traffic", () => {
    const rows = parseClientRows(LOC, [
      { user: "AA:BB:CC:DD:EE:01", time: T0, rx_bytes: 1000, tx_bytes: 500 },
      { user: "aa:bb:cc:dd:ee:02", time: T0, rx_bytes: 0, tx_bytes: 0 },
    ]);
    expect(rows).toEqual([{ location_id: LOC, mac: "aa:bb:cc:dd:ee:01", hour_start: new Date(T0).toISOString(), rx_bytes: 1000, tx_bytes: 500 }]);
  });

  it("skips malformed rows instead of failing the batch", () => {
    const rows = parseClientRows(LOC, [
      null, { user: "not-a-mac", time: T0, rx_bytes: 5 }, { user: "aa:bb:cc:dd:ee:01" }, { user: "aa:bb:cc:dd:ee:01", time: "x", rx_bytes: 5 },
      { user: "aa:bb:cc:dd:ee:03", time: T0, rx_bytes: 7, tx_bytes: null },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].tx_bytes).toBe(0);
  });

  it("merges a device reported twice for the same bucket into one row", () => {
    const rows = parseClientRows(LOC, [
      { user: "aa:bb:cc:dd:ee:01", time: T0, rx_bytes: 100, tx_bytes: 10 },
      { user: "AA:BB:CC:DD:EE:01", time: T0, rx_bytes: 50, tx_bytes: 5 },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].rx_bytes).toBe(150);
    expect(rows[0].tx_bytes).toBe(15);
  });

  it("keeps the bucket's real start time: the console's hours begin at :30 UTC (IST hours)", () => {
    const real = Date.UTC(2026, 9, 19, 5, 30, 0); // 11:00 IST
    const rows = parseClientRows(LOC, [{ user: "aa:bb:cc:dd:ee:01", time: real, rx_bytes: 9, tx_bytes: 1 }]);
    expect(rows[0].hour_start).toBe("2026-10-19T05:30:00.000Z");
    expect(parseSiteRows(LOC, [{ time: real, wlan_bytes: 9, num_sta: 1 }])[0].hour_start).toBe("2026-10-19T05:30:00.000Z");
  });

  it("returns nothing for a response that is not a list", () => {
    expect(parseClientRows(LOC, undefined)).toEqual([]);
    expect(parseClientRows(LOC, { error: "x" })).toEqual([]);
  });
});

describe("parseSiteRows", () => {
  it("keeps an hour with no traffic, so a quiet hour differs from a missing one", () => {
    const rows = parseSiteRows(LOC, [{ time: T0, wlan_bytes: 0, num_sta: 4 }, { time: T0 + H, wlan_bytes: 999, num_sta: null }]);
    expect(rows).toEqual([
      { location_id: LOC, hour_start: new Date(T0).toISOString(), wlan_bytes: 0, num_sta: 4 },
      { location_id: LOC, hour_start: new Date(T0 + H).toISOString(), wlan_bytes: 999, num_sta: null },
    ]);
  });

  it("drops rows without a time", () => {
    expect(parseSiteRows(LOC, [{ wlan_bytes: 5 }])).toEqual([]);
  });
});

describe("captureWindowStart", () => {
  const now = new Date(T0 + 12 * H);

  it("starts at the console's retention limit when nothing is stored", () => {
    expect(captureWindowStart(null, now)).toBe(now.getTime() - CONSOLE_HOURLY_RETENTION_DAYS * 24 * H);
  });

  it("resumes a little before the last stored hour to complete the hour that was in progress", () => {
    expect(captureWindowStart(new Date(T0).toISOString(), now)).toBe(T0 - 3 * H);
  });

  it("never asks for more than the console still holds after a long outage", () => {
    const old = new Date(T0 - 30 * 24 * H).toISOString();
    expect(captureWindowStart(old, now)).toBe(now.getTime() - CONSOLE_HOURLY_RETENTION_DAYS * 24 * H);
  });
});
