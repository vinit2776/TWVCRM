"use client";

import { useState } from "react";
import { AlertTriangle, Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { RecordCommitmentTermsDialog } from "@/components/proposals/record-commitment-terms-dialog";
import { RECORD_COMMITMENT_TERMS_ROLES, describeCommitment, type CommitmentValues } from "@/lib/contract-commitment";
import type { Proposal } from "@/types";

/**
 * Status line under a contract form's commercial terms: locked to the
 * proposal, an admin override in progress, or blocked because a legacy
 * proposal has no agreed terms. Pairs with useProposalCommitmentLock.
 */
export function ProposalCommitmentPanel({
  proposal,
  agreedTerms,
  overrideReason,
  onOverrideReasonChange,
  onTermsRecorded,
  userRole,
}: {
  proposal: Proposal | null;
  agreedTerms: CommitmentValues | null;
  overrideReason: string | null;
  onOverrideReasonChange: (reason: string | null) => void;
  onTermsRecorded: (proposalId: string, terms: CommitmentValues) => void;
  userRole: string | null | undefined;
}) {
  const [recordOpen, setRecordOpen] = useState(false);
  if (!proposal) return null;

  if (!agreedTerms) {
    const canRecord = !!userRole && (RECORD_COMMITMENT_TERMS_ROLES as readonly string[]).includes(userRole);
    return (
      <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
        <div className="flex items-start gap-2">
          <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
          <div className="space-y-2">
            <p className="font-medium">{proposal.proposal_number} has no agreed term, lock-in or notice period recorded</p>
            <p className="text-xs">
              {canRecord
                ? "Record what the customer agreed before creating the contract."
                : "Ask an admin, manager or sales rep to record what the customer agreed before creating the contract."}
            </p>
            {canRecord && (
              <Button type="button" size="sm" variant="outline" onClick={() => setRecordOpen(true)}>
                Record agreed terms
              </Button>
            )}
          </div>
        </div>
        <RecordCommitmentTermsDialog
          proposalId={proposal.id}
          proposalNumber={proposal.proposal_number}
          open={recordOpen}
          onOpenChange={setRecordOpen}
          onRecorded={(terms) => onTermsRecorded(proposal.id, terms)}
        />
      </div>
    );
  }

  if (overrideReason === null) {
    return (
      <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground">
        <Lock className="h-3 w-3" />
        Term, end date, lock-in and notice period follow {proposal.proposal_number} ({describeCommitment(agreedTerms)}).
        {userRole === "admin" && (
          <button type="button" className="text-primary underline" onClick={() => onOverrideReasonChange("")}>
            Override terms
          </button>
        )}
      </p>
    );
  }

  return (
    <div className="rounded-md border border-amber-200 bg-amber-50 p-3 space-y-2 text-amber-900">
      <p className="flex items-start gap-2 text-sm">
        <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
        Overriding the terms agreed on {proposal.proposal_number} ({describeCommitment(agreedTerms)}). The contract will
        record your reason, and the change is logged.
      </p>
      <div className="space-y-1.5">
        <Label htmlFor="commitment-override-reason" className="text-xs">
          Reason for override <span className="text-destructive">*</span>
        </Label>
        <Textarea
          id="commitment-override-reason"
          rows={2}
          className="bg-background"
          value={overrideReason}
          onChange={(e) => onOverrideReasonChange(e.target.value)}
          placeholder="Customer renegotiated lock-in on call of 14 Sep, approved by Vinit"
        />
      </div>
      <button type="button" className="text-xs underline" onClick={() => onOverrideReasonChange(null)}>
        Cancel override and use the proposal&apos;s terms
      </button>
    </div>
  );
}
