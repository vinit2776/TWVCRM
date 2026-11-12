import { describe, it, expect } from "vitest";
import { backfillBodySchema } from "@/lib/customer-value/snapshot-backfill-schema";

const UUID = "6377f789-da38-4354-9ee5-1bb2842a4558";

describe("backfill body: fails safe", () => {
  it("treats an empty body as a dry run", () => {
    expect(backfillBodySchema.parse({})).toEqual({ limit: 25, scores: "none", dry_run: true });
  });

  it("stays a dry run when the body only chooses customers", () => {
    const body = backfillBodySchema.parse({ lead_id: UUID, limit: 5, after: UUID });
    expect(body.dry_run).toBe(true);
  });

  it("writes only when dry_run is explicitly the boolean false", () => {
    expect(backfillBodySchema.parse({ dry_run: false }).dry_run).toBe(false);
    expect(backfillBodySchema.parse({ dry_run: true }).dry_run).toBe(true);
  });

  it("rejects a mistyped flag instead of ignoring it and defaulting", () => {
    // The 1 September 2026 failure: `dryRun` was ignored and the run went live.
    for (const typo of ["dryRun", "dryrun", "dry-run", "DRY_RUN", "dry_run_", "write", "live"]) {
      const result = backfillBodySchema.safeParse({ [typo]: false });
      expect(result.success, `"${typo}" should be rejected`).toBe(false);
    }
  });

  it("rejects values that only look like false", () => {
    for (const value of ["false", "no", 0, null, "0", []]) {
      expect(backfillBodySchema.safeParse({ dry_run: value }).success).toBe(false);
    }
  });

  it("rejects any unknown key alongside valid ones", () => {
    expect(backfillBodySchema.safeParse({ dry_run: true, extra: 1 }).success).toBe(false);
  });
});

describe("backfill body: other fields", () => {
  it("bounds the page size", () => {
    expect(backfillBodySchema.safeParse({ limit: 0 }).success).toBe(false);
    expect(backfillBodySchema.safeParse({ limit: 101 }).success).toBe(false);
    expect(backfillBodySchema.safeParse({ limit: 2.5 }).success).toBe(false);
    expect(backfillBodySchema.safeParse({ limit: "10" }).success).toBe(false);
    expect(backfillBodySchema.parse({ limit: 100 }).limit).toBe(100);
    expect(backfillBodySchema.parse({ limit: 1 }).limit).toBe(1);
  });

  it("needs real ids", () => {
    expect(backfillBodySchema.safeParse({ lead_id: "not-a-uuid" }).success).toBe(false);
    expect(backfillBodySchema.safeParse({ after: "123" }).success).toBe(false);
    expect(backfillBodySchema.safeParse({ lead_id: UUID }).success).toBe(true);
  });
});

describe("backfill body: scores option", () => {
  it("defaults to no scores and accepts only the three modes", () => {
    expect(backfillBodySchema.parse({}).scores).toBe("none");
    for (const m of ["none", "latest", "history"]) expect(backfillBodySchema.parse({ scores: m }).scores).toBe(m);
    for (const bad of ["all", "HISTORY", true, 1, null]) expect(backfillBodySchema.safeParse({ scores: bad }).success).toBe(false);
  });
  it("never writes just because scores were asked for", () => {
    expect(backfillBodySchema.parse({ scores: "history" }).dry_run).toBe(true);
  });
});
