import { describe, expect, it } from "vitest";
import {
  buildHoldoverStatementRow,
  cycleFromReference,
  daysSinceLapse,
  decideHoldover,
  holdoverReference,
  isHoldoverClauseApproved,
} from "@/lib/vo-holdover-pi";
import {
  dayOffsetFrom,
  isMissingSchema,
  isProofRecorded,
  verdictForFinding,
  addressCheckSchema,
} from "@/lib/vo-address-evidence";
import { DEFAULT_HOLDOVER_SETTINGS } from "@/lib/vo-address-watch";

const base = { lapsedAt: "2026-01-01", today: "2026-01-01", latestVerdict: "in_use" as const, released: false, proofVerified: false, existingCycles: [] as number[] };

describe("decideHoldover", () => {
  it("creates cycle 1 on the lapse day when in use", () => {
    expect(decideHoldover(base)).toEqual({ create: true, cycle: 1 });
  });
  it("catches up the current cycle on a later day", () => {
    expect(decideHoldover({ ...base, today: "2026-02-05" })).toEqual({ create: true, cycle: 2 });
  });
  it("is idempotent per cycle", () => {
    expect(decideHoldover({ ...base, today: "2026-02-05", existingCycles: [1, 2] })).toEqual({ create: false, reason: "already_created" });
  });
  it("stops on release, proof, or a clear verdict", () => {
    expect(decideHoldover({ ...base, released: true })).toMatchObject({ create: false, reason: "released" });
    expect(decideHoldover({ ...base, proofVerified: true })).toMatchObject({ create: false, reason: "proof_verified" });
    expect(decideHoldover({ ...base, latestVerdict: "clear" })).toMatchObject({ create: false, reason: "not_in_use" });
    expect(decideHoldover({ ...base, latestVerdict: null })).toMatchObject({ create: false, reason: "no_verdict" });
  });
});

describe("holdover statement row", () => {
  const c = { id: "c1", case_number: "CASE-2611-0042", rate: 12000, tenure_months: 12, lapsed_at: "2026-01-01T05:00:00Z" };
  it("keeps Qty x Rate = Amount and totals", () => {
    const r = buildHoldoverStatementRow(c, 1, DEFAULT_HOLDOVER_SETTINGS, "2026-01-01");
    const item = r.line_items[0].items[0];
    expect(item.quantity * item.rate).toBe(item.amount);
    expect(item.amount).toBe(1250); // 1000 monthly + 25%
    expect(r.total_amount).toBe(1250 + 225);
    expect(r.status).toBe("draft");
    expect(r.statement_type).toBe("vo_holdover");
    expect(r.reference_note).toBe("TWV-HO-26110042-C1");
  });
  it("escalates and moves the period", () => {
    const r = buildHoldoverStatementRow(c, 4, DEFAULT_HOLDOVER_SETTINGS, "2026-04-01");
    expect(r.fixed_amount).toBe(1350); // +35%
    expect(r.period_start).toBe("2026-04-01");
    expect(r.period_end).toBe("2026-04-30");
  });
});

describe("helpers", () => {
  it("references round trip", () => {
    expect(cycleFromReference(holdoverReference("CASE-1-7", 3))).toBe(3);
    expect(cycleFromReference(null)).toBeNull();
  });
  it("clause approval is strict", () => {
    expect(isHoldoverClauseApproved("true")).toBe(true);
    expect(isHoldoverClauseApproved("false")).toBe(false);
    expect(isHoldoverClauseApproved(undefined)).toBe(false);
  });
  it("day counts", () => {
    expect(daysSinceLapse("2026-01-01T10:00:00Z", "2026-01-31")).toBe(30);
    expect(dayOffsetFrom("2026-01-10", "2026-01-01")).toBe(0);
  });
  it("verdicts by source strength", () => {
    expect(verdictForFinding("found_using", "gst_portal")).toBe("in_use");
    expect(verdictForFinding("found_using", "website")).toBe("likely");
    expect(verdictForFinding("not_found", "mca")).toBe("clear");
    expect(verdictForFinding("not_found", "reception")).toBe("inconclusive");
  });
  it("proof detection and schema errors", () => {
    expect(isProofRecorded([{ raw: { finding: "deregistration_proof_received" } }])).toBe(true);
    expect(isProofRecorded([{ raw: {} }, { raw: null }])).toBe(false);
    expect(isMissingSchema({ code: "42P01" })).toBe(true);
    expect(isMissingSchema({ code: "23505" })).toBe(false);
  });
  it("treats a PostgREST schema-cache miss as not migrated yet", () => {
    expect(isMissingSchema({ code: "PGRST205" })).toBe(true);
    expect(isMissingSchema({ code: "PGRST204" })).toBe(true);
    expect(isMissingSchema({ code: "42501" })).toBe(false);
  });
  it("validates the check form", () => {
    expect(addressCheckSchema.safeParse({ source: "mca", finding: "not_found", checked_on: "2026-01-02", note: "Checked MCA" }).success).toBe(true);
    expect(addressCheckSchema.safeParse({ source: "x", finding: "not_found", checked_on: "2026-01-02", note: "Checked MCA" }).success).toBe(false);
  });
});
