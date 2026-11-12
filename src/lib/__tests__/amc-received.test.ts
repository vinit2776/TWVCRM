import { describe, it, expect } from "vitest";
import { amcNotReceived } from "@/lib/procurement/amc-received";

describe("amcNotReceived", () => {
  it("warns until the item is received", () => {
    for (const status of ["pending", "ordered", "partially_received"]) {
      expect(amcNotReceived({ status })).toBe(true);
    }
  });
  it("is quiet once received, billed, or when terminated", () => {
    for (const status of ["received", "invoice_received", "invoice_approved"]) {
      expect(amcNotReceived({ status })).toBe(false);
    }
    expect(amcNotReceived({ status: "ordered", amc_terminated_at: "2026-11-01T00:00:00Z" })).toBe(false);
  });
});
