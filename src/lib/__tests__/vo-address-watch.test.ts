import { describe, expect, it } from "vitest";
import {
  DEFAULT_HOLDOVER_SETTINGS,
  addressMatch,
  annualEquivalentRate,
  billingCycleNumber,
  holdoverAmount,
  holdoverUpliftPct,
  isBillingCycleDay,
  isCheckDay,
  nextCheckDay,
  normalizeAddress,
  parseHoldoverSettings,
  parseWatchMode,
  planHoldoverPi,
  releaseDecision,
  verdictFromSources,
  type AddressVerdict,
  type VerdictSources,
} from "@/lib/vo-address-watch";

const OURS = "No. 12, 3rd Flr, Brigade Rd, Indiranagar, Bangalore - 560038";

describe("normalizeAddress", () => {
  it("lowercases, strips punctuation and expands abbreviations", () => {
    expect(normalizeAddress("12, MG Rd.,  Bldg-2")).toBe("12 mg road building 2");
  });
  it("handles empty input", () => {
    expect(normalizeAddress("")).toBe("");
    expect(normalizeAddress(null)).toBe("");
    expect(normalizeAddress(undefined)).toBe("");
  });
});

describe("addressMatch", () => {
  it("matches the same address spelled out", () => {
    const r = addressMatch(OURS, "12, 3rd Floor, Brigade Road, Indiranagar, Bengaluru 560038");
    expect(r.match).toBe(true);
    expect(r.score).toBeGreaterThan(0.9);
  });
  it("is tolerant of word order", () => {
    expect(addressMatch(OURS, "Indiranagar, Brigade Road, 12, Bangalore 560038").match).toBe(true);
  });
  it("matches when the other side has no pincode", () => {
    expect(addressMatch(OURS, "12 Brigade Road Indiranagar Bangalore").match).toBe(true);
  });
  it("matches when ours has no pincode", () => {
    expect(addressMatch("12 Brigade Road Indiranagar", "12, Brigade Rd, Indiranagar 560038").match).toBe(true);
  });
  it("does not match a different door number", () => {
    const r = addressMatch(OURS, "14, Brigade Road, Indiranagar, Bangalore 560038");
    expect(r.match).toBe(false);
    expect(r.score).toBeLessThanOrEqual(0.3);
  });
  it("does not match a different pincode", () => {
    const r = addressMatch(OURS, "12, Brigade Road, Indiranagar, Bangalore 560001");
    expect(r).toEqual({ score: 0, match: false });
  });
  it("does not treat a different floor as a different door", () => {
    expect(addressMatch(OURS, "12, 5th Floor, Brigade Road, Indiranagar 560038").match).toBe(true);
  });
  it("does not match a different street", () => {
    expect(addressMatch(OURS, "12, Church Street, Shivajinagar, Bangalore 560038").match).toBe(false);
  });
  it("does not match on a city name alone", () => {
    expect(addressMatch(OURS, "Bangalore 560038").match).toBe(false);
  });
  it("handles empty input", () => {
    expect(addressMatch(OURS, "").match).toBe(false);
    expect(addressMatch("", "").match).toBe(false);
  });
});

describe("verdictFromSources", () => {
  const gsts: VerdictSources["gst"][] = ["listed", "removed", "unavailable"];
  const mcas: VerdictSources["mca"][] = ["listed", "removed", "not_applicable"];
  const bools = [false, true];

  function expected(s: VerdictSources): AddressVerdict {
    if (s.gst === "listed" || s.mca === "listed") return "in_use";
    if (s.gst === "unavailable") return "inconclusive";
    if (s.websiteSigns || s.mailLogged) return "likely";
    return "clear";
  }

  it("covers every combination", () => {
    for (const gst of gsts)
      for (const mca of mcas)
        for (const websiteSigns of bools)
          for (const mailLogged of bools) {
            const s = { gst, mca, websiteSigns, mailLogged };
            expect(verdictFromSources(s)).toBe(expected(s));
          }
  });
  it("spot checks", () => {
    const base = { gst: "removed", mca: "removed", websiteSigns: false, mailLogged: false } as const;
    expect(verdictFromSources(base)).toBe("clear");
    expect(verdictFromSources({ ...base, gst: "listed" })).toBe("in_use");
    expect(verdictFromSources({ ...base, mca: "listed" })).toBe("in_use");
    expect(verdictFromSources({ ...base, gst: "unavailable", mca: "listed" })).toBe("in_use");
    expect(verdictFromSources({ ...base, gst: "unavailable" })).toBe("inconclusive");
    expect(verdictFromSources({ ...base, gst: "unavailable", websiteSigns: true })).toBe("inconclusive");
    expect(verdictFromSources({ ...base, mailLogged: true })).toBe("likely");
    expect(verdictFromSources({ ...base, mca: "not_applicable", websiteSigns: true })).toBe("likely");
  });
});

