"use client";

import {
  FileText, CheckCircle2, Truck, PackageCheck, Flag,
  AlertTriangle, Clock, XCircle, RefreshCw,
} from "lucide-react";
import type { StockTransfer } from "@/types";

/**
 * TransferLifecycleStatus — a horizontal step indicator showing where a stock
 * transfer is in its journey, so anyone opening it can see at a glance what has
 * happened and what the next action is.
 *
 * Milestones: Created → Approved → Dispatched → Received → Completed
 * Special states:
 *   - draft            → "Created" is the active step (submit for approval next)
 *   - pending_approval → awaiting approval
 *   - issue_raised     → reached "Received" but flagged; needs resolution
 */

interface Step {
  key: string;
  label: string;
  Icon: React.ElementType;
  done: boolean;
  timestamp?: string | null;
}

const NEXT_ACTION: Record<string, string> = {
  draft: "Submit for approval",
  pending_approval: "Awaiting manager approval",
  approved: "Ready to dispatch (stock leaves source on dispatch)",
  dispatched: "In transit — receive at destination",
  received: "Partially received — review or resolve issues",
  issue_raised: "Issue raised — a manager needs to resolve it",
  completed: "Done — transfer complete",
};

export function TransferLifecycleStatus({ transfer }: { transfer: StockTransfer }) {
  const status = transfer.status;
  const isIssue = status === "issue_raised";
  const isRejectedDraft = status === "draft" && !!transfer.notes;

  const reached = (...statuses: string[]) => statuses.includes(status);

  const steps: Step[] = [
    {
      key: "created",
      label: "Created",
      Icon: FileText,
      done: status !== "draft",
      timestamp: transfer.created_at,
    },
    {
      key: "approved",
      label: "Approved",
      Icon: CheckCircle2,
      done: reached("approved", "dispatched", "received", "completed", "issue_raised"),
      timestamp: transfer.approved_at,
    },
    {
      key: "dispatched",
      label: "Dispatched",
      Icon: Truck,
      done: reached("dispatched", "received", "completed", "issue_raised"),
      timestamp: transfer.dispatched_at,
    },
    {
      key: "received",
      label: "Received",
      Icon: PackageCheck,
      done: reached("received", "completed", "issue_raised"),
      timestamp: transfer.received_at,
    },
    {
      key: "completed",
      label: "Completed",
      Icon: Flag,
      done: status === "completed",
      timestamp: status === "completed" ? transfer.received_at : null,
    },
  ];

  // First not-done step is the "current" one (highlighted). If all done, none.
  const currentIndex = steps.findIndex((s) => !s.done);

  const fmtTime = (ts?: string | null) => {
    if (!ts) return null;
    try {
      return new Date(ts).toLocaleDateString("en-IN", {
        day: "numeric", month: "short",
      });
    } catch {
      return null;
    }
  };

  return (
    <div className="rounded-lg border bg-card p-4">
      <div className="flex items-center justify-between mb-4">
        <span className="text-sm font-medium text-muted-foreground flex items-center gap-2">
          Transfer progress
          {transfer.origin === "replenishment" && (
            <span className="inline-flex items-center gap-1 rounded-full bg-blue-100 text-blue-700 text-[10px] font-medium px-2 py-0.5">
              <RefreshCw className="h-3 w-3" />
              Auto-replenishment
            </span>
          )}
        </span>
        <span className="text-xs flex items-center gap-1.5 text-muted-foreground">
          {isIssue ? (
            <AlertTriangle className="h-3.5 w-3.5 text-red-500" />
          ) : (
            <Clock className="h-3.5 w-3.5" />
          )}
          {NEXT_ACTION[status] ?? status}
        </span>
      </div>

      <div className="flex items-start">
        {steps.map((step, i) => {
          const isCurrent = i === currentIndex && !step.done;
          const isCurrentIssue = isCurrent && isIssue && step.key === "completed";
          const Icon = step.done ? CheckCircle2 : step.Icon;

          // Circle styling per state
          let circle = "bg-muted text-muted-foreground border-border"; // future
          if (step.done) circle = "bg-green-500 text-white border-green-500";
          else if (isCurrentIssue) circle = "bg-red-100 text-red-600 border-red-400 ring-2 ring-red-200";
          else if (isCurrent) circle = "bg-primary/10 text-primary border-primary ring-2 ring-primary/20";

          // Connector to the next step (green once this step is done)
          const connectorDone = step.done;

          return (
            <div key={step.key} className="flex-1 flex flex-col items-center min-w-0">
              <div className="flex items-center w-full">
                {/* left connector spacer (invisible for first) */}
                <div className={`h-0.5 flex-1 ${i === 0 ? "opacity-0" : connectorPrevColor(steps, i)}`} />
                <div
                  className={`shrink-0 h-9 w-9 rounded-full border-2 flex items-center justify-center transition-colors ${circle}`}
                >
                  <Icon className="h-4 w-4" />
                </div>
                {/* right connector */}
                <div className={`h-0.5 flex-1 ${i === steps.length - 1 ? "opacity-0" : (connectorDone ? "bg-green-500" : "bg-border")}`} />
              </div>
              <div className="mt-2 text-center px-1">
                <p className={`text-xs font-medium leading-tight ${step.done ? "text-foreground" : isCurrent ? "text-primary" : "text-muted-foreground"}`}>
                  {isCurrentIssue ? "Issue" : step.label}
                </p>
                {fmtTime(step.timestamp) && (
                  <p className="text-[10px] text-muted-foreground mt-0.5">{fmtTime(step.timestamp)}</p>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {isRejectedDraft && (
        <div className="mt-3 flex items-start gap-2 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-3 py-2">
          <XCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
          <span>This transfer was sent back to draft. Reason: {transfer.notes}</span>
        </div>
      )}
    </div>
  );
}

// The connector on the LEFT of step i should be green if the PREVIOUS step is done.
function connectorPrevColor(steps: Step[], i: number): string {
  return steps[i - 1]?.done ? "bg-green-500" : "bg-border";
}
