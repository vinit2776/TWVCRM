import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

const { fetchTelemetry, fetchDevices } = vi.hoisted(() => ({ fetchTelemetry: vi.fn(), fetchDevices: vi.fn() }));
vi.mock("@/lib/onegrid", async () => {
  class OnegridApiError extends Error {
    status: number; code: string;
    constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code; }
  }
  return { OnegridApiError, fetchOnegridTelemetry: fetchTelemetry, fetchOnegridDevices: fetchDevices };
});

import { captureLocationLedger, captureAllLocations } from "../energy-ledger-capture";
import { OnegridApiError } from "@/lib/onegrid";

const NOW = new Date("2026-10-07T05:00:00Z");
const iso = (s: string) => new Date(s).toISOString();

// Minimal stand-in for the two tables the capture touches.
function fakeDb(opts: { lastRow?: { ts: string; cumulative_wh: number } | null; configs?: unknown[] }) {
  const upserts: Record<string, unknown>[][] = [];
  const db = {
    from(table: string) {
      if (table === "location_energy_readings") {
        const q = {
          select: () => q, eq: () => q, order: () => q, limit: () => q,
          maybeSingle: async () => ({ data: opts.lastRow ?? null, error: null }),
          upsert: async (rows: Record<string, unknown>[]) => { upserts.push(rows); return { error: null }; },
        };
        return q;
      }
      const c = {
        select: () => c, eq: () => c,
        not: async () => ({ data: opts.configs ?? [], error: null }),
      };
      return c;
    },
  };
  return { db: db as unknown as SupabaseClient, upserts };
}

const bucket = (ts: string, cum: number) => ({ ts, Energy_Consumption_Cumulative_Wh: cum, energy_delta_wh: 999 });

beforeEach(() => { fetchTelemetry.mockReset(); fetchDevices.mockReset(); });

