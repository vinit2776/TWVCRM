import { describe, it, expect } from "vitest";
import { channelFunnel, channelVerdict, proratedSpend, reachedBy, sourceLabel, trustLines, TOO_FEW_TO_JUDGE, type ChannelLead } from "../channels-report";

const lead = (over: Partial<ChannelLead> = {}): ChannelLead => ({ source: "meta_ads", createdAt: "2026-11-01T06:00:00Z", status: "new", firstTouchAt: null, reached: false, hasTour: false, hasProposal: false, won: false, ...over });
const many = (n: number, over: Partial<ChannelLead> = {}) => Array.from({ length: n }, () => lead(over));

describe("channelVerdict", () => {
  const v = (r: Partial<{ enquiries: number; junkRate: number; winRate: number }>) => channelVerdict({ enquiries: 40, junkRate: 0.05, winRate: 0.05, ...r }, 30, 0.05);
  it("won't judge a small channel", () => {
    expect(v({ enquiries: TOO_FEW_TO_JUDGE - 1 }).key).toBe("too_few");
    expect(v({ enquiries: TOO_FEW_TO_JUDGE }).key).not.toBe("too_few");
  });
  it("flags too much junk first", () => expect(v({ junkRate: 0.3, winRate: 0.2 }).key).toBe("too_much_junk"));
  it("backs a clear winner with little junk", () => expect(v({ winRate: 0.08, junkRate: 0.05 }).key).toBe("grow"));
  it("flags a big channel that converts poorly", () => expect(v({ enquiries: 40, winRate: 0.02 }).key).toBe("fix"));
  it("keeps a decent one and watches the rest", () => {
    expect(v({ winRate: 0.045 }).key).toBe("keep");
    expect(v({ enquiries: 20, winRate: 0.02 }).key).toBe("watch");
  });
});

describe("proratedSpend", () => {
  const promo = { source: "meta_ads", startsOn: "2026-11-01", endsOn: "2026-11-10", spend: 10000 };
  it("counts the whole spend when the period covers the promotion", () => expect(proratedSpend(promo, "2026-10-01", "2026-11-30", "2026-11-22")).toBe(10000));
  it("counts only the overlapping days", () => expect(proratedSpend(promo, "2026-11-06", "2026-11-30", "2026-11-22")).toBe(5000));
  it("is zero outside the period or with no spend", () => {
    expect(proratedSpend(promo, "2026-12-01", "2026-12-31", "2026-12-05")).toBe(0);
    expect(proratedSpend({ ...promo, spend: null }, "2026-10-01", "2026-11-30", "2026-11-22")).toBe(0);
  });
  it("counts a promotion still running up to today", () => {
    expect(proratedSpend({ source: "meta_ads", startsOn: "2026-11-01", endsOn: null, spend: 2200 }, "2026-11-01", "2026-11-30", "2026-11-22")).toBe(2200);
    expect(proratedSpend({ source: "meta_ads", startsOn: "2026-11-01", endsOn: null, spend: 2200 }, "2026-11-12", "2026-11-30", "2026-11-22")).toBeCloseTo(1100, 0);
  });
});

describe("channelFunnel", () => {
  const leads = [
    ...many(10, { source: "meta_ads", status: "junk" }),
    ...many(10, { source: "meta_ads", reached: true, hasTour: true, hasProposal: true, won: true, firstTouchAt: "2026-11-01T07:00:00Z" }),
    ...many(4, { source: "walkin", reached: true }),
  ];
  const rows = channelFunnel(leads, [{ source: "meta_ads", startsOn: "2026-11-01", endsOn: "2026-11-10", spend: 40000 }], "2026-11-01", "2026-11-30", "2026-11-22");
  it("builds the funnel per source, biggest first", () => {
    expect(rows.map((r) => r.source)).toEqual(["meta_ads", "walkin"]);
    expect(rows[0]).toMatchObject({ enquiries: 20, junk: 10, reached: 10, tours: 10, proposals: 10, won: 10, junkRate: 0.5, winRate: 0.5 });
  });
  it("works out first contact and cost per win", () => {
    expect(rows[0].firstContactMinutes).toBe(60);
    expect(rows[0].spend).toBe(40000);
    expect(rows[0].costPerWin).toBe(4000);
    expect(rows[1].costPerWin).toBeNull();
  });
  it("gives each a verdict, and a small channel none", () => {
    expect(rows[0].verdict.key).toBe("too_much_junk");
    expect(rows[1].verdict.key).toBe("too_few");
  });
});

describe("reachedBy", () => {
  it("does not count a missed call or the system's notes", () => {
    expect(reachedBy({ type: "call", callOutcome: "no_answer" })).toBe(false);
    expect(reachedBy({ type: "call", callOutcome: "voicemail" })).toBe(false);
    expect(reachedBy({ type: "note", subject: "Claimed" })).toBe(false);
  });
  it("counts a connected call, a meeting, an email and a tour", () => {
    expect(reachedBy({ type: "call", callOutcome: "connected" })).toBe(true);
    expect(reachedBy({ type: "call", callOutcome: "callback_scheduled" })).toBe(true);
    for (const t of ["meeting", "email", "tour"]) expect(reachedBy({ type: t })).toBe(true);
  });
});

describe("sourceLabel", () => {
  it("uses the known label, or makes the raw one readable", () => {
    expect(sourceLabel("meta_ads", { meta_ads: "Meta Ads" })).toBe("Meta Ads");
    expect(sourceLabel("online_form", {})).toBe("Online form");
    expect(sourceLabel("other", {})).toBe("Other");
    expect(sourceLabel("", {})).toBe("Unknown");
  });
});

describe("trustLines", () => {
  const facts = { tooFewChannels: 0, totalChannels: 5, untracedDeals: 0, tracedDeals: 4, untouched: 2, enquiries: 100, adChannelsWithoutSpend: [] };
  it("reads all good when nothing is off", () => expect(trustLines(facts).every((l) => l.tone === "good")).toBe(true));
  it("warns about untraced deals, small channels, untouched enquiries and missing spend", () => {
    const lines = trustLines({ ...facts, untracedDeals: 3, tooFewChannels: 2, untouched: 40, adChannelsWithoutSpend: ["Meta Ads"] });
    expect(lines.filter((l) => l.tone === "warn")).toHaveLength(4);
    expect(lines[0].detail).toContain("3 contracts activated");
  });
});
