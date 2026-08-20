"use client";

import { CheckCircle2, Circle, ArrowRight, Info } from "lucide-react";
import { formatCurrency } from "@/lib/utils";
import { BILLING_CYCLE_LABELS, type ServicePoBillingCycle } from "@/lib/constants";
import { CYCLE_UNIT_LABEL, serviceBillingStep } from "@/lib/procurement/amc-billing";

/**
 * Always-visible explanation of how a service contract gets billed.
 *
 * Every cycle must be released by a service report followed by an invoice — a
 * rule that was previously discoverable only by hovering a disabled button. On a
 * monthly contract that sequence repeats twelve times, so the requirement is
 * stated up front along with where the contract currently stands.
 */

interface Props {
  billingCycle: ServicePoBillingCycle | null;
  cycleCount: number | null;
  unitCostPerCycle: number | null;
  reportsFiled: number;
  invoicesFiled: number;
  /** Contract billing only opens once the PO is actually ordered. */
  isOrdered: boolean;
}

export function ServiceBillingSteps({
  billingCycle, cycleCount, unitCostPerCycle, reportsFiled, invoicesFiled, isOrdered,
}: Props) {
  const total = cycleCount ?? 0;
  const unit = billingCycle ? CYCLE_UNIT_LABEL[billingCycle] : "cycle";
  const cycleLabel = billingCycle ? BILLING_CYCLE_LABELS[billingCycle] : null;

  const { nextAction, allBilled, cyclesRemaining } = serviceBillingStep(
    reportsFiled, invoicesFiled, cycleCount
  );
  const remaining = cyclesRemaining * Number(unitCostPerCycle ?? 0);

  const steps = [
    {
      label: `Log a service report for this ${unit}`,
      detail: "Records that the vendor delivered the service. Required — the invoice button stays disabled without one.",
      done: nextAction === "upload_invoice" || allBilled,
      current: isOrdered && nextAction === "log_report",
    },
    {
      label: "Upload the vendor invoice against that report",
      detail: unitCostPerCycle
        ? `One invoice per report, capped at ${formatCurrency(Number(unitCostPerCycle))} — this ${unit}'s cost.`
        : `One invoice per report, capped at this ${unit}'s cost.`,
      done: allBilled,
      current: isOrdered && nextAction === "upload_invoice",
    },
    {
      // Approve/reject on a vendor bill is admin-only in the API
      // (canApproveOrReject === "admin"); managers cannot approve.
      label: "Approval by an admin",
      detail: "Reviewed on the vendor bill, not here. Managers cannot approve vendor bills.",
      done: false,
      current: false,
    },
    {
      label: "Payment from Finance › Acc Payables",
      detail: "Recorded by Accounts or an admin — Office Admin for petty cash only. Only approved bills can be paid, and never from this page.",
      done: false,
      current: false,
    },
  ];

  return (
    <div className="rounded-lg border bg-muted/30 p-3 space-y-3">
      <div className="flex items-start gap-2">
        <Info className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
        <div className="min-w-0">
          <p className="text-sm font-medium">How this contract gets billed</p>
          <p className="text-xs text-muted-foreground">
            {total > 1 ? (
              <>
                {cycleLabel ? `${cycleLabel} contract — ` : ""}
                these steps repeat for each of the {total} {unit}s. Each {unit} needs its own
                service report and invoice before it can be paid.
              </>
            ) : (
              <>Each step must be completed in order before payment can be released.</>
            )}
          </p>
        </div>
      </div>

      <ol className="space-y-2">
        {steps.map((s, i) => (
          <li key={i} className="flex items-start gap-2">
            {s.done ? (
              <CheckCircle2 className="h-4 w-4 text-emerald-600 mt-0.5 shrink-0" />
            ) : s.current ? (
              <ArrowRight className="h-4 w-4 text-blue-600 mt-0.5 shrink-0" />
            ) : (
              <Circle className="h-3.5 w-3.5 text-muted-foreground/50 mt-0.5 ml-[1px] shrink-0" />
            )}
            <div className="min-w-0">
              <p className={`text-xs ${s.current ? "font-semibold text-blue-700" : "font-medium"}`}>
                {i + 1}. {s.label}
                {s.current && <span className="ml-1.5 font-normal text-blue-600">← do this next</span>}
              </p>
              <p className="text-xs text-muted-foreground">{s.detail}</p>
            </div>
          </li>
        ))}
      </ol>

      {total > 1 && (
        <div className="border-t pt-2 text-xs">
          {allBilled ? (
            <span className="text-emerald-700 font-medium">
              All {total} {unit}s invoiced — this contract is fully billed. Further invoices are blocked.
            </span>
          ) : (
            <span className="text-muted-foreground">
              <span className="font-medium text-foreground">
                {invoicesFiled} of {total} {unit}s billed
              </span>
              {remaining > 0 && <> · {formatCurrency(remaining)} still to be invoiced</>}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
