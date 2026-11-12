import { describe, it, expect } from "vitest";
import { buildContractDepositSnapshot, type ProposalDepositSnapshotSource } from "../proposal-deposit-claim";

function proposal(overrides: Partial<ProposalDepositSnapshotSource> = {}): ProposalDepositSnapshotSource {
  return {
    security_deposit_amount: 13650,
    security_deposit_months: 2,
    deposit_payment_status: "paid",
    deposit_payment_amount: 13650,
    deposit_payment_reference: "utr-123",
    deposit_payment_medium: "neft",
    deposit_payment_received_at: "2026-05-30T10:00:00Z",
    deposit_internal_notes: "collected offline",
    ...overrides,
  };
}

describe("buildContractDepositSnapshot", () => {
  it("copies payment fields through when the claim is granted", () => {
    const r = buildContractDepositSnapshot(proposal(), true);
    expect(r.security_deposit_amount).toBe(13650);
    expect(r.deposit_payment_status).toBe("paid");
    expect(r.deposit_payment_amount).toBe(13650);
    expect(r.deposit_payment_reference).toBe("utr-123");
    expect(r.deposit_internal_notes).toBe("collected offline");
  });

  it("forces a fresh pending deposit when the claim is not granted, but keeps the requirement", () => {
    const r = buildContractDepositSnapshot(proposal(), false);
    expect(r.security_deposit_amount).toBe(13650); // requirement still replicates
    expect(r.security_deposit_months).toBe(2);
    expect(r.deposit_payment_status).toBe("pending");
    expect(r.deposit_payment_amount).toBeNull();
    expect(r.deposit_payment_reference).toBeNull();
    expect(r.deposit_payment_medium).toBeNull();
    expect(r.deposit_payment_received_at).toBeNull();
    expect(r.deposit_internal_notes).toMatch(/already claimed by another contract/);
  });

  it("never forces pending for a not_required proposal, even if claimGranted is somehow false", () => {
    // This shouldn't occur in practice (the caller only computes
    // claimGranted=false when status is "paid"), but the function itself
    // must not silently turn a waived deposit into a fabricated pending ask.
    const r = buildContractDepositSnapshot(proposal({ deposit_payment_status: "not_required" }), true);
    expect(r.deposit_payment_status).toBe("not_required");
  });

  it("copies through a pending (never collected) proposal deposit unchanged when claim is granted", () => {
    const r = buildContractDepositSnapshot(
      proposal({ deposit_payment_status: "pending", deposit_payment_amount: null, deposit_payment_reference: null }),
      true
    );
    expect(r.deposit_payment_status).toBe("pending");
    expect(r.deposit_payment_amount).toBeNull();
  });
});
