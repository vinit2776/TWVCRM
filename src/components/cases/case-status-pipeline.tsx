"use client";

import { cn } from "@/lib/utils";
import { CASE_STATUS_GROUPS, CASE_STATUS_LABELS } from "@/lib/constants";
import { CheckCircle2, Circle, Loader2 } from "lucide-react";

interface CaseStatusPipelineProps {
  currentStatus: string;
  className?: string;
}

const PIPELINE_ORDER = ["intake", "review_approval", "execution", "active", "closed"];

export function CaseStatusPipeline({ currentStatus, className }: CaseStatusPipelineProps) {
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
    <div className={cn("flex items-center gap-1 overflow-x-auto pb-2", className)}>
      {PIPELINE_ORDER.map((groupKey, index) => {
        const group = CASE_STATUS_GROUPS[groupKey];
        if (!group) return null;

        const isPast = index < currentGroupIndex;
        const isCurrent = index === currentGroupIndex;
        const isFuture = index > currentGroupIndex;

        return (
          <div key={groupKey} className="flex items-center">
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
            {index < PIPELINE_ORDER.length - 1 && (
              <div
                className={cn(
                  "w-6 h-0.5 mx-0.5",
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
