import { describe, expect, it } from "vitest";
import {
  buildAssignments,
  isPublicIp,
  parsePublicIp,
  parseSessionRows,
  sameAssignment,
  sessionStartMs,
  sessionWindows,
} from "@/lib/wifi-investigation-capture";
import type { WifiDevice } from "@/lib/customer-value/wifi-devices";

const LOC = "loc-1";
const T0 = 1_760_000_000; // unix seconds

describe("parseSessionRows", () => {
  it("normalises the MAC and works the end time out of the duration", () => {
    const rows = parseSessionRows(LOC, [
      { mac: "AA-BB-CC-DD-EE-01", assoc_time: T0, duration: 3600, ip: "10.20.3.47", ap_mac: "ap1", essid: "Guest", is_guest: true, rx_bytes: 100, tx_bytes: 200, hostname: "ThinkPad" },
    ]);
    expect(rows).toEqual([{
      location_id: LOC, mac: "aa:bb:cc:dd:ee:01", assoc_time: new Date(T0 * 1000).toISOString(),
      disassoc_time: new Date((T0 + 3600) * 1000).toISOString(), duration_seconds: 3600, ip: "10.20.3.47",
      hostname: "ThinkPad", ap_mac: "ap1", essid: "Guest", is_guest: true, rx_bytes: 100, tx_bytes: 200,
    }]);
  });

  it("prefers the console's own end time and leaves an open session open", () => {
    const rows = parseSessionRows(LOC, [
      { mac: "aa:bb:cc:dd:ee:01", assoc_time: T0, disassoc_time: T0 + 60, duration: 999 },
      { mac: "aa:bb:cc:dd:ee:02", assoc_time: T0 },
    ]);
    expect(rows[0].disassoc_time).toBe(new Date((T0 + 60) * 1000).toISOString());
    expect(rows[1].disassoc_time).toBeNull();
    expect(rows[1].duration_seconds).toBeNull();
  });

  it("keeps a missing or invalid IP as null instead of dropping the session", () => {
    const rows = parseSessionRows(LOC, [
      { mac: "aa:bb:cc:dd:ee:01", assoc_time: T0 },
      { mac: "aa:bb:cc:dd:ee:02", assoc_time: T0, ip: "not an ip" },
    ]);
    expect(rows.map((r) => r.ip)).toEqual([null, null]);
  });

  it("skips malformed records and collapses a repeated MAC and start", () => {
    const rows = parseSessionRows(LOC, [
      null, "x", { mac: "bad", assoc_time: T0 }, { mac: "aa:bb:cc:dd:ee:01" }, { mac: "aa:bb:cc:dd:ee:01", assoc_time: "x" },
      { mac: "aa:bb:cc:dd:ee:03", assoc_time: T0, rx_bytes: 1 },
      { mac: "AA:BB:CC:DD:EE:03", assoc_time: T0, rx_bytes: 9 },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].rx_bytes).toBe(9);
  });

  it("returns nothing for a response that is not a list", () => {
    expect(parseSessionRows(LOC, { data: [] })).toEqual([]);
    expect(parseSessionRows(LOC, null)).toEqual([]);
  });
});

describe("public IP", () => {
  it("accepts public addresses and rejects private, shared and special ones", () => {
    expect(isPublicIp("203.0.113.25")).toBe(true);
    for (const ip of ["10.1.2.3", "192.168.1.1", "172.16.0.1", "172.31.255.1", "100.64.0.1", "100.127.1.1", "127.0.0.1", "169.254.1.1", "0.0.0.0", "239.1.1.1", "nope"]) {
      expect(isPublicIp(ip)).toBe(false);
    }
    expect(isPublicIp("172.32.0.1")).toBe(true);
    expect(isPublicIp("100.128.0.1")).toBe(true);
    expect(isPublicIp("2001:db8::1")).toBe(true);
    expect(isPublicIp("fe80::1")).toBe(false);
    expect(isPublicIp("fd00::1")).toBe(false);
  });

  it("reads wan_ip from the wan subsystem only", () => {
    const health = [{ subsystem: "wlan", wan_ip: "198.51.100.1" }, { subsystem: "wan", status: "ok", wan_ip: "203.0.113.25" }];
    expect(parsePublicIp(health)).toBe("203.0.113.25");
  });

  it("records nothing when the console reports no usable address", () => {
    expect(parsePublicIp([{ subsystem: "wan", status: "ok" }])).toBeNull();
    expect(parsePublicIp([{ subsystem: "wan", wan_ip: "100.70.1.1" }])).toBeNull();
    expect(parsePublicIp([{ subsystem: "wan", wan_ip: "10.0.0.2" }])).toBeNull();
    expect(parsePublicIp("nope")).toBeNull();
  });
});

