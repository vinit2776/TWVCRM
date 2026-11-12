import { describe, expect, it } from "vitest";
import { biggestPillarDrop, buildInsights, type InsightInput } from "@/lib/customer-value/insights";
import { buildRenewalOutlook, type OutlookInput } from "@/lib/customer-value/renewal-outlook";
import { change90, filterPortfolio, sortPortfolio, summarisePortfolio, type PortfolioRow } from "@/lib/customer-value/portfolio-view";
import type { StoredScoreRow } from "@/lib/customer-value/summary-view";

// ── helpers ──────────────────────────────────────────────────────────────
const score = (over: Partial<StoredScoreRow> & { metrics?: Record<string, number> } = {}): StoredScoreRow => {
  const { metrics, ...rest } = over;
  const m = (pillar: string, keys: string[]) => ({
    notes: [], months_used: 6,
    metrics: keys.filter((k) => metrics && k in metrics).map((k) => ({ key: k, status: "ok" as const, method: "fixed", cohort_size: 0, value: (metrics as Record<string, number>)[k], score: 50 })),
  });
  return {
    as_of: "2026-10-19", payment: 80, friction: 80, engagement: 70, profitability: 60, confidence: {}, overall: 72, tier: "B", status: "graded",
    reason: null, trend_vs_90d: "flat",
    method: { pillars: { engagement: m("engagement", ["seat_trend_pct"]), profitability: m("profitability", ["rent_vs_center"]) } },
    story: null, settings_version: null, computed_at: "2026-10-19T00:00:00Z", ...rest,
  } as StoredScoreRow;
};
const input = (over: Partial<InsightInput> = {}): InsightInput => ({ latest: score(), previous: null, marginPerMonth: null, daysToRenewal: null, pushedBackOnEscalation: false, ...over });
const keys = (i: InsightInput) => buildInsights(i).map((x) => x.key);

describe("buildInsights", () => {
  it("says nothing for a customer with no score, or an ordinary one", () => {
    expect(buildInsights(input({ latest: null }))).toEqual([]);
    expect(keys(input())).toEqual([]);
  });

  it("flags a customer who pays late but has little friction", () => {
    expect(keys(input({ latest: score({ payment: 40, friction: 85 }) }))).toContain("late_not_service");
    expect(keys(input({ latest: score({ payment: 40, friction: 50 }) }))).not.toContain("late_not_service");
  });

  it("flags a strong customer with high friction as a risk", () => {
    const r = buildInsights(input({ latest: score({ profitability: 70, friction: 40 }) }));
    expect(r[0]).toMatchObject({ key: "valuable_but_friction", tone: "risk" });
  });

  it("flags a negative margin only when one is stored, and says it is an estimate", () => {
    expect(keys(input({ marginPerMonth: null }))).not.toContain("negative_margin");
    expect(keys(input({ marginPerMonth: 5_000 }))).not.toContain("negative_margin");
    const r = buildInsights(input({ marginPerMonth: -12_000 }));
    expect(r.find((i) => i.key === "negative_margin")?.text).toMatch(/12,000.*estimate/);
  });

  it("flags shrinking seats only when the contract ends soon", () => {
    const shrinking = score({ metrics: { seat_trend_pct: -20 } });
    expect(keys(input({ latest: shrinking, daysToRenewal: 45 }))).toContain("shrinking_and_renewing");
    expect(keys(input({ latest: shrinking, daysToRenewal: 200 }))).not.toContain("shrinking_and_renewing");
    expect(keys(input({ latest: shrinking, daysToRenewal: -3 }))).not.toContain("shrinking_and_renewing");
  });

  it("flags earlier escalation push-back only when renewing soon", () => {
    expect(keys(input({ pushedBackOnEscalation: true, daysToRenewal: 30 }))).toContain("pushed_back_and_renewing");
    expect(keys(input({ pushedBackOnEscalation: true, daysToRenewal: 300 }))).not.toContain("pushed_back_and_renewing");
    expect(keys(input({ pushedBackOnEscalation: false, daysToRenewal: 30 }))).not.toContain("pushed_back_and_renewing");
  });

  it("notes room to raise rent for a punctual customer paying below the center", () => {
    expect(keys(input({ latest: score({ payment: 85, metrics: { rent_vs_center: 0.8 } }) }))).toContain("room_to_raise");
    expect(keys(input({ latest: score({ payment: 60, metrics: { rent_vs_center: 0.8 } }) }))).not.toContain("room_to_raise");
    expect(keys(input({ latest: score({ payment: 85, metrics: { rent_vs_center: 1.05 } }) }))).not.toContain("room_to_raise");
  });

  it("flags a tier drop and names the pillar that fell furthest", () => {
    const previous = score({ tier: "B", payment: 80, friction: 80 });
    const latest = score({ tier: "C", payment: 70, friction: 55 });
    const r = buildInsights(input({ latest, previous }));
    const drop = r.find((i) => i.key === "tier_dropped")!;
    expect(drop.text).toMatch(/from B to C/);
    expect(drop.text).toMatch(/friction \(-25 points\)/);
    expect(keys(input({ latest: score({ tier: "B" }), previous: score({ tier: "C" }) }))).not.toContain("tier_dropped");
  });

  it("calls a healthy A-tier customer who renews soon out for an early renewal, unless trending down", () => {
    expect(keys(input({ latest: score({ tier: "A" }), daysToRenewal: 60 }))).toContain("healthy_and_renewing");
    expect(keys(input({ latest: score({ tier: "A", trend_vs_90d: "down" }), daysToRenewal: 60 }))).not.toContain("healthy_and_renewing");
    expect(keys(input({ latest: score({ tier: "B" }), daysToRenewal: 60 }))).not.toContain("healthy_and_renewing");
  });

  it("puts risks first, then watch, then good, and caps the list", () => {
    const r = buildInsights(input({
      latest: score({ tier: "A", payment: 40, friction: 40, profitability: 70, metrics: { seat_trend_pct: -30, rent_vs_center: 0.7 } }),
      previous: score({ tier: "A" }), marginPerMonth: -1000, daysToRenewal: 30, pushedBackOnEscalation: true,
    }));
    const tones = r.map((i) => i.tone);
    expect([...tones].sort((a, b) => ["risk", "watch", "good"].indexOf(a) - ["risk", "watch", "good"].indexOf(b))).toEqual(tones);
    expect(r.length).toBeLessThanOrEqual(5);
  });

  it("names the metrics each insight rests on", () => {
    expect(buildInsights(input({ latest: score({ payment: 40, friction: 85 }) }))[0].basis).toEqual(["payment", "friction"]);
  });
});

