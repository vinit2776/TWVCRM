import { describe, it, expect } from "vitest";
import { canWithdrawContract, CONTRACT_STATUS_TRANSITIONS } from "@/lib/constants";

describe("canWithdrawContract", () => {
  it("allows admin, manager and sales_rep on every pre-activation status", () => {
    for (const status of ["draft", "sent", "viewed", "accepted"]) {
      for (const role of ["admin", "manager", "sales_rep"]) {
        expect(canWithdrawContract({ status }, role)).toBe(true);
      }
    }
  });

  it("rejects other roles", () => {
    for (const role of ["accounts", "floor_manager", "office_admin", null, undefined]) {
      expect(canWithdrawContract({ status: "accepted" }, role)).toBe(false);
    }
  });

  it("does not apply once a contract has been activated or closed", () => {
    for (const status of ["active", "renewal_in_progress", "renewed", "expired", "terminated", "rejected"]) {
      expect(canWithdrawContract({ status }, "admin")).toBe(false);
    }
  });

  it("excludes renewal drafts, which close via Cancel Renewal", () => {
    expect(canWithdrawContract({ status: "draft", is_renewal: true }, "admin")).toBe(false);
  });

  it("every withdrawable status can transition to terminated", () => {
    for (const status of ["draft", "sent", "viewed", "accepted"]) {
      expect(CONTRACT_STATUS_TRANSITIONS[status]).toContain("terminated");
    }
  });
});
