"use client";

/**
 * BillingLifecycleFlow — horizontal stepper that shows every stage of the
 * billing lifecycle and makes the "next action" obvious to the user.
 *
 * Stages (in order):
 *   Draft → Finalized → Proforma Sent → Payment Received → GST Invoice → Accounted
 *
 * Exception: gst_sent_unpaid (GST sent before payment received) renders the
 * "Payment Received" step as an orange warning and "GST Invoice" as active-warning.
 *
 * Usage:
 *   <BillingLifecycleFlow
 *     stage={resolvedStage}
 *     statementId="..."         // enables proforma + GST PDF links
 *     statementNumber="TWV-BS-0006"
 *     actors={{ finalized_by: "Alice", proforma_sent_by: "Bob", ... }}
 *   />
 */

import { Check, AlertCircle, ChevronRight, Download, User } from "lucide-react";
import { cn } from "@/lib/utils";

export type BillingStage =
  | "draft"
  | "finalized"
  | "proforma_sent"
  | "partially_paid"
  | "paid"
  | "gst_sent_unpaid"
  | "invoiced"
  | "complete";

/** Maps each stage to a numeric rank for progress comparison. */
const STAGE_RANK: Record<BillingStage, number> = {
  draft: 0,
  finalized: 1,
  proforma_sent: 2,
  partially_paid: 2.5,
  paid: 3,
  gst_sent_unpaid: 3.5, // GST sent but payment still owed
  invoiced: 4,
  complete: 5,
};

interface StepDef {
  /** Key used for stage mapping */
  key: BillingStage;
  /** Short label shown below the circle */
  label: string;
  /** Secondary description below the label */
  sublabel: string;
  /** Human-readable trigger action that moves you TO this step */
  trigger: string;
}

const STEPS: StepDef[] = [
  {
    key: "draft",
    label: "Draft",
    sublabel: "Statement created",
    trigger: "Auto-generated",
  },
  {
    key: "finalized",
    label: "Finalized",
    sublabel: "Amounts locked",
    trigger: "Click Finalize",
  },
  {
    key: "proforma_sent",
    label: "Proforma Sent",
    sublabel: "Client notified",
    trigger: "Send Proforma",
  },
  {
    key: "paid",
    label: "Payment Received",
    sublabel: "Full amount collected",
    trigger: "Online / Record payment",
  },
  {
    key: "invoiced",
    label: "GST Invoice",
    sublabel: "Tax invoice issued",
    trigger: "Generate GST Invoice",
  },
  {
    key: "complete",
    label: "Accounted",
    sublabel: "Books closed",
    trigger: "Mark as Accounted",
  },
];

/**
 * Resolves the billing stage from raw statement fields.
 * Mirrors the logic in BillingLifecycleStatus.resolveStage — use this
 * when you need the stage value outside of that component.
 */
export function resolveBillingStage({
  status,
  paymentStatus,
  gstInvoiceNumber,
  accounted,
  proformaSentAt,
}: {
  status: string;
  paymentStatus?: string | null;
  gstInvoiceNumber?: string | null;
  accounted?: boolean | null;
  proformaSentAt?: string | null;
}): BillingStage {
  const isFinalized = status === "finalized" || status === "exported";
  if (!isFinalized) return "draft";

  const isPaid = paymentStatus === "paid";
  const isPartiallyPaid = paymentStatus === "partially_paid";
  const hasGstInvoice = !!gstInvoiceNumber;
  const isAccounted = !!accounted;
  const hasProforma = !!proformaSentAt;

  if (isAccounted && hasGstInvoice) return "complete";
  if (hasGstInvoice && isPaid) return "invoiced";
  if (hasGstInvoice) return "gst_sent_unpaid";
  if (isPaid) return "paid";
  if (isPartiallyPaid) return "partially_paid";
  if (hasProforma) return "proforma_sent";
  return "finalized";
}

/** Actor names for each lifecycle step */
export interface BillingLifecycleActors {
  finalized_by?: string | null;
  proforma_sent_by?: string | null;
  gst_generated_by?: string | null;
  accounted_by?: string | null;
}

