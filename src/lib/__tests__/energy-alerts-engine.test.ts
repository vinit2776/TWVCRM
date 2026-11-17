import { describe, expect, it } from "vitest";
import { emptyState, isOutOfBand, SLOT_MS, stepSlot, type EngineState, type RuleParams } from "@/lib/energy-alerts/engine";
import { buildAlertEmail } from "@/lib/energy-alerts/email";

const P: RuleParams = { tolerancePct: 5, minKw: 2, direction: "both", persistSlots: 2, recoverSlots: 4, reminder: "std" };
const T0 = Date.UTC(2026, 10, 17, 0, 0, 0);

// Run a series of multipliers over a flat 30 kW "usual"; returns emails (effects) per slot.
function run(mults: number[], p: RuleParams = P, ack?: (k: number) => boolean) {
  let state: EngineState = emptyState();
  const kinds: string[] = [];
  mults.forEach((m, k) => {
    if (ack && ack(k) && state.episode) state = { ...state, episode: { ...state.episode, acked: true } };
    const r = stepSlot(state, { tsMs: T0 + k * SLOT_MS, actualKw: 30 * m, typicalKw: 30 }, p);
    state = r.state;
    r.effects.forEach((e) => kinds.push(`${e.kind}@${k}`));
  });
  return { state, kinds };
}
const rep = (m: number, n: number) => new Array<number>(n).fill(m);

describe("slot out of band", () => {
  it("needs both the percentage and the kW floor", () => {
    expect(isOutOfBand(32, 30, P)).toBe(true); // 6.7%, 2 kW
    expect(isOutOfBand(31.5, 30, P)).toBe(false); // 5% exactly is not beyond tolerance
    expect(isOutOfBand(1.1, 1, P)).toBe(false); // 10% of 1 kW is under the kW floor
  });
  it("respects direction", () => {
    expect(isOutOfBand(20, 30, { ...P, direction: "high" })).toBe(false);
    expect(isOutOfBand(20, 30, { ...P, direction: "low" })).toBe(true);
  });
});

describe("episodes", () => {
  it("does not alert on a one-slot blip", () => {
    expect(run([1, 1.25, 1, 1, 1]).kinds).toEqual([]);
  });
  it("opens once after the deviation has persisted, then stays quiet", () => {
    expect(run([1, ...rep(1.2, 6)]).kinds).toEqual(["opened@2"]);
  });
  it("one email at open and a 2h reminder for an issue that carries on", () => {
    const { kinds } = run([1, ...rep(1.2, 12)]);
    expect(kinds).toEqual(["opened@2", "reminder@10"]); // opened slot 2, +8 slots = 2h
  });
  it("caps reminders at three however long it lasts", () => {
    const { kinds } = run([1, ...rep(1.2, 200)]);
    expect(kinds.filter((k) => k.startsWith("reminder"))).toHaveLength(3);
  });
  it("hovering at the edge stays one episode (dips do not close it)", () => {
    const pattern = [1, ...Array.from({ length: 24 }, (_, i) => (i % 6 < 4 ? 1.07 : 1.04))];
    const { kinds } = run(pattern);
    expect(kinds.filter((k) => k.startsWith("opened"))).toHaveLength(1);
  });
  it("closes only after sustained recovery, and a resolved effect is produced", () => {
    const { kinds, state } = run([1, 1.2, 1.2, 1.2, 1.01, 1.01, 1.01, 1.01]);
    expect(kinds).toContain("resolved@7");
    expect(state.episode).toBeNull();
  });
  it("a partial recovery (between 60% and 100% of tolerance) does not close it", () => {
    const { state } = run([1, 1.2, 1.2, ...rep(1.04, 10)]);
    expect(state.episode).not.toBeNull();
  });
  it("emails again only when it crosses a worse step", () => {
    const { kinds } = run([1, 1.07, 1.07, 1.07, 1.13, 1.13, 1.28, 1.28]);
    expect(kinds).toEqual(["opened@2", "worse@4", "worse@6"]);
  });
  it("acknowledging stops reminders but a worse step still emails", () => {
    const { kinds } = run([1, ...rep(1.07, 12), ...rep(1.3, 2)], P, (k) => k >= 3);
    expect(kinds.filter((k) => k.startsWith("reminder"))).toHaveLength(0);
    expect(kinds.some((k) => k.startsWith("worse"))).toBe(true);
  });
  it("a reminder schedule of none sends nothing after the first email", () => {
    expect(run([1, ...rep(1.2, 120)], { ...P, reminder: "none" }).kinds).toEqual(["opened@2"]);
  });
  it("a meter gap breaks a building streak but not an open episode", () => {
    let state = emptyState();
    state = stepSlot(state, { tsMs: T0, actualKw: 36, typicalKw: 30 }, P).state; // streak 1
    state = stepSlot(state, { tsMs: T0 + SLOT_MS, actualKw: null, typicalKw: 30 }, P).state; // gap
    expect(state.streakSlots).toBe(0);
    const r = stepSlot(state, { tsMs: T0 + 2 * SLOT_MS, actualKw: 36, typicalKw: 30 }, P);
    expect(r.opened).toBe(false); // needs two in a row again
  });
  it("no usual curve (not enough history) means no alert", () => {
    const r = stepSlot(emptyState(), { tsMs: T0, actualKw: 90, typicalKw: null }, P);
    expect(r.effects).toEqual([]);
  });
  it("a direction flip restarts the streak instead of opening", () => {
    expect(run([1.2, 0.8, 1.2, 0.8, 1.2, 0.8]).kinds).toEqual([]);
  });
});

