import { describe, it, expect } from "vitest";
import { loadSettings, settingsVersion } from "@/lib/customer-value/scoring-settings-store";
import { DEFAULT_SCORING_SETTINGS, mergeSettings } from "@/lib/customer-value/scoring-settings";

describe("loadSettings", () => {
  it("uses the defaults when there is no override", () => {
    for (const none of [null, undefined, "", "   "]) {
      const r = loadSettings(none);
      expect(r.settings).toBe(DEFAULT_SCORING_SETTINGS);
      expect(r.warning).toBeNull();
    }
  });

  it("applies a valid override over the defaults", () => {
    const r = loadSettings(JSON.stringify({ weakPillarCap: { below: 35, maxTier: "B" }, weights: { payment: 40 } }));
    expect(r.warning).toBeNull();
    expect(r.settings.weakPillarCap).toEqual({ below: 35, maxTier: "B" });
    expect(r.settings.weights).toEqual({ profitability: 35, payment: 40, engagement: 20, friction: 20 });
  });

  it("falls back to the defaults, and says why, instead of scoring with a broken override", () => {
    const bad = [
      ["{not json", /not valid JSON/],
      ["[1,2]", /must be a JSON object/],
      ["42", /must be a JSON object/],
      [JSON.stringify({ tierCutoffs: { A: 50, B: 60, C: 40 } }), /rejected.*cut-offs/],
      [JSON.stringify({ weights: { profitability: 0, payment: 0, engagement: 0, friction: 0 } }), /rejected/],
    ] as const;
    for (const [text, why] of bad) {
      const r = loadSettings(text);
      expect(r.settings).toBe(DEFAULT_SCORING_SETTINGS);
      expect(r.warning).toMatch(why);
      expect(r.version).toBe(settingsVersion(DEFAULT_SCORING_SETTINGS));
    }
  });
});

describe("settingsVersion", () => {
  it("is stable for equal settings and eight hex characters", () => {
    expect(settingsVersion(DEFAULT_SCORING_SETTINGS)).toMatch(/^[0-9a-f]{8}$/);
    expect(settingsVersion(mergeSettings())).toBe(settingsVersion(DEFAULT_SCORING_SETTINGS));
  });
  it("does not depend on key order", () => {
    const reordered = { ...DEFAULT_SCORING_SETTINGS, weights: { friction: 20, engagement: 20, payment: 25, profitability: 35 } };
    expect(settingsVersion(reordered)).toBe(settingsVersion(DEFAULT_SCORING_SETTINGS));
  });
  it("changes when any setting changes", () => {
    const base = settingsVersion(DEFAULT_SCORING_SETTINGS);
    expect(settingsVersion(mergeSettings({ windowMonths: 9 }))).not.toBe(base);
    expect(settingsVersion(mergeSettings({ weakPillarCap: { below: 35, maxTier: "B" } }))).not.toBe(base);
    expect(settingsVersion(mergeSettings({ tierCutoffs: { A: 80, B: 60, C: 40 } }))).not.toBe(base);
  });
});
