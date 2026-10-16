"use client";

import { Info } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn, formatCurrency } from "@/lib/utils";
import { PRICE_TOLERANCE_OPTIONS, PRICE_TOLERANCE_REASONS } from "@/lib/constants";

interface Props {
  percent: number;
  onPercentChange: (v: number) => void;
  /** Rendered only when a percentage is chosen; omit for read-only usages. */
  reason?: string;
  onReasonChange?: (v: string) => void;
  estimate: number;
  label?: string;
}

const optionLabel = (p: number) => (p === 0 ? "Firm price" : `± ${p}%`);

/** Segmented 0/5/10% picker plus live accepted range. Used by the requester and, to change the figure, the approver. */
export function PriceToleranceField({ percent, onPercentChange, reason, onReasonChange, estimate, label }: Props) {
  return (
    <div className="space-y-2">
      {label && <Label>{label}</Label>}
      <div className="flex gap-2" role="radiogroup" aria-label="Price tolerance">
        {PRICE_TOLERANCE_OPTIONS.map((p) => (
          <button
            key={p}
            type="button"
            role="radio"
            aria-checked={percent === p}
            onClick={() => onPercentChange(p)}
            className={cn(
              "flex-1 rounded-md border px-3 py-2 text-sm transition-colors",
              percent === p ? "border-primary bg-primary/10 font-medium" : "hover:bg-muted"
            )}
          >
            {optionLabel(p)}
          </button>
        ))}
      </div>
      {percent > 0 && estimate > 0 && (
        <p className="text-xs text-muted-foreground">
          Final invoice accepted without special approval between{" "}
          <span className="font-medium text-foreground">{formatCurrency(estimate * (1 - percent / 100))}</span> and{" "}
          <span className="font-medium text-foreground">{formatCurrency(estimate * (1 + percent / 100))}</span>.
        </p>
      )}
      {percent > 0 && onReasonChange && (
        <div className="space-y-1.5 pt-1">
          <Label htmlFor="tolerance-reason" className="text-xs">
            Why could the final bill differ? <span className="text-red-500">*</span>
          </Label>
          <div className="flex flex-wrap gap-1.5">
            {PRICE_TOLERANCE_REASONS.map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => onReasonChange(r)}
                className={cn(
                  "rounded-md border px-2.5 py-1 text-xs",
                  reason === r ? "border-primary bg-primary/10 text-primary" : "hover:bg-muted"
                )}
              >
                {r}
              </button>
            ))}
          </div>
          <Input
            id="tolerance-reason"
            value={reason ?? ""}
            onChange={(e) => onReasonChange(e.target.value)}
            placeholder="Or write your own reason"
          />
        </div>
      )}
      {percent === 0 && (
        <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
          <Info className="mt-0.5 h-3 w-3 shrink-0" />
          Use Firm price for fixed quotes, catalog items and monthly service charges.
        </p>
      )}
    </div>
  );
}