interface Props {
  stage: BillingStage;
  className?: string;
  /** Statement ID — enables PDF download links on proforma + GST steps */
  statementId?: string;
  /** Statement number shown as the proforma reference (e.g. "TWV-BS-0006") */
  statementNumber?: string;
  /** GST invoice number — shown on the GST Invoice step when done */
  gstInvoiceNumber?: string | null;
  /** Actor (user) names for each completed step */
  actors?: BillingLifecycleActors;
}

/** Returns the actor name for a given step key */
function getActor(key: BillingStage, actors?: BillingLifecycleActors): string | null {
  if (!actors) return null;
  switch (key) {
    case "finalized": return actors.finalized_by ?? null;
    case "proforma_sent": return actors.proforma_sent_by ?? null;
    case "invoiced": return actors.gst_generated_by ?? null;
    case "complete": return actors.accounted_by ?? null;
    default: return null;
  }
}

export function BillingLifecycleFlow({ stage, className, statementId, statementNumber, gstInvoiceNumber, actors }: Props) {
  const currentRank = STAGE_RANK[stage] ?? 0;
  const isGstSentUnpaid = stage === "gst_sent_unpaid";
  const isPartiallyPaid = stage === "partially_paid";

  return (
    <div className={cn("w-full overflow-x-auto pb-1", className)}>
      <div className="flex items-start min-w-max gap-0 py-2">
        {STEPS.map((step, idx) => {
          const stepRank = STAGE_RANK[step.key];

          /**
           * Exception: when gst_sent_unpaid, the "paid" step shows as a
           * warning (orange !) rather than done (green ✓) because money
           * hasn't been collected yet.
           */
          const isPaymentWarning = isGstSentUnpaid && step.key === "paid";

          const isDone =
            !isPaymentWarning && currentRank > stepRank;

          const isActive =
            !isDone &&
            !isPaymentWarning &&
            (
              step.key === stage ||
              (isPartiallyPaid && step.key === "paid") ||
              (isGstSentUnpaid && step.key === "invoiced")
            );

          const isFuture = !isDone && !isActive && !isPaymentWarning;

          // Connector is green when the step before it is done
          const connectorDone =
            idx < STEPS.length - 1 &&
            currentRank > stepRank &&
            !(isGstSentUnpaid && step.key === "paid");

          // Actor who performed this step (only shown when done)
          const actorName = isDone ? getActor(step.key, actors) : null;

          // PDF link for proforma step (when done and statementId provided)
          const proformaHref =
            isDone && step.key === "proforma_sent" && statementId
              ? `/api/billing-statements/${statementId}/proforma-pdf`
              : null;

          // PDF link for GST invoice step (when done and statementId provided)
          const gstHref =
            isDone && step.key === "invoiced" && statementId
              ? `/api/billing-statements/${statementId}/gst-invoice-pdf`
              : null;

          return (
            <div key={step.key} className="flex items-start">
              {/* ── Step Node ─────────────────────────────── */}
              <div className="flex flex-col items-center w-[108px]">
                {/* Circle icon */}
                <div
                  className={cn(
                    "w-8 h-8 rounded-full flex items-center justify-center border-2 flex-shrink-0 transition-colors",
                    isDone && "bg-green-500 border-green-500 text-white",
                    isActive && !isGstSentUnpaid && "bg-primary border-primary text-primary-foreground shadow-sm",
                    isActive && isGstSentUnpaid && "bg-orange-500 border-orange-500 text-white",
                    isPaymentWarning && "bg-orange-50 border-orange-400 text-orange-600",
                    isFuture && "bg-muted border-border text-muted-foreground",
                  )}
                >
                  {isDone && <Check className="h-4 w-4 stroke-[2.5]" />}
                  {(isPaymentWarning || (isActive && isGstSentUnpaid)) && (
                    <AlertCircle className="h-4 w-4" />
                  )}
                  {isActive && !isGstSentUnpaid && (
                    <div className="w-2.5 h-2.5 rounded-full bg-primary-foreground" />
                  )}
                  {isFuture && (
                    <span className="text-[11px] font-semibold">{idx + 1}</span>
                  )}
                </div>

                {/* Labels */}
                <div className="mt-2 text-center px-1 w-full">
                  <p
                    className={cn(
                      "text-[11px] font-semibold leading-tight",
                      isDone && "text-green-700",
                      isActive && !isGstSentUnpaid && "text-primary",
                      isActive && isGstSentUnpaid && "text-orange-700",
                      isPaymentWarning && "text-orange-600",
                      isFuture && "text-muted-foreground/60",
                    )}
                  >
                    {step.label}
                    {isPartiallyPaid && step.key === "paid" && (
                      <span className="block text-[9px] font-normal">(Partial)</span>
                    )}
                  </p>
                  <p
                    className={cn(
                      "text-[10px] leading-tight mt-0.5",
                      isDone && "text-green-600/70",
                      isActive && !isGstSentUnpaid && "text-primary/70",
                      isActive && isGstSentUnpaid && "text-orange-600/80",
                      isPaymentWarning && "text-orange-500",
                      isFuture && "text-muted-foreground/40",
                    )}
                  >
                    {isPaymentWarning ? "Awaiting payment" : step.sublabel}
                  </p>

                  {/* Proforma PDF link — shown when proforma step is done */}
                  {proformaHref && (
                    <a
                      href={proformaHref}
                      download={statementNumber ? `Proforma-${statementNumber.replace(/\//g, "-")}.pdf` : "Proforma.pdf"}
                      onClick={(e) => e.stopPropagation()}
                      className="mt-1 inline-flex items-center gap-0.5 text-[9px] text-green-700 hover:text-green-900 underline underline-offset-1"
                    >
                      <Download className="h-2.5 w-2.5 flex-shrink-0" />
                      {statementNumber || "View PDF"}
                    </a>
                  )}

                  {/* GST invoice PDF link — shown when invoiced step is done */}
                  {gstHref && (
                    <a
                      href={gstHref}
                      download={gstInvoiceNumber ? `GST-${gstInvoiceNumber.replace(/\//g, "-")}.pdf` : "GST-Invoice.pdf"}
                      onClick={(e) => e.stopPropagation()}
                      className="mt-1 inline-flex items-center gap-0.5 text-[9px] text-green-700 hover:text-green-900 underline underline-offset-1"
                    >
                      <Download className="h-2.5 w-2.5 flex-shrink-0" />
                      {gstInvoiceNumber || "View GST PDF"}
                    </a>
                  )}

                  {/* Actor name — who performed this step */}
                  {actorName && (
                    <p className="mt-1 inline-flex items-center gap-0.5 text-[9px] text-green-600/80 leading-tight">
                      <User className="h-2.5 w-2.5 flex-shrink-0" />
                      {actorName}
                    </p>
                  )}
                </div>

                {/* "Next action" chip — shown only on the current active step */}
                {(isActive || isPaymentWarning) && idx < STEPS.length - 1 && (
                  <div
                    className={cn(
                      "mt-1.5 flex items-center gap-0.5 rounded-full px-2 py-0.5 text-[9px] font-medium whitespace-nowrap",
                      isPaymentWarning
                        ? "bg-orange-100 text-orange-700 border border-orange-200"
                        : isGstSentUnpaid
                        ? "bg-orange-100 text-orange-700 border border-orange-200"
                        : "bg-primary/10 text-primary border border-primary/20",
                    )}
                  >
                    <ChevronRight className="h-2.5 w-2.5 flex-shrink-0" />
                    {isPaymentWarning
                      ? "Collect payment"
                      : `${STEPS[idx + 1].trigger}`}
                  </div>
                )}
              </div>

              {/* ── Connector ─────────────────────────────── */}
              {idx < STEPS.length - 1 && (
                <div className="flex flex-col items-center justify-start pt-3.5 mx-0.5 flex-shrink-0">
                  <div
                    className={cn(
                      "h-0.5 w-8 rounded-full transition-colors",
                      connectorDone
                        ? "bg-green-400"
                        : isPaymentWarning
                        ? "bg-orange-200"
                        : "bg-border",
                    )}
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Exception callout for gst_sent_unpaid */}
      {isGstSentUnpaid && (
        <div className="mt-1 flex items-start gap-1.5 rounded-md bg-orange-50 border border-orange-200 px-3 py-2 text-xs text-orange-800">
          <AlertCircle className="h-3.5 w-3.5 flex-shrink-0 mt-0.5 text-orange-500" />
          <span>
            <strong>GST invoice was issued before payment was received.</strong>{" "}
            Record the payment to complete the billing cycle.
          </span>
        </div>
      )}
    </div>
  );
}
