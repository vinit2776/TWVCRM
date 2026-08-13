"use client";

import { cn } from "@/lib/utils";
import {
  CASE_STATUS_GROUPS,
  agreementLifecycleSubstate,
  invoiceLifecycleSubstate,
  LIFECYCLE_SUBSTATE_TEXT_COLORS,
} from "@/lib/constants";
import { CheckCircle2, Circle, Loader2, AlertTriangle } from "lucide-react";

interface CaseStatusPipelineProps {
  currentStatus: string;
  className?: string;
  /** Latest proposal (`case_agreements` type=proposal) status, if any. */
  proposalStatus?: string | null;
  /** Latest Leave & License agreement status, if any. */
  agreementStatus?: string | null;
  /** Latest non-voided `vo_case` billing statement, if any. */
  billingStatus?: { payment_status?: string | null } | null;
}

const PIPELINE_ORDER = ["intake", "review_approval", "execution", "active", "closed"];

// Captions shown under a pill: which group they attach to, and how to derive them.
const CAPTIONS_BY_GROUP: Record<string, (props: CaseStatusPipelineProps) => { label: string; tone: string }[]> = {
  review_approval: ({ proposalStatus }) => [
    { label: `Proposal: ${agreementLifecycleSubstate(proposalStatus).label}`, tone: agreementLifecycleSubstate(proposalStatus).tone },
  ],
  execution: ({ agreementStatus, billingStatus }) => [
    { label: `Agreement: ${agreementLifecycleSubstate(agreementStatus).label}`, tone: agreementLifecycleSubstate(agreementStatus).tone },
    { label: `Invoice: ${invoiceLifecycleSubstate(billingStatus).label}`, tone: invoiceLifecycleSubstate(billingStatus).tone },
  ],
};

export function CaseStatusPipeline(props: CaseStatusPipelineProps) {
  const { currentStatus, className } = props;
  // Find which group the current status belongs to
  let currentGroupIndex = -1;
  for (let i = 0; i < PIPELINE_ORDER.length; i++) {
    const group = CASE_STATUS_GROUPS[PIPELINE_ORDER[i]];
    if (group && group.statuses.includes(currentStatus)) {
      currentGroupIndex = i;
      break;
    }
  }

  return (
    <div className={cn("flex items-start gap-1 overflow-x-auto pb-2", className)}>
      {PIPELINE_ORDER.map((groupKey, index) => {
        const group = CASE_STATUS_GROUPS[groupKey];
        if (!group) return null;

        const isPast = index < currentGroupIndex;
        const isCurrent = index === currentGroupIndex;
        const isFuture = index > currentGroupIndex;
        const captions = CAPTIONS_BY_GROUP[groupKey]?.(props) ?? [];

        return (
          <div key={groupKey} className="flex items-start">
            <div className="flex flex-col gap-1">
              <div
                className={cn(
                  "flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium whitespace-nowrap transition-colors",
                  isPast && "bg-green-100 text-green-800",
                  isCurrent && "bg-teal-100 text-teal-800 ring-2 ring-teal-500",
                  isFuture && "bg-gray-100 text-gray-500"
                )}
              >
                {isPast && <CheckCircle2 className="h-3 w-3" />}
                {isCurrent && <Loader2 className="h-3 w-3 animate-spin" />}
                {isFuture && <Circle className="h-3 w-3" />}
                {group.label}
              </div>
              {captions.length > 0 && (
                <div className="flex flex-col gap-0.5 px-1">
                  {captions.map((c) => (
                    <span
                      key={c.label}
                      className={cn(
                        "flex items-center gap-1 text-[11px] whitespace-nowrap",
                        LIFECYCLE_SUBSTATE_TEXT_COLORS[c.tone as keyof typeof LIFECYCLE_SUBSTATE_TEXT_COLORS]
                      )}
                    >
                      {c.tone === "red" && <AlertTriangle className="h-3 w-3 shrink-0" />}
                      {c.label}
                    </span>
                  ))}
                </div>
              )}
            </div>
            {index < PIPELINE_ORDER.length - 1 && (
              <div
                className={cn(
                  "w-6 h-0.5 mx-0.5 mt-4",
                  isPast ? "bg-green-300" : "bg-gray-200"
                )}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
