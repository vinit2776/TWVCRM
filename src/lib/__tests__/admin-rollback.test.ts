import { describe, it, expect } from "vitest";
import { canRollback, rollbackReasonSchema } from "../procurement/admin-rollback";

describe("canRollback", () => {
  it("allows only admin", () => {
    expect(canRollback("admin")).toBe(true);
    for (const role of ["manager", "accounts", "office_admin", "sales_rep", "fms", "floor_manager"]) {
      expect(canRollback(role)).toBe(false);
    }
  });

  it("refuses a missing role", () => {
    expect(canRollback(null)).toBe(false);
    expect(canRollback(undefined)).toBe(false);
    expect(canRollback("")).toBe(false);
  });
});

describe("rollbackReasonSchema", () => {
  it("requires a real reason", () => {
    expect(rollbackReasonSchema.safeParse("").success).toBe(false);
    expect(rollbackReasonSchema.safeParse("   too short ").success).toBe(false);
  });

  it("accepts and trims a reason of 10+ characters", () => {
    const parsed = rollbackReasonSchema.safeParse("  Paid against the wrong bill  ");
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data).toBe("Paid against the wrong bill");
  });
});
