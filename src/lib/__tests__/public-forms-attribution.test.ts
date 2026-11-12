import { describe, it, expect } from "vitest";
import { sanitiseAttribution, describeAttribution } from "../public-forms/attribution";

describe("sanitiseAttribution", () => {
  it("keeps only whitelisted string keys", () => {
    expect(
      sanitiseAttribution({ utm_source: " meta ", gclid: "abc", evil: "x", utm_medium: 5 })
    ).toEqual({ utm_source: "meta", gclid: "abc" });
  });
  it("caps long values and drops empty ones", () => {
    const out = sanitiseAttribution({ utm_campaign: "a".repeat(900), utm_term: "   " });
    expect(out.utm_campaign).toHaveLength(500);
    expect(out.utm_term).toBeUndefined();
  });
  it("never throws on junk input", () => {
    for (const bad of [null, undefined, "str", 42, []]) expect(sanitiseAttribution(bad)).toEqual({});
  });
});

describe("describeAttribution", () => {
  it("prefers campaign and channel", () => {
    expect(describeAttribution({ utm_campaign: "diwali", utm_source: "meta", utm_medium: "paid" })).toBe(
      "diwali · meta / paid"
    );
  });
  it("falls back to click ids", () => {
    expect(describeAttribution({ gclid: "g" })).toBe("Google Ads click");
    expect(describeAttribution({ fbclid: "f" })).toBe("Meta Ads click");
  });
  it("returns null when there is nothing", () => {
    expect(describeAttribution({})).toBeNull();
    expect(describeAttribution(null)).toBeNull();
  });
});