describe("assignments", () => {
  const device = (over: Partial<WifiDevice>): WifiDevice => ({
    mac: "aa:bb:cc:dd:ee:01", label: null, memberName: null, hostname: null, how: ["seat"], seat: 3,
    contractId: "c1", contractNumber: "TWV-C-0001", lastSeen: null, ...over,
  });
  const issuances = [{ id: "i3", contract_id: "c1", seat_number: 3, contract_member_id: "m1" }];

  it("links a seat voucher to its issuance and member", () => {
    const a = buildAssignments([device({})], issuances).get("aa:bb:cc:dd:ee:01");
    expect(a).toEqual({ contract_id: "c1", contract_member_id: "m1", seat_number: 3, voucher_issuance_id: "i3", source: "voucher_guest" });
  });

  it("uses the right source for ad-hoc vouchers and labels, with no member", () => {
    const m = buildAssignments([
      device({ mac: "aa:bb:cc:dd:ee:02", how: ["adhoc"], seat: null }),
      device({ mac: "aa:bb:cc:dd:ee:03", how: ["label"], seat: null }),
    ], issuances);
    expect(m.get("aa:bb:cc:dd:ee:02")).toMatchObject({ source: "adhoc_voucher", contract_member_id: null, voucher_issuance_id: null });
    expect(m.get("aa:bb:cc:dd:ee:03")).toMatchObject({ source: "manual_label" });
  });

  it("detects whether the open row already says the same thing", () => {
    const next = { contract_id: "c1", contract_member_id: "m1", seat_number: 3, voucher_issuance_id: "i3", source: "voucher_guest" as const };
    expect(sameAssignment({ contract_id: "c1", contract_member_id: "m1", seat_number: 3, voucher_issuance_id: "i3" }, next)).toBe(true);
    expect(sameAssignment({ contract_id: "c1", contract_member_id: "m2", seat_number: 3, voucher_issuance_id: "i3" }, next)).toBe(false);
    expect(sameAssignment({ contract_id: "c2", contract_member_id: "m1", seat_number: 3, voucher_issuance_id: "i3" }, next)).toBe(false);
  });
});

describe("session windows", () => {
  const DAY = 86_400_000;
  const NOW = new Date("2026-11-22T12:00:00Z");

  it("starts 30 days back on a first run and a few hours before the newest stored session after that", () => {
    expect(sessionStartMs(null, NOW)).toBe(NOW.getTime() - 30 * DAY);
    const newest = "2026-11-22T09:00:00Z";
    expect(sessionStartMs(newest, NOW)).toBe(new Date(newest).getTime() - 6 * 3_600_000);
  });

  it("never reaches further back than the first-run limit", () => {
    expect(sessionStartMs("2026-01-01T00:00:00Z", NOW)).toBe(NOW.getTime() - 30 * DAY);
  });

  it("splits into day windows, oldest first, ending exactly at now", () => {
    const w = sessionWindows(NOW.getTime() - 2.5 * DAY, NOW.getTime());
    expect(w).toHaveLength(3);
    expect(w[0].start).toBeLessThan(w[1].start);
    expect(w[2].end).toBe(Math.floor(NOW.getTime() / 1000));
  });

  it("caps one run so a long outage is caught up over several", () => {
    expect(sessionWindows(NOW.getTime() - 200 * DAY, NOW.getTime())).toHaveLength(31);
  });
});
