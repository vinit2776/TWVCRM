import { describe, it, expect } from "vitest";
import { canDelegateTo, computeSlaTarget, computeClaimSlaTarget } from "../facility";

describe("canDelegateTo", () => {
  it("allows delegating to an active user", () => {
    expect(canDelegateTo({ is_active: true })).toBe(true);
  });

  it("blocks delegating to an inactive user", () => {
    expect(canDelegateTo({ is_active: false })).toBe(false);
  });

  it("blocks delegating when the assignee is missing (null)", () => {
    expect(canDelegateTo(null)).toBe(false);
  });

  it("blocks delegating when the assignee is missing (undefined)", () => {
    expect(canDelegateTo(undefined)).toBe(false);
  });
});

describe("computeSlaTarget", () => {
  const zeroHours = {
    default_sla_critical_hrs: 0,
    default_sla_high_hrs: 0,
    default_sla_medium_hrs: 0,
    default_sla_low_hrs: 0,
  };

  it("falls back to hardcoded defaults when category hours are all zero (no category linked)", () => {
    const reportedAt = new Date("2026-01-01T00:00:00.000Z");
    expect(computeSlaTarget(zeroHours, "critical", reportedAt)).toBe("2026-01-01T02:00:00.000Z");
    expect(computeSlaTarget(zeroHours, "high", reportedAt)).toBe("2026-01-01T08:00:00.000Z");
    expect(computeSlaTarget(zeroHours, "medium", reportedAt)).toBe("2026-01-02T00:00:00.000Z");
    expect(computeSlaTarget(zeroHours, "low", reportedAt)).toBe("2026-01-04T00:00:00.000Z");
  });

  it("uses category-specific hours when present", () => {
    const reportedAt = new Date("2026-01-01T00:00:00.000Z");
    const category = {
      default_sla_critical_hrs: 1,
      default_sla_high_hrs: 4,
      default_sla_medium_hrs: 12,
      default_sla_low_hrs: 48,
    };
    expect(computeSlaTarget(category, "critical", reportedAt)).toBe("2026-01-01T01:00:00.000Z");
    expect(computeSlaTarget(category, "low", reportedAt)).toBe("2026-01-03T00:00:00.000Z");
  });
});

describe("computeClaimSlaTarget", () => {
  it("uses hardcoded claim targets regardless of category", () => {
    const reportedAt = new Date("2026-01-01T00:00:00.000Z");
    expect(computeClaimSlaTarget("critical", reportedAt)).toBe("2026-01-01T02:00:00.000Z");
    expect(computeClaimSlaTarget("low", reportedAt)).toBe("2026-01-02T00:00:00.000Z");
  });
});