describe("check schedule", () => {
  it("checks on days 7, 15, 30 and every 30 after, up to day 150", () => {
    const days = Array.from({ length: 151 }, (_, d) => d).filter(isCheckDay);
    expect(days).toEqual([7, 15, 30, 60, 90, 120, 150]);
  });
  it("rejects day 0, negatives and fractions", () => {
    expect(isCheckDay(0)).toBe(false);
    expect(isCheckDay(-30)).toBe(false);
    expect(isCheckDay(7.5)).toBe(false);
  });
  it("finds the next check day", () => {
    expect(nextCheckDay(0)).toBe(7);
    expect(nextCheckDay(7)).toBe(15);
    expect(nextCheckDay(10)).toBe(15);
    expect(nextCheckDay(15)).toBe(30);
    expect(nextCheckDay(29)).toBe(30);
    expect(nextCheckDay(30)).toBe(60);
    expect(nextCheckDay(31)).toBe(60);
    expect(nextCheckDay(149)).toBe(150);
    expect(nextCheckDay(150)).toBe(180);
  });
  it("walks the whole schedule through nextCheckDay", () => {
    const walked: number[] = [];
    for (let d = nextCheckDay(0); d <= 150; d = nextCheckDay(d)) walked.push(d);
    expect(walked).toEqual([7, 15, 30, 60, 90, 120, 150]);
  });
  it("bills on day 0 and every 30 days", () => {
    const days = Array.from({ length: 151 }, (_, d) => d).filter(isBillingCycleDay);
    expect(days).toEqual([0, 30, 60, 90, 120, 150]);
    expect(isBillingCycleDay(-30)).toBe(false);
    expect(billingCycleNumber(0)).toBe(1);
    expect(billingCycleNumber(60)).toBe(3);
    expect(billingCycleNumber(45)).toBeNull();
  });
});

describe("releaseDecision", () => {
  const at = (day: number, hour = 0) => new Date(Date.UTC(2026, 0, 1 + day, hour)).toISOString();
  const c = (day: number, verdict: AddressVerdict, hour = 0) => ({ checkedAt: at(day, hour), verdict });

  it("needs two checks", () => {
    expect(releaseDecision([])).toBe("continue");
    expect(releaseDecision([c(7, "clear")])).toBe("continue");
  });
  it("is ready on two clear checks 7 days apart exactly", () => {
    expect(releaseDecision([c(7, "clear"), c(14, "clear")])).toBe("ready");
  });
  it("continues when the gap is just under 7 days", () => {
    expect(releaseDecision([c(7, "clear", 1), c(14, "clear", 0)])).toBe("continue");
  });
  it("is ready on a wide gap", () => {
    expect(releaseDecision([c(15, "clear"), c(30, "clear")])).toBe("ready");
  });
  it("continues when the latest is not clear", () => {
    expect(releaseDecision([c(7, "clear"), c(15, "in_use")])).toBe("continue");
    expect(releaseDecision([c(7, "clear"), c(15, "inconclusive")])).toBe("continue");
    expect(releaseDecision([c(7, "clear"), c(15, "likely")])).toBe("continue");
  });
  it("continues when a non-clear check sits between two clear ones", () => {
    expect(releaseDecision([c(7, "clear"), c(15, "in_use"), c(30, "clear")])).toBe("continue");
  });
  it("is ready again after a non-clear check once two clear ones follow", () => {
    expect(releaseDecision([c(7, "clear"), c(15, "in_use"), c(30, "clear"), c(60, "clear")])).toBe("ready");
  });
  it("uses time order, not list order", () => {
    expect(releaseDecision([c(30, "clear"), c(7, "in_use"), c(15, "clear")])).toBe("ready");
  });
  it("accepts Date objects", () => {
    expect(
      releaseDecision([
        { checkedAt: new Date(at(0)), verdict: "clear" },
        { checkedAt: new Date(at(8)), verdict: "clear" },
      ]),
    ).toBe("ready");
  });
});

