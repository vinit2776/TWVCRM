"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { hasCommitmentTerms } from "@/lib/proposal-terms";
import {
  COMMITMENT_OVERRIDE_MIN_REASON_LENGTH,
  commitmentEndDate,
  type CommitmentValues,
} from "@/lib/contract-commitment";
import type { Proposal } from "@/types";

/**
 * Prefills and locks a new contract's term / end date / lock-in / notice period
 * from the linked proposal. Shared by CreateContractDialog and the contract
 * onboarding wizard; POST /api/contracts enforces the same rule server-side.
 */
export function useProposalCommitmentLock({
  selectedProposal,
  startDate,
  setTenureMonths,
  setLockInMonths,
  setNoticePeriodMonths,
  setEndDate,
}: {
  selectedProposal: Proposal | null;
  startDate: string;
  setTenureMonths: (v: number) => void;
  setLockInMonths: (v: number) => void;
  setNoticePeriodMonths: (v: number) => void;
  setEndDate: (v: string) => void;
}) {
  // null = following the proposal; a string = admin override in progress.
  const [overrideReason, setOverrideReason] = useState<string | null>(null);
  // Terms recorded on a legacy proposal from inside the form. Kept separately
  // rather than patched into the proposals list so the form's "prefill from
  // proposal" effect doesn't re-run and wipe what the user already entered.
  const [recordedTerms, setRecordedTerms] = useState<Record<string, CommitmentValues>>({});

  const selectedProposalId = selectedProposal?.id;
  useEffect(() => {
    setOverrideReason(null);
  }, [selectedProposalId]);

  const agreedTerms = useMemo<CommitmentValues | null>(() => {
    if (!selectedProposal) return null;
    const merged = { ...selectedProposal, ...recordedTerms[selectedProposal.id] };
    return hasCommitmentTerms(merged)
      ? {
          tenure_months: merged.tenure_months as number,
          lock_in_months: merged.lock_in_months as number,
          notice_period_months: merged.notice_period_months as number,
        }
      : null;
  }, [selectedProposal, recordedTerms]);

  const termsLocked = agreedTerms != null && overrideReason === null;

  // Re-applied whenever the lock is (re)engaged — including cancelling an
  // override — and whenever the start date moves the end date.
  useEffect(() => {
    if (!termsLocked || !agreedTerms) return;
    setTenureMonths(agreedTerms.tenure_months);
    setLockInMonths(agreedTerms.lock_in_months);
    setNoticePeriodMonths(agreedTerms.notice_period_months);
    if (startDate) setEndDate(commitmentEndDate(startDate, agreedTerms.tenure_months));
  }, [termsLocked, agreedTerms, startDate, setTenureMonths, setLockInMonths, setNoticePeriodMonths, setEndDate]);

  const recordTerms = useCallback((proposalId: string, terms: CommitmentValues) => {
    setRecordedTerms((prev) => ({ ...prev, [proposalId]: terms }));
  }, []);

  /** Blocking problem to show on submit, or null. */
  const submitError = useMemo(() => {
    if (!selectedProposal) return null;
    if (!agreedTerms) {
      return `${selectedProposal.proposal_number} has no agreed term, lock-in or notice period recorded. Record the agreed terms first.`;
    }
    if (overrideReason !== null && overrideReason.trim().length < COMMITMENT_OVERRIDE_MIN_REASON_LENGTH) {
      return "Give a reason for overriding the terms agreed on the proposal.";
    }
    return null;
  }, [selectedProposal, agreedTerms, overrideReason]);

  return {
    agreedTerms,
    termsLocked,
    overrideReason,
    setOverrideReason,
    recordTerms,
    submitError,
    /** Value for the request body's commitment_override_reason. */
    overrideReasonForRequest: overrideReason?.trim() || undefined,
  };
}
