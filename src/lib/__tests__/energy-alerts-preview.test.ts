import { describe, expect, it } from "vitest";
import { buildCurvePreview } from "@/lib/energy-alerts/preview";

const SLOT_MS = 15 * 60 * 1000;
const IST = 5.5 * 3_600_000;

// `days` of 15-minute readings up to `endIso`: weekdays 30 kW, Saturdays 18 kW, Sundays 7.5 kW.
function ledger(days: number, endIso: string) {
  const end = new Date(endIso).getTime();
  const rows: { ts: string; energy_delta_wh: number; cumulative_wh: number }[] = [];
  let cum = 0;
  for (let ts = end - days * 96 * SLOT_MS; ts <= end; ts += SLOT_MS) {
    const dow = new Date(ts + IST - 1).getUTCDay();
    const kw = dow === 0 ? 7.5 : dow === 6 ? 18 : 30;
    cum += kw * 250;
    rows.push({ ts: new Date(ts).toISOString(), energy_delta_wh: kw * 250, cumulative_wh: cum });
  }
  return rows;
}

describe("curve preview for the rule editor", () => {
  // Tue 2026-11-17, 12:00 IST = 06:30Z.
  const now = new Date("2026-11-17T06:30:00Z");

  it("gives the usual kW per slot, today's readings so far, and what the usual is built from", () => {
    const p = buildCurvePreview(ledger(30, "2026-11-17T06:30:00Z"), [], new Set(), now);
    expect(p.dayLabel).toBe("a Mon–Fri working day");
    expect(p.enough).toBe(true);
    expect(p.peers).toBeGreaterThanOrEqual(p.minPeers);
    expect(p.slots).toHaveLength(96);
    expect(p.slots[40].typical).toBeCloseTo(30, 0); // 10:00 usual
    expect(p.slots[40].actual).toBeCloseTo(30, 0); // today's reading
    expect(p.slots[90].actual).toBeNull(); // not happened yet
    expect(p.lastSlot).not.toBeNull();
    expect(p.lastSlot!).toBeGreaterThanOrEqual(46);
    expect(p.lastSlot!).toBeLessThanOrEqual(48);
  });

  it("says plainly when there is too little history instead of drawing a made-up usual", () => {
    const p = buildCurvePreview(ledger(2, "2026-11-17T06:30:00Z"), [], new Set(), now);
    expect(p.enough).toBe(false);
    expect(p.slots.every((s) => s.typical == null)).toBe(true);
  });
});