describe("biggestPillarDrop", () => {
  it("is null when nothing fell or nothing can be compared", () => {
    expect(biggestPillarDrop(score({ payment: 90 }), score({ payment: 80 }))).toBeNull();
    expect(biggestPillarDrop(score({ payment: null, friction: null, engagement: null, profitability: null }), score())).toBeNull();
  });
});

// ── renewal outlook ──────────────────────────────────────────────────────
const outlookInput = (over: Partial<OutlookInput> = {}): OutlookInput => ({
  current: { contractNumber: "TWV-C-0010", endDate: "2026-12-12", daysToEnd: 53, renewalDraftStatus: null },
  standingEscalationPct: 10, renewalCount: 2, renewalsDeclined: 0, escalationOutcomes: ["accepted", "reduced"],
  rentPerSeat: 10_000, breakEvenRentPerSeat: 8_700, urgentWithinDays: 90, ...over,
});

describe("buildRenewalOutlook", () => {
  it("has nothing to plan without a live contract", () => {
    const o = buildRenewalOutlook(outlookInput({ current: null }));
    expect(o.stage).toBe("no_live_contract");
    expect(o.lines).toEqual([]);
    expect(o.urgent).toBe(false);
  });

  it("gives the end date, days left and the renewal stage, urgent when nothing is started", () => {
    const o = buildRenewalOutlook(outlookInput());
    expect(o.headline).toMatch(/ends in 53 days/);
    expect(o.stage).toBe("not_started");
    expect(o.urgent).toBe(true);
    expect(o.lines[0]).toEqual({ text: "No renewal has been started.", tone: "risk" });
  });

  it("maps the renewal draft's status to a stage, and a signed one is not urgent", () => {
    const stage = (renewalDraftStatus: string | null, daysToEnd = 20) => buildRenewalOutlook(outlookInput({ current: { contractNumber: "X", endDate: "2026-11-09", daysToEnd, renewalDraftStatus } }));
    expect(stage("draft").stage).toBe("draft");
    expect(stage("sent").stage).toBe("sent");
    expect(stage("viewed").stage).toBe("sent");
    expect(stage("accepted").stage).toBe("accepted");
    expect(stage("accepted").urgent).toBe(false);
    expect(stage("sent").urgent).toBe(false);
    expect(stage(null, 200).urgent).toBe(false);
    expect(stage(null, -5).stage).toBe("ended");
    expect(stage(null, -5).headline).toMatch(/ended 5 days ago/);
  });

  it("says escalation is not recorded rather than guessing", () => {
    expect(buildRenewalOutlook(outlookInput({ standingEscalationPct: null })).lines.map((l) => l.text)).toContain("Escalation ask: not recorded on this contract.");
    expect(buildRenewalOutlook(outlookInput()).lines.map((l) => l.text)).toContain("Escalation ask: 10% (the standing clause).");
  });

  it("summarises past renewals and warns when they pushed back or declined", () => {
    const o = buildRenewalOutlook(outlookInput());
    const history = o.lines.find((l) => l.text.startsWith("Renewed"))!;
    expect(history.text).toBe("Renewed 2 times. Escalation accepted 1 time, reduced 1 time.");
    expect(history.tone).toBe("watch");
    expect(buildRenewalOutlook(outlookInput({ escalationOutcomes: ["accepted"], renewalCount: 1 })).lines.find((l) => l.text.startsWith("Renewed"))!.tone).toBe("plain");
    expect(buildRenewalOutlook(outlookInput({ renewalsDeclined: 1 })).lines.find((l) => l.text.startsWith("Renewed"))!.text).toMatch(/declined 1 renewal/);
    expect(buildRenewalOutlook(outlookInput({ renewalCount: 0, escalationOutcomes: [] })).lines.map((l) => l.text)).toContain("First term: no earlier renewal to learn from.");
    expect(buildRenewalOutlook(outlookInput({ escalationOutcomes: ["unknown", "unknown"] })).lines.find((l) => l.text.startsWith("Renewed"))!.text).toMatch(/outcome not recorded/);
  });

  it("compares rent with break-even, in either direction, and when break-even is unknown", () => {
    expect(buildRenewalOutlook(outlookInput()).lines.at(-1)).toMatchObject({ tone: "good" });
    const loss = buildRenewalOutlook(outlookInput({ rentPerSeat: 8_000 })).lines.at(-1)!;
    expect(loss.tone).toBe("risk");
    expect(loss.text).toMatch(/loses money/);
    expect(buildRenewalOutlook(outlookInput({ breakEvenRentPerSeat: null })).lines.at(-1)!.text).toMatch(/Break-even is not worked out/);
    expect(buildRenewalOutlook(outlookInput({ rentPerSeat: null })).lines.some((l) => /per seat/.test(l.text))).toBe(false);
  });
});