describe("alert email", () => {
  const eff = { kind: "opened" as const, tsMs: T0 + 14 * 3_600_000, actualKw: 41.2, typicalKw: 34.8, devPct: 18.4, extraKwh: 3.2 };
  const base = { kind: "opened" as const, effect: eff, locationName: "Perungudi <Test>", ruleName: "Rule", tolerancePct: 5, minKw: 2, persistSlots: 2, openedMs: eff.tsMs, startedMs: eff.tsMs - SLOT_MS, appUrl: "https://x.test", testMode: false };
  it("states the impact and escapes names", () => {
    const m = buildAlertEmail(base);
    expect(m.subject).toContain("+18%");
    expect(m.html).toContain("Perungudi &lt;Test&gt;");
    expect(m.html).toContain("3.2 kWh");
  });
  it("marks test mode in subject and body", () => {
    const m = buildAlertEmail({ ...base, testMode: true });
    expect(m.subject.startsWith("[TEST]")).toBe(true);
    expect(m.html).toContain("TEST");
  });
});

describe("usual-for-slot baseline", () => {
  // 20 days of 15-minute readings: weekdays 30 kW, Saturdays 18 kW, Sundays 7.5 kW, ending 2026-11-16 (Mon).
  const IST = 5.5 * 3_600_000;
  function ledger(days: number) {
    const rows: { ts: string; energy_delta_wh: number; cumulative_wh: number }[] = [];
    const end = Date.UTC(2026, 10, 16, 18, 30); // 2026-11-17 00:00 IST
    let cum = 0;
    for (let ts = end - days * 96 * SLOT_MS; ts <= end; ts += SLOT_MS) {
      const dow = new Date(ts + IST - 1).getUTCDay();
      const kw = dow === 0 ? 7.5 : dow === 6 ? 18 : 30;
      cum += kw * 250;
      rows.push({ ts: new Date(ts).toISOString(), energy_delta_wh: kw * 250, cumulative_wh: cum });
    }
    return rows;
  }

  it("uses same-kind days only, and stays silent when there are too few instead of borrowing weekdays", async () => {
    const { makeBaselineCtx, typicalFor } = await import("@/lib/energy-alerts/baseline");
    const rows = ledger(20);
    const ctx = makeBaselineCtx(rows, [], "2026-11-17");
    const mon = typicalFor(ctx, "2026-11-16");
    expect(mon.typical[40]).toBeCloseTo(30, 0);
    const sat = typicalFor(ctx, "2026-11-14");
    expect(sat.dayClass).toBe("saturday");
    expect(sat.typical.every((v) => v == null || Math.abs(v - 18) < 0.5)).toBe(true); // never the weekday 30
    const young = typicalFor(makeBaselineCtx(ledger(8), [], "2026-11-17"), "2026-11-14");
    expect(young.typical.every((v) => v == null)).toBe(true); // 1 Saturday of history: no opinion
  });

  it("leaves excluded days out of 'usual'", async () => {
    const { makeBaselineCtx, typicalFor } = await import("@/lib/energy-alerts/baseline");
    const rows = ledger(20);
    const all = typicalFor(makeBaselineCtx(rows, [], "2026-11-17"), "2026-11-16");
    const without = typicalFor(makeBaselineCtx(rows, [], "2026-11-17", new Set(["2026-11-13", "2026-11-12"])), "2026-11-16");
    expect(without.peers).toBe(all.peers - 2);
  });
});
