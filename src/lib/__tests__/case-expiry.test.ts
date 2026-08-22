import { describe, it, expect } from "vitest";
import { caseExpiry, expiryRowClass } from "@/lib/case-expiry";

const NOW = new Date("2026-08-22T10:00:00Z");
const on = (end: string, status = "active") => caseExpiry({ status, end_date: end }, NOW);

describe("caseExpiry — tiers on a live agreement", () => {
  it("is comfortable beyond 30 days", () => {
    const e = on("2027-01-23");
    expect(e.tone).toBe("ok");
    expect(e.relative).toBe("in 154 days");
    expect(e.highlight).toBe(false);
  });

  it("is amber inside 30 days", () => {
    expect(on("2026-09-18").tone).toBe("soon");
    expect(on("2026-09-21").tone).toBe("soon"); // exactly 30
  });

  it("is red inside 7 days", () => {
    expect(on("2026-08-29").tone).toBe("urgent"); // exactly 7
    expect(on("2026-08-24").tone).toBe("urgent");
  });

  it("treats the expiry day itself as urgent, not expired", () => {
    const e = on("2026-08-22");
    expect(e.tone).toBe("urgent");
    expect(e.relative).toBe("expires today");
  });

  it("is past once the date has gone", () => {
    const e = on("2026-08-14");
    expect(e.tone).toBe("past");
    expect(e.relative).toBe("expired 8 days ago");
    expect(e.highlight).toBe(true);
  });

  it("singularises one day", () => {
    expect(on("2026-08-23").relative).toBe("in 1 day");
    expect(on("2026-08-21").relative).toBe("expired 1 day ago");
  });
});

describe("caseExpiry — cases whose agreement never went live", () => {
  it("reports a projection, never an expiry, for a pre-active case", () => {
    // TWV-CASE-0016: real case, end_date 53 days in the past, still at
    // docs_received. It must never read as expired.
    const e = caseExpiry({ status: "docs_received", end_date: "2026-06-30" }, NOW);
    expect(e.tone).toBe("projected");
    expect(e.relative).toBe("not started");
    expect(e.highlight).toBe(false);
  });

  it("does not highlight an invoiced-but-unexecuted case", () => {
    expect(caseExpiry({ status: "invoiced", end_date: "2026-08-25" }, NOW).highlight).toBe(false);
  });

  it("stops highlighting once a case has formally lapsed", () => {
    // Terminal state — a permanently red row for a closed case is noise.
    const e = caseExpiry({ status: "lapsed", end_date: "2026-07-01" }, NOW);
    expect(e.tone).toBe("projected");
    expect(e.highlight).toBe(false);
  });

  it("still highlights through the grace period", () => {
    expect(caseExpiry({ status: "grace_period", end_date: "2026-08-18" }, NOW).tone).toBe("past");
  });

  it("handles a missing end_date", () => {
    const e = caseExpiry({ status: "active", end_date: null }, NOW);
    expect(e.daysRemaining).toBeNull();
    expect(e.relative).toBe("—");
    expect(e.highlight).toBe(false);
  });
});

describe("expiryRowClass", () => {
  it("tints only the tones that warrant it", () => {
    expect(expiryRowClass("past")).not.toBe("");
    expect(expiryRowClass("urgent")).not.toBe("");
    expect(expiryRowClass("soon")).not.toBe("");
    expect(expiryRowClass("ok")).toBe("");
    expect(expiryRowClass("projected")).toBe("");
  });
});
