import { describe, it, expect } from "vitest";
import { commitmentEndDate, resolveContractCommitment } from "../contract-commitment";

const proposal = { proposal_number: "PROP-0342", tenure_months: 12, lock_in_months: 11, notice_period_months: 2 };
const agreed = { tenure_months: 12, lock_in_months: 11, notice_period_months: 2 };

describe("resolveContractCommitment", () => {
  it("blocks a proposal that has no agreed terms recorded", () => {
    const r = resolveContractCommitment({ proposal: { proposal_number: "PROP-0298" }, submitted: agreed, isAdmin: true });
    expect(r).toMatchObject({ ok: false, status: 400 });
    expect(!r.ok && r.error).toMatch(/PROP-0298 has no agreed term/);
  });

  it("uses the proposal's terms when the contract matches", () => {
    expect(resolveContractCommitment({ proposal, submitted: agreed, isAdmin: false })).toEqual({
      ok: true,
      values: agreed,
      overridden: false,
    });
  });

  it("falls back to the proposal for fields the client didn't send", () => {
    const r = resolveContractCommitment({ proposal, submitted: {}, isAdmin: false });
    expect(r).toEqual({ ok: true, values: agreed, overridden: false });
  });

  it("rejects a mismatch without an override reason, naming the difference", () => {
    const r = resolveContractCommitment({ proposal, submitted: { ...agreed, lock_in_months: 9 }, isAdmin: true });
    expect(r).toMatchObject({ ok: false, status: 400 });
    expect(!r.ok && r.error).toContain("lock-in 11 → 9 months");
  });

  it("forbids non-admins from overriding even with a reason", () => {
    const r = resolveContractCommitment({
      proposal,
      submitted: { ...agreed, lock_in_months: 9 },
      overrideReason: "Customer renegotiated on call",
      isAdmin: false,
    });
    expect(r).toMatchObject({ ok: false, status: 403 });
  });

  it("requires a meaningful reason", () => {
    const r = resolveContractCommitment({ proposal, submitted: { ...agreed, lock_in_months: 9 }, overrideReason: "ok", isAdmin: true });
    expect(r).toMatchObject({ ok: false, status: 400 });
  });

  it("still validates overridden values", () => {
    const r = resolveContractCommitment({
      proposal,
      submitted: { tenure_months: 6, lock_in_months: 9, notice_period_months: 2 },
      overrideReason: "Customer renegotiated on call",
      isAdmin: true,
    });
    expect(r).toMatchObject({ ok: false, status: 400 });
  });

  it("lets an admin override with a reason", () => {
    const values = { ...agreed, lock_in_months: 9 };
    expect(
      resolveContractCommitment({ proposal, submitted: values, overrideReason: "Customer renegotiated on call", isAdmin: true })
    ).toEqual({ ok: true, values, overridden: true });
  });

  it("ignores a reason when nothing actually differs", () => {
    const r = resolveContractCommitment({ proposal, submitted: agreed, overrideReason: "Just in case, no change", isAdmin: true });
    expect(r).toEqual({ ok: true, values: agreed, overridden: false });
  });
});

describe("commitmentEndDate", () => {
  it("ends the day before the same date N months later", () => {
    expect(commitmentEndDate("2026-10-01", 12)).toBe("2027-09-30");
    expect(commitmentEndDate("2026-09-16", 11)).toBe("2027-08-15");
  });

  it("clamps month-end starts instead of rolling into the next month", () => {
    expect(commitmentEndDate("2026-01-31", 1)).toBe("2026-02-27");
    expect(commitmentEndDate("2027-08-31", 6)).toBe("2028-02-28");
  });
});
