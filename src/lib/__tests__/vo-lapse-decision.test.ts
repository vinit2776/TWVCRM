import { describe, it, expect } from "vitest";
import {
  checkMoreTime,
  extensionsUsed,
  lapseDecisions,
  latestGraceDate,
  latestLapseDecision,
} from "@/lib/vo-lapse-decision";

const TODAY = "2026-10-21";

describe("checkMoreTime", () => {
  it("accepts a date up to 15 days out", () => {
    expect(checkMoreTime({ today: TODAY, until: "2026-10-22", used: 0 })).toBeNull();
    expect(checkMoreTime({ today: TODAY, until: latestGraceDate(TODAY), used: 1 })).toBeNull();
    expect(latestGraceDate(TODAY)).toBe("2026-11-05");
  });

  it("refuses today, the past, and more than 15 days", () => {
    expect(checkMoreTime({ today: TODAY, until: TODAY, used: 0 })).toMatch(/after today/);
    expect(checkMoreTime({ today: TODAY, until: "2026-10-01", used: 0 })).toMatch(/after today/);
    expect(checkMoreTime({ today: TODAY, until: "2026-11-06", used: 0 })).toMatch(/15 days/);
  });

  it("allows at most two extensions per term", () => {
    expect(checkMoreTime({ today: TODAY, until: "2026-10-25", used: 2 })).toMatch(/2 times/);
  });
});

describe("decision history", () => {
  const metadata = {
    other: 1,
    lapse_decisions: [
      { decision: "more_time", reason: "Client travelling", until: "2026-10-25", by: "u1", by_name: "A", at: "x" },
      { decision: "paid", reason: "Paid by NEFT today", by: "u1", by_name: "A", at: "y" },
    ],
  };

  it("reads decisions and counts extensions", () => {
    expect(lapseDecisions(metadata)).toHaveLength(2);
    expect(extensionsUsed(metadata)).toBe(1);
    expect(latestLapseDecision(metadata)?.decision).toBe("paid");
  });

  it("copes with no metadata", () => {
    expect(lapseDecisions(null)).toEqual([]);
    expect(lapseDecisions({ lapse_decisions: "junk" })).toEqual([]);
    expect(latestLapseDecision(undefined)).toBeNull();
    expect(extensionsUsed([])).toBe(0);
  });
});
