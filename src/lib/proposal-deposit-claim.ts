/**
 * A proposal is a configuration template that can, in edge cases, spawn more
 * than one contract (two desks quoted and activated off one shared
 * proposal). Its collected deposit belongs to exactly one of them — see
 * contracts/[id]/route.ts's activation snapshot, which performs the actual
 * atomic claim (DB round-trip, not testable as a pure function) and then
 * calls buildContractDepositSnapshot to shape the fields to write.
 */

export interface ProposalDepositSnapshotSource {
  security_deposit_amount: number | null;
  security_deposit_months: number | null;
  deposit_payment_status: string | null;
  deposit_payment_amount: number | null;
  deposit_payment_reference: string | null;
  deposit_payment_medium: string | null;
  deposit_payment_received_at: string | null;
  deposit_internal_notes: string | null;
}

export interface ContractDepositSnapshotFields {
  security_deposit_amount: number | null;
  security_deposit_months: number | null;
  deposit_payment_status: string | null;
  deposit_payment_amount: number | null;
  deposit_payment_reference: string | null;
  deposit_payment_medium: string | null;
  deposit_payment_received_at: string | null;
  deposit_internal_notes: string | null;
}

/**
 * Builds the contract's deposit snapshot fields at activation.
 *
 * `claimGranted` must be true whenever there's no multi-claim risk to begin
 * with — the proposal's deposit was never paid (not_required, waived, still
 * pending), or this contract already holds the claim, or an atomic claim
 * attempt against `proposal_id` just succeeded. It must be false only when
 * the proposal's deposit is paid AND a different contract already claimed
 * it (or won a concurrent claim race) — in that case this contract needs
 * its own, independent deposit; the requirement (amount/months) still
 * replicates from the shared proposal terms, but the payment does not.
 */
export function buildContractDepositSnapshot(
  proposal: ProposalDepositSnapshotSource,
  claimGranted: boolean
): ContractDepositSnapshotFields {
  const requirement = {
    security_deposit_amount: proposal.security_deposit_amount,
    security_deposit_months: proposal.security_deposit_months,
  };

  if (claimGranted) {
    return {
      ...requirement,
      deposit_payment_status: proposal.deposit_payment_status,
      deposit_payment_amount: proposal.deposit_payment_amount,
      deposit_payment_reference: proposal.deposit_payment_reference,
      deposit_payment_medium: proposal.deposit_payment_medium,
      deposit_payment_received_at: proposal.deposit_payment_received_at,
      deposit_internal_notes: proposal.deposit_internal_notes,
    };
  }

  return {
    ...requirement,
    deposit_payment_status: "pending",
    deposit_payment_amount: null,
    deposit_payment_reference: null,
    deposit_payment_medium: null,
    deposit_payment_received_at: null,
    deposit_internal_notes:
      "This contract shares a proposal whose collected deposit was already claimed by another contract at activation. This contract requires its own separate deposit collection.",
  };
}
