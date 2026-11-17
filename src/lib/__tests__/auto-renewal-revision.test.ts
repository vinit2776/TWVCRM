import { describe, it, expect } from "vitest";
import { checkRevision } from "../auto-renewal";

describe("checkRevision", () => {
  it("lets any manager role set a rate at or above the agreement's", () => {
    expect(checkRevision(10, 10, "sales_rep")).toEqual({ ok: true });
    expect(checkRevision(12, 10, "manager")).toEqual({ ok: true });
  });

  it("needs an admin for a rate below the agreement's", () => {
    expect(checkRevision(7, 10, "manager").ok).toBe(false);
    expect(checkRevision(0, 10, "sales_rep").ok).toBe(false);
    expect(checkRevision(7, 10, "admin")).toEqual({ ok: true });
    expect(checkRevision(0, 10, "admin")).toEqual({ ok: true });
  });

  it("rejects values outside 0 to 100 and non-numbers", () => {
    expect(checkRevision(-1, 10, "admin").ok).toBe(false);
    expect(checkRevision(101, 10, "admin").ok).toBe(false);
    expect(checkRevision(Number.NaN, 10, "admin").ok).toBe(false);
  });
});