// ── portfolio ────────────────────────────────────────────────────────────
const row = (over: Partial<PortfolioRow> = {}): PortfolioRow => ({
  leadId: "x", name: "Acme", centerId: "c1", centerName: "Center 1", tier: "B", overall: 70, trend: "flat", payment: 70, friction: 70, engagement: 70, profitability: 70,
  previousOverall: 70, previousTier: "B", change90: 0, marginPerMonth: 10_000, marginPct: 0.5, daysToRenewal: 100, hasLiveContract: true, insights: [], ...over,
});

describe("portfolio", () => {
  it("works out the 90-day change, null unless both ends are known", () => {
    expect(change90(62, 70)).toBe(-8);
    expect(change90(null, 70)).toBeNull();
    expect(change90(62, null)).toBeNull();
  });

  const rows = [
    row({ leadId: "a", name: "Alpha", change90: -3, tier: "B", overall: 68, daysToRenewal: 200, marginPerMonth: 5_000 }),
    row({ leadId: "b", name: "Bravo", change90: -15, tier: "C", overall: 52, daysToRenewal: 20, marginPerMonth: -2_000 }),
    row({ leadId: "c", name: "Charlie", change90: null, tier: null, overall: null, daysToRenewal: null, marginPerMonth: null }),
    row({ leadId: "d", name: "Delta", change90: 6, tier: "A", overall: 85, daysToRenewal: -4, marginPerMonth: 30_000 }),
  ];
  const order = (sorted: PortfolioRow[]) => sorted.map((r) => r.leadId).join("");

  it("sorts by biggest drop first, with unknowns last", () => {
    expect(order(sortPortfolio(rows, "biggest_drop"))).toBe("badc");
  });

  it("sorts by renewal soonest, skipping ended and unknown, and by lowest tier and margin", () => {
    expect(order(sortPortfolio(rows, "renewal_soonest"))).toBe("bacd");
    expect(order(sortPortfolio(rows, "lowest_tier"))).toBe("badc");
    expect(order(sortPortfolio(rows, "lowest_margin"))).toBe("badc");
  });

  it("filters by center, tier, renewal window and live contract", () => {
    const mixed = [row({ leadId: "a" }), row({ leadId: "b", centerId: "c2", tier: "D", daysToRenewal: 30 }), row({ leadId: "c", hasLiveContract: false, daysToRenewal: null })];
    expect(filterPortfolio(mixed, {}).map((r) => r.leadId)).toEqual(["a", "b"]);
    expect(filterPortfolio(mixed, { includePast: true }).map((r) => r.leadId)).toEqual(["a", "b", "c"]);
    expect(filterPortfolio(mixed, { centerId: "c2" }).map((r) => r.leadId)).toEqual(["b"]);
    expect(filterPortfolio(mixed, { tiers: ["D", "C"] }).map((r) => r.leadId)).toEqual(["b"]);
    expect(filterPortfolio(mixed, { renewingWithinDays: 90 }).map((r) => r.leadId)).toEqual(["b"]);
  });

  it("counts tiers, drops, renewals soon and at-risk customers", () => {
    const s = summarisePortfolio([
      row({ leadId: "a", tier: "A", previousTier: "A" }),
      row({ leadId: "b", tier: "C", previousTier: "B", daysToRenewal: 30, insights: [{ key: "tier_dropped", tone: "risk", text: "x" }] }),
      row({ leadId: "c", tier: null, previousTier: null, daysToRenewal: null }),
    ]);
    expect(s).toEqual({ customers: 3, byTier: { A: 1, B: 0, C: 1, D: 0, none: 1 }, dropped: 1, renewingSoon: 1, atRisk: 1 });
  });
});
