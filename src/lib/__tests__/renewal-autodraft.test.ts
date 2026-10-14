import { describe, it, expect } from "vitest";
import { selectAutodraftTargets, needsValidationNudge, daysUntil, unvalidatedAutoDraftReason } from "../renewal-autodraft";

const mk = (id: string, end_date: string, over: Partial<{ status: string; renewal_declined: boolean }> = {}) => ({
  id, end_date, status: "active", renewal_declined: false, ...over,
});
const TODAY = "2026-10-14";

describe("selectAutodraftTargets", () => {
  it("includes day 0 and day 45, excludes day 46 and the past", () => {
    const got = selectAutodraftTargets(
      [mk("a", "2026-10-14"), mk("b", "2026-11-28"), mk("c", "2026-11-29"), mk("d", "2026-10-13")],
      new Set(), TODAY
    );
    expect(got.map((c) => c.id)).toEqual(["a", "b"]);
  });

  it("skips declined, non-active and already-renewed contracts", () => {
    const got = selectAutodraftTargets(
      [mk("a", "2026-11-01", { renewal_declined: true }), mk("b", "2026-11-01", { status: "renewal_in_progress" }),
       mk("c", "2026-11-01"), mk("d", "2026-11-02")],
      new Set(["c"]), TODAY
    );
    expect(got.map((c) => c.id)).toEqual(["d"]);
  });

  it("caps per run and takes the soonest-ending first", () => {
    const many = Array.from({ length: 8 }, (_, i) => mk(`c${i}`, `2026-11-${String(20 - i).padStart(2, "0")}`));
    const got = selectAutodraftTargets(many, new Set(), TODAY);
    expect(got).toHaveLength(5);
    expect(got[0].end_date <= got[4].end_date).toBe(true);
    expect(got[0].id).toBe("c7");
  });
});

describe("daysUntil", () => {
  it("counts calendar days", () => {
    expect(daysUntil("2026-11-28", "2026-10-14")).toBe(45);
  });
});

describe("needsValidationNudge", () => {
  const base = { renewal_auto_created_at: "2026-10-01T05:00:00Z", renewal_validated_at: null, renewal_validation_nudged_at: null };
  it("nudges after 7 days, once, and never once validated", () => {
    expect(needsValidationNudge(base, new Date("2026-10-07T05:00:00Z"))).toBe(false);
    expect(needsValidationNudge(base, new Date("2026-10-08T05:00:00Z"))).toBe(true);
    expect(needsValidationNudge({ ...base, renewal_validation_nudged_at: "2026-10-08T05:00:00Z" }, new Date("2026-10-20T05:00:00Z"))).toBe(false);
    expect(needsValidationNudge({ ...base, renewal_validated_at: "2026-10-02T05:00:00Z" }, new Date("2026-10-20T05:00:00Z"))).toBe(false);
  });
  it("ignores manual drafts", () => {
    expect(needsValidationNudge({ ...base, renewal_auto_created_at: null }, new Date("2026-12-01T00:00:00Z"))).toBe(false);
  });
});

describe("unvalidatedAutoDraftReason", () => {
  it("blocks only auto-created renewals that nobody has validated", () => {
    expect(unvalidatedAutoDraftReason({ is_renewal: true, renewal_auto_created: true, renewal_validated_at: null })).toMatch(/Validate renewal/);
    expect(unvalidatedAutoDraftReason({ is_renewal: true, renewal_auto_created: true, renewal_validated_at: "2026-10-14T00:00:00Z" })).toBeNull();
    expect(unvalidatedAutoDraftReason({ is_renewal: true, renewal_auto_created: false, renewal_validated_at: null })).toBeNull();
    expect(unvalidatedAutoDraftReason({ is_renewal: false, renewal_auto_created: true, renewal_validated_at: null })).toBeNull();
  });
});