describe("holdover rate", () => {
  const s = DEFAULT_HOLDOVER_SETTINGS;

  it("has the documented defaults", () => {
    expect(s).toEqual({ upliftPct: 25, stepPct: 10, periodMonths: 3, capPct: 60 });
  });
  it("escalates 25,25,25,35,35,35,45,45 for n=1..8", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8].map((n) => holdoverUpliftPct(n, s))).toEqual([
      25, 25, 25, 35, 35, 35, 45, 45,
    ]);
  });
  it("caps at 60", () => {
    expect(holdoverUpliftPct(10, s)).toBe(55);
    expect(holdoverUpliftPct(13, s)).toBe(60);
    expect(holdoverUpliftPct(100, s)).toBe(60);
  });
  it("treats n below 1 as the first month", () => {
    expect(holdoverUpliftPct(0, s)).toBe(25);
    expect(holdoverUpliftPct(-4, s)).toBe(25);
  });
  it("honours custom settings", () => {
    const custom = { upliftPct: 20, stepPct: 5, periodMonths: 1, capPct: 30 };
    expect([1, 2, 3, 4, 5].map((n) => holdoverUpliftPct(n, custom))).toEqual([20, 25, 30, 30, 30]);
  });
  it("prices a 12 month term as rate / 12 uplifted", () => {
    expect(holdoverAmount({ rate: 12000, tenureMonths: 12, n: 1, settings: s })).toBe(1250);
    expect(holdoverAmount({ rate: 12000, tenureMonths: 12, n: 4, settings: s })).toBe(1350);
    expect(holdoverAmount({ rate: 12000, tenureMonths: 12, n: 13, settings: s })).toBe(1600);
    expect(holdoverAmount({ rate: 10000, tenureMonths: 12, n: 1, settings: s })).toBe(1041.67);
    expect(holdoverAmount({ rate: 0, tenureMonths: 12, n: 1, settings: s })).toBe(0);
  });
  it("treats rate as the term fee for terms under 12 months", () => {
    expect(annualEquivalentRate(6000, 6)).toBe(12000);
    expect(holdoverAmount({ rate: 6000, tenureMonths: 6, n: 1, settings: s })).toBe(1250);
    expect(holdoverAmount({ rate: 3000, tenureMonths: 3, n: 1, settings: s })).toBe(1250);
  });
  it("treats rate as already annual for 24, 36 and 48 month terms", () => {
    for (const tenureMonths of [24, 36, 48]) {
      expect(annualEquivalentRate(12000, tenureMonths)).toBe(12000);
      expect(holdoverAmount({ rate: 12000, tenureMonths, n: 1, settings: s })).toBe(1250);
    }
  });
  it("guards a missing tenure as a 12 month term", () => {
    expect(annualEquivalentRate(12000, 0)).toBe(12000);
  });
});

describe("parseHoldoverSettings", () => {
  it("falls back to defaults", () => {
    expect(parseHoldoverSettings({})).toEqual(DEFAULT_HOLDOVER_SETTINGS);
    expect(parseHoldoverSettings({ vo_holdover_uplift_pct: "abc", vo_holdover_cap_pct: "" })).toEqual(
      DEFAULT_HOLDOVER_SETTINGS,
    );
  });
  it("reads valid values and rejects a zero period", () => {
    expect(
      parseHoldoverSettings({
        vo_holdover_uplift_pct: "30",
        vo_holdover_step_pct: "5",
        vo_holdover_period_months: "2",
        vo_holdover_cap_pct: "50",
      }),
    ).toEqual({ upliftPct: 30, stepPct: 5, periodMonths: 2, capPct: 50 });
    expect(parseHoldoverSettings({ vo_holdover_period_months: "0" }).periodMonths).toBe(3);
  });
});

describe("parseWatchMode", () => {
  it("is off when the setting is missing", () => {
    expect(parseWatchMode(undefined)).toBe("off");
    expect(parseWatchMode(null)).toBe("off");
    expect(parseWatchMode("")).toBe("off");
  });
  it("accepts the three modes", () => {
    expect(parseWatchMode("off")).toBe("off");
    expect(parseWatchMode("dry_run")).toBe("dry_run");
    expect(parseWatchMode("live")).toBe("live");
  });
  it("reads an unrecognised value as dry_run, never live", () => {
    expect(parseWatchMode("LIVE")).toBe("dry_run");
    expect(parseWatchMode("on")).toBe("dry_run");
  });
});

describe("planHoldoverPi", () => {
  const base = {
    latestVerdict: "in_use" as AddressVerdict | null,
    released: false,
    proofVerified: false,
    day: 30,
    existingPiCount: 1,
  };

  it("creates on a cycle day while in use", () => {
    expect(planHoldoverPi(base)).toEqual({ create: true, reason: "create" });
    expect(planHoldoverPi({ ...base, day: 0, existingPiCount: 0 }).create).toBe(true);
    expect(planHoldoverPi({ ...base, latestVerdict: "likely" }).create).toBe(true);
  });
  it("does not create off a cycle day", () => {
    expect(planHoldoverPi({ ...base, day: 31 })).toEqual({ create: false, reason: "not_cycle_day" });
  });
  it("does not create once released or proof is verified", () => {
    expect(planHoldoverPi({ ...base, released: true })).toEqual({ create: false, reason: "released" });
    expect(planHoldoverPi({ ...base, proofVerified: true })).toEqual({
      create: false,
      reason: "proof_verified",
    });
  });
  it("does not create for clear or inconclusive verdicts", () => {
    expect(planHoldoverPi({ ...base, latestVerdict: "clear" }).reason).toBe("not_in_use");
    expect(planHoldoverPi({ ...base, latestVerdict: "inconclusive" }).reason).toBe("not_in_use");
    expect(planHoldoverPi({ ...base, latestVerdict: null }).reason).toBe("no_verdict");
  });
  it("does not create twice for one cycle", () => {
    expect(planHoldoverPi({ ...base, existingPiCount: 2 })).toEqual({
      create: false,
      reason: "already_created",
    });
    expect(planHoldoverPi({ ...base, day: 0, existingPiCount: 1 }).reason).toBe("already_created");
  });
});