describe("captureLocationLedger", () => {
  const base = { locationId: "loc", apiKey: "k", defaultDeviceId: "DEV", now: NOW };

  it("resumes from the last stored row and computes deltas from cumulative", async () => {
    const { db, upserts } = fakeDb({ lastRow: { ts: "2026-10-07T03:45:00+00:00", cumulative_wh: 1000 } });
    fetchTelemetry.mockResolvedValue({
      series: [bucket("2026-10-07T04:00:00+00:00", 1300), bucket("2026-10-07T04:15:00+00:00", 1450)],
    });
    const r = await captureLocationLedger(db, base);
    expect(r.rowsUpserted).toBe(2);
    expect(r.caughtUp).toBe(true);
    expect(upserts[0].map((x) => x.energy_delta_wh)).toEqual([300, 150]); // not OneGrid's 999
    expect(fetchTelemetry.mock.calls[0][2].start).toBe(iso("2026-10-07T03:45:00Z"));
    expect(fetchTelemetry.mock.calls[0][2].end).toBeUndefined();
  });

  it("does not re-store the seed row (would null its delta) or off-grid latest points", async () => {
    const { db, upserts } = fakeDb({ lastRow: { ts: "2026-10-07T03:45:00+00:00", cumulative_wh: 1000 } });
    fetchTelemetry.mockResolvedValue({
      series: [
        bucket("2026-10-07T03:45:00+00:00", 1000),   // the seed itself, returned again
        bucket("2026-10-07T04:00:00+00:00", 1100),
        bucket("2026-10-07T04:07:31+00:00", 1160),   // provisional latest point, off the 15-min grid
      ],
    });
    await captureLocationLedger(db, base);
    expect(upserts[0]).toHaveLength(1);
    expect(upserts[0][0]).toMatchObject({ ts: iso("2026-10-07T04:00:00Z"), energy_delta_wh: 100, cumulative_wh: 1100 });
  });

  it("stores a null delta, keeping cumulative, for the first row after a >1h gap", async () => {
    const { db, upserts } = fakeDb({ lastRow: { ts: "2026-10-07T00:00:00+00:00", cumulative_wh: 1000 } });
    fetchTelemetry.mockResolvedValue({ series: [bucket("2026-10-07T04:00:00+00:00", 5000), bucket("2026-10-07T04:15:00+00:00", 5100)] });
    await captureLocationLedger(db, base);
    expect(upserts[0].map((x) => x.energy_delta_wh)).toEqual([null, 100]);
    expect(upserts[0][0].cumulative_wh).toBe(5000);
  });

  it("writes nothing when OneGrid has nothing new", async () => {
    const { db, upserts } = fakeDb({ lastRow: { ts: "2026-10-07T04:45:00+00:00", cumulative_wh: 1000 } });
    fetchTelemetry.mockResolvedValue({ series: [] });
    const r = await captureLocationLedger(db, base);
    expect(r.rowsUpserted).toBe(0);
    expect(upserts).toHaveLength(0);
    expect(r.through).toBe("2026-10-07T04:45:00+00:00");
  });

  it("cold-starts 7 days back when the meter has no ledger yet", async () => {
    const { db } = fakeDb({ lastRow: null });
    fetchTelemetry.mockResolvedValue({ series: [] });
    await captureLocationLedger(db, base);
    expect(fetchTelemetry.mock.calls[0][2].start).toBe(iso("2026-09-30T05:00:00Z"));
  });

  it("works a long outage off in chunks, stepping over an empty chunk", async () => {
    const { db, upserts } = fakeDb({ lastRow: { ts: "2026-09-10T00:00:00+00:00", cumulative_wh: 1000 } });
    fetchTelemetry
      .mockResolvedValueOnce({ series: [] }) // hole on OneGrid's side
      .mockResolvedValueOnce({ series: [bucket("2026-09-24T00:00:00+00:00", 9000)] });
    const r = await captureLocationLedger(db, base);
    expect(fetchTelemetry).toHaveBeenCalledTimes(2);
    expect(fetchTelemetry.mock.calls[0][2].end).toBeDefined(); // bounded chunk, not "to now"
    expect(r.rowsUpserted).toBe(1);
    expect(r.caughtUp).toBe(false); // resumes from the new row next run
    expect(upserts[0][0].energy_delta_wh).toBeNull(); // spans the hole
  });

  it("resolves the main meter when no default is set", async () => {
    const { db } = fakeDb({ lastRow: null });
    fetchDevices.mockResolvedValue({ by_plant: { p: { devices: [{ device_id: "SUB", meter_role: "sub" }, { device_id: "MAIN", meter_role: "main" }] } } });
    fetchTelemetry.mockResolvedValue({ series: [] });
    const r = await captureLocationLedger(db, { ...base, defaultDeviceId: null });
    expect(r.deviceId).toBe("MAIN");
  });
});

describe("captureAllLocations", () => {
  it("isolates failures per location and never leaks raw errors or keys", async () => {
    const configs = [
      { location_id: "a", onegrid_api_key: "SECRET-A", onegrid_default_device_id: "DA" },
      { location_id: "b", onegrid_api_key: "SECRET-B", onegrid_default_device_id: "DB" },
    ];
    const { db } = fakeDb({ lastRow: { ts: "2026-10-07T04:45:00+00:00", cumulative_wh: 1000 }, configs });
    fetchTelemetry
      .mockRejectedValueOnce(new OnegridApiError(503, "X", "Supabase registry unreachable: host='pwcz.supabase.co'"))
      .mockResolvedValueOnce({ series: [] });
    const out = await captureAllLocations(db, { now: NOW });
    expect(out.locations.map((l) => l.status)).toEqual(["error", "ok"]);
    expect(out.locations[0].error_kind).toBe("unavailable");
    expect(JSON.stringify(out)).not.toMatch(/SECRET|supabase\.co/);
  });

  it("skips locations once the time budget is spent", async () => {
    const configs = [{ location_id: "a", onegrid_api_key: "k", onegrid_default_device_id: "DA" }];
    const { db } = fakeDb({ lastRow: null, configs });
    const out = await captureAllLocations(db, { now: NOW, budgetMs: -1 });
    expect(out.skipped).toBe(1);
    expect(out.locations).toHaveLength(0);
  });
});
