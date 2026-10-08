"use client";

import { AlertTriangle } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatCurrency } from "@/lib/utils";
import { DEPOSIT_OVERRIDE_MIN_REASON_LENGTH, evaluateDepositGuard } from "@/lib/deposit-payment-guard";
import type { DepositUnavailableReason } from "@/types";

/** Wording for the greyed-out "Adjustment against deposit" option. */
export const DEPOSIT_UNAVAILABLE_LABELS: Record<DepositUnavailableReason, string> = {
  no_proposal: "no proposal linked",
  deposit_pending: "deposit not paid yet",
  no_deposit: "no deposit collected",
  fully_committed: "fully used or pending approval",
};

/** Same rule the server enforces, so the warning appears exactly when a submit would be refused. */
export function looksLikeDepositAdjustment(
  mode: string, depositAvailable: number | null, reference: string, notes: string,
): boolean {
  return !evaluateDepositGuard({ mode, reference, notes, depositAvailable }).ok;
}

export function DepositGuardWarning({ available }: { available: number }) {
  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs text-amber-900 flex gap-2">
      <AlertTriangle className="h-4 w-4 shrink-0 mt-px" />
      <p>
        This customer has <span className="font-semibold">{formatCurrency(available)}</span> of deposit available. If you&apos;re
        settling this against the deposit, choose &quot;Adjustment against deposit&quot; so the balance updates. It goes to an
        admin or manager for approval.
      </p>
    </div>
  );
}

/** Shown only after the server refused the payment with DEPOSIT_AVAILABLE. */
export function DepositOverrideField({
  message, confirmed, onConfirmedChange, reason, onReasonChange,
}: {
  message: string;
  confirmed: boolean;
  onConfirmedChange: (v: boolean) => void;
  reason: string;
  onReasonChange: (v: string) => void;
}) {
  return (
    <div className="rounded-lg border border-red-200 bg-red-50 p-3 space-y-2.5">
      <p className="text-xs text-red-800">{message}</p>
      <label className="flex items-center gap-2 text-xs cursor-pointer">
        <Checkbox checked={confirmed} onCheckedChange={(v) => onConfirmedChange(v === true)} />
        This is a genuine receipt, not a deposit adjustment
      </label>
      {confirmed && (
        <div className="space-y-1">
          <Label className="text-xs">Reason (at least {DEPOSIT_OVERRIDE_MIN_REASON_LENGTH} characters, saved to the audit log)</Label>
          <Input
            value={reason}
            onChange={(e) => onReasonChange(e.target.value)}
            placeholder="e.g. Customer paid by NEFT, UTR on bank statement"
            className="h-9 text-xs bg-white"
          />
        </div>
      )}
    </div>
  );
}
