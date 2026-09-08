import { describe, it, expect } from "vitest";
import { parseDuration, formatDuration, MAX_TIME_LOG_MINUTES } from "../facility-ui";

describe("parseDuration", () => {
  it("reads the formats the Log time dialog advertises", () => {
    expect(parseDuration("45m")).toBe(45);
    expect(parseDuration("1h 30m")).toBe(90);
    expect(parseDuration("3d")).toBe(4320);
  });

  it("accepts the long and short spelling of every unit", () => {
    expect(parseDuration("1hr 30min")).toBe(90);
    expect(parseDuration("1hour 30minutes")).toBe(90);
    expect(parseDuration("2 days")).toBe(2880);
  });

  it("accepts fractions, H:MM, and a bare number as minutes", () => {
    expect(parseDuration("1.5h")).toBe(90);
    expect(parseDuration("0:30")).toBe(30);
    expect(parseDuration("1:30")).toBe(90);
    expect(parseDuration("90")).toBe(90);
  });

  it("ignores surrounding whitespace and case", () => {
    expect(parseDuration("  2H  ")).toBe(120);
  });

  it("rejects input with no duration in it", () => {
    expect(parseDuration("abc")).toBeNull();
    expect(parseDuration("")).toBeNull();
    expect(parseDuration("   ")).toBeNull();
    expect(parseDuration("5x")).toBeNull();
  });

  it("rejects zero and negatives rather than logging them", () => {
    expect(parseDuration("0")).toBeNull();
    expect(parseDuration("0m")).toBeNull();
    // The unit regex can't capture a leading "-", so without the explicit
    // guard "-5m" would parse as +5.
    expect(parseDuration("-5m")).toBeNull();
  });

  it("returns null, not 0, for a duration that rounds away", () => {
    // Rounding has to happen before the >0 test. Returning 0 here would be a
    // value the API then rejects with a confusing "must be positive" 400.
    expect(parseDuration("0.4m")).toBeNull();
    expect(parseDuration("0.2m")).toBeNull();
  });

  it("rejects an out-of-range H:MM minute component", () => {
    expect(parseDuration("1:60")).toBeNull();
  });

  it("parses durations far above the log cap — the bound is the caller's job", () => {
    // parseDuration answers "is this a duration"; MAX_TIME_LOG_MINUTES answers
    // "is it a sane single entry". Keeping them separate lets the UI word the
    // two failures differently.
    expect(parseDuration("1000d")).toBe(1440000);
    expect(parseDuration("1000d")!).toBeGreaterThan(MAX_TIME_LOG_MINUTES);
  });
});

describe("MAX_TIME_LOG_MINUTES", () => {
  it("allows a realistic long entry but blocks a fat-fingered one", () => {
    expect(parseDuration("3d")!).toBeLessThanOrEqual(MAX_TIME_LOG_MINUTES);
    expect(parseDuration("30d")!).toBeLessThanOrEqual(MAX_TIME_LOG_MINUTES);
    expect(parseDuration("31d")!).toBeGreaterThan(MAX_TIME_LOG_MINUTES);
  });

  it("stays inside a Postgres INTEGER, which the minutes column is", () => {
    expect(MAX_TIME_LOG_MINUTES).toBeLessThan(2_147_483_647);
    // The value that motivated the cap: "9999999d" overflows the column and
    // surfaces as a raw 500 rather than a validation error.
    expect(parseDuration("9999999d")!).toBeGreaterThan(2_147_483_647);
  });
});

describe("formatDuration round-trips what parseDuration produces", () => {
  it("renders totals the way the Time spent section shows them", () => {
    expect(formatDuration(parseDuration("45m"))).toBe("45m");
    expect(formatDuration(parseDuration("1h 30m"))).toBe("1h 30m");
    expect(formatDuration(parseDuration("3d"))).toBe("3d");
  });
});
