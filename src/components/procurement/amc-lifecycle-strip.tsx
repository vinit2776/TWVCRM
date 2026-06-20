"use client";

/**
 * AMC Lifecycle Strip
 *
 * Compact horizontal timeline showing where an AMC contract sits today:
 * Created ── Activates ── Active ── Expires. Current position highlighted.
 */

import { CheckCircle2, Circle, Clock } from "lucide-react";
import { cn } from "@/lib/utils";
import { computeAmcLifecycle } from "@/lib/amc-lifecycle";
import { formatDate } from "@/lib/utils";

interface Props {
  createdAt?: string | null;
  amcStartDate?: string | null;
  amcEndDate?: string | null;
  amcVisitsCovered?: number | null;
  amcVisitsUsed?: number | null;
  amcTerminatedAt?: string | null;
  className?: string;
}

interface Step {
  label: string;
  date: string;
  state: "done" | "current" | "future";
}

export function AmcLifecycleStrip({
  createdAt, amcStartDate, amcEndDate, amcVisitsCovered, amcVisitsUsed, amcTerminatedAt, className,
}: Props) {
  if (!amcStartDate || !amcEndDate) {
    return (
      <div className={cn("text-xs text-muted-foreground italic", className)}>
        Lifecycle hidden — set start and end dates to view the timeline.
      </div>
    );
  }

  const lc = computeAmcLifecycle({
    amc_start_date: amcStartDate,
    amc_end_date: amcEndDate,
    amc_visits_covered: amcVisitsCovered,
    amc_visits_used: amcVisitsUsed,
    amc_terminated_at: amcTerminatedAt,
  });

  // Four anchors: Created, Activates, Active midpoint marker, Expires
  // We don't render an "Active" anchor — the bar between Activates and Expires IS the active phase.
  // When terminated, the third anchor becomes "Terminated" + the termination date.
  const isTerminated = lc.status === "terminated";
  const steps: Step[] = [
    {
      label: "Created",
      date: createdAt ? formatDate(createdAt) : "—",
      state: "done",
    },
    {
      label: lc.isPendingActivation ? "Activates" : "Activated",
      date: formatDate(amcStartDate),
      state: lc.isPendingActivation ? "future" : "done",
    },
    {
      label: isTerminated ? "Terminated" : lc.status === "expired" ? "Expired" : "Expires",
      date: isTerminated && amcTerminatedAt ? formatDate(amcTerminatedAt) : formatDate(amcEndDate),
      state: isTerminated || lc.status === "expired" ? "done" : "future",
    },
  ];

  // Mark the "current" step — the one with the next future date, or the last done if all done
  const firstFuture = steps.findIndex((s) => s.state === "future");
  if (firstFuture !== -1) steps[firstFuture].state = "current";

  return (
    <div className={cn("space-y-2", className)}>
      <div className="flex items-center">
        {steps.map((step, i) => (
          <div key={step.label} className="flex items-center flex-1 last:flex-initial">
            {/* Node */}
            <div className="flex flex-col items-center min-w-0">
              <div className={cn(
                "h-7 w-7 rounded-full flex items-center justify-center border-2 shrink-0",
                step.state === "done" && "bg-emerald-100 border-emerald-500 text-emerald-700",
                step.state === "current" && "bg-amber-100 border-amber-500 text-amber-700 ring-4 ring-amber-100",
                step.state === "future" && "bg-muted border-muted-foreground/30 text-muted-foreground",
              )}>
                {step.state === "done" ? (
                  <CheckCircle2 className="h-4 w-4" />
                ) : step.state === "current" ? (
                  <Clock className="h-4 w-4" />
                ) : (
                  <Circle className="h-4 w-4" />
                )}
              </div>
              <div className="mt-1.5 text-center">
                <div className={cn(
                  "text-[11px] font-semibold leading-tight",
                  step.state === "done" && "text-emerald-700",
                  step.state === "current" && "text-amber-700",
                  step.state === "future" && "text-muted-foreground",
                )}>
                  {step.label}
                </div>
                <div className="text-[10px] text-muted-foreground mt-0.5 whitespace-nowrap">{step.date}</div>
              </div>
            </div>

            {/* Connector — flex-1 fills space between nodes */}
            {i < steps.length - 1 && (
              <div className={cn(
                "flex-1 h-0.5 mx-2 mb-7 rounded-full",
                step.state === "done" ? "bg-emerald-400" : "bg-muted-foreground/20",
              )} />
            )}
          </div>
        ))}
      </div>

      {/* Status caption */}
      <p className={cn("text-xs text-center font-medium",
        lc.status === "active" && "text-emerald-700",
        lc.status === "inactive" && "text-amber-700",
        lc.status === "expiring" && "text-orange-700",
        (lc.status === "expired" || lc.status === "exhausted") && "text-rose-700",
      )}>
        {lc.label}
      </p>
    </div>
  );
}
