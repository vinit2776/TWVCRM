"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  CheckCircle2,
  Clock,
  Loader2,
  AlertCircle,
  SkipForward,
  RefreshCw,
} from "lucide-react";

interface DispatchJob {
  id: string;
  contract_number: string;
  customer_name: string | null;
  billing_mode: string | null;
  status: "pending" | "processing" | "sent" | "failed" | "skipped";
  attempt_count: number;
  max_attempts: number;
  last_error: string | null;
  error_suggestion: string | null;
  dispatched_to: string | null;
  started_at: string | null;
  completed_at: string | null;
}

interface DispatchRun {
  id: string;
  status: "queued" | "running" | "completed" | "partial" | "failed";
  total_jobs: number;
  done_jobs: number;
  failed_jobs: number;
  started_at: string | null;
  completed_at: string | null;
}

interface Props {
  runId: string;
  onClose?: () => void;
  /** Fires once, as soon as the run reaches a terminal status — while the
   *  panel is still open, before the user clicks Close. Lets the parent
   *  refresh its lists (e.g. the Billed table) as soon as the data is
   *  actually there, instead of only on manual dismiss. */
  onTerminal?: () => void;
}

const POLL_INTERVAL_MS = 3000;

const TERMINAL_STATUSES = new Set(["completed", "partial", "failed"]);

const JOB_STATUS_CONFIG = {
  pending:    { icon: Clock,         color: "text-muted-foreground", label: "Pending" },
  processing: { icon: Loader2,       color: "text-blue-500",         label: "Processing", spin: true },
  sent:       { icon: CheckCircle2,  color: "text-green-600",        label: "Sent" },
  failed:     { icon: AlertCircle,   color: "text-destructive",      label: "Failed" },
  skipped:    { icon: SkipForward,   color: "text-muted-foreground", label: "Skipped" },
} as const;

const RUN_STATUS_BADGE: Record<string, string> = {
  queued:    "bg-muted text-muted-foreground",
  running:   "bg-blue-100 text-blue-700",
  completed: "bg-green-100 text-green-700",
  partial:   "bg-yellow-100 text-yellow-700",
  failed:    "bg-red-100 text-red-700",
};

function JobRow({ job, onRetry }: { job: DispatchJob; onRetry: (jobId: string) => void }) {
  const cfg = JOB_STATUS_CONFIG[job.status];
  const Icon = cfg.icon;
  const billingLabel = job.billing_mode === "gst_direct" ? "GST Direct" : "Proforma First";

  const isFailed = job.status === "failed";

  return (
    <div className={`rounded-lg p-3 ${
      isFailed
        ? "border-2 border-red-500 bg-red-50 shadow-sm shadow-red-200"
        : "border border-border"
    }`}>
      {/* Failed banner */}
      {isFailed && (
        <div className="flex items-center gap-1.5 mb-2">
          <AlertCircle className="h-4 w-4 text-red-600 shrink-0" />
          <span className="text-xs font-bold text-red-700 uppercase tracking-wide">Action Required</span>
        </div>
      )}

      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <Icon
            className={`h-4 w-4 shrink-0 ${cfg.color} ${"spin" in cfg ? "animate-spin" : ""}`}
          />
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className={`font-mono text-sm font-medium ${isFailed ? "text-red-800" : ""}`}>
                {job.contract_number}
              </span>
              {job.customer_name && (
                <span className={`text-sm truncate max-w-[200px] ${isFailed ? "text-red-700" : "text-muted-foreground"}`}>
                  {job.customer_name}
                </span>
              )}
              <Badge variant="outline" className="text-xs">{billingLabel}</Badge>
            </div>
            {job.dispatched_to && job.status === "sent" && (
              <p className="text-xs text-muted-foreground mt-0.5">→ {job.dispatched_to}</p>
            )}
            {job.error_suggestion && isFailed && (
              <p className="text-xs text-red-700 font-medium mt-1">{job.error_suggestion}</p>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {job.status !== "pending" && job.status !== "processing" && (
            <span className={`text-xs whitespace-nowrap ${isFailed ? "text-red-600 font-semibold" : "text-muted-foreground"}`}>
              {job.attempt_count}/{job.max_attempts} attempts
            </span>
          )}
          <Badge className={`text-xs capitalize font-semibold ${
            job.status === "sent"       ? "bg-green-100 text-green-700" :
            job.status === "failed"     ? "bg-red-600 text-white" :
            job.status === "skipped"    ? "bg-gray-100 text-gray-600" :
            job.status === "processing" ? "bg-blue-100 text-blue-700" :
            "bg-muted text-muted-foreground"
          }`}>
            {cfg.label}
          </Badge>
          {isFailed && (
            <Button
              size="sm"
              variant="destructive"
              className="h-7 px-3 text-xs font-semibold"
              onClick={() => onRetry(job.id)}
            >
              <RefreshCw className="h-3 w-3 mr-1" />
              Retry
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

export function DispatchRunPanel({ runId, onClose, onTerminal }: Props) {
  const [run, setRun] = useState<DispatchRun | null>(null);
  const [jobs, setJobs] = useState<DispatchJob[]>([]);
  const [retrying, setRetrying] = useState<Set<string>>(new Set());
  const [lastCheckedAt, setLastCheckedAt] = useState<Date | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const poll = async () => {
    const res = await fetch(`/api/billing/dispatch-run/${runId}`);
    if (!res.ok) return;
    const data = await res.json();
    if (data.run) setRun(data.run as DispatchRun);
    if (data.jobs) setJobs(data.jobs as DispatchJob[]);
    setLastCheckedAt(new Date());
  };

  useEffect(() => {
    poll();
    pollRef.current = setInterval(async () => {
      await poll();
      if (run && TERMINAL_STATUSES.has(run.status)) {
        clearInterval(pollRef.current!);
      }
    }, POLL_INTERVAL_MS);

    return () => { if (pollRef.current) clearInterval(pollRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId]);

  // Stop polling when run is terminal
  useEffect(() => {
    if (run && TERMINAL_STATUSES.has(run.status) && pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, [run]);

  // Let the parent refresh its lists (e.g. the Billed table) as soon as the
  // run finishes, rather than only when the user manually clicks Close —
  // the underlying statements already exist at this point, but nothing
  // that fetched them earlier knows to look again. Depending on run.status
  // (not the whole run object) means this fires once per terminal
  // transition — including a second time after a Retry brings a
  // partial/failed run back to "running" and then terminal again.
  useEffect(() => {
    if (run && TERMINAL_STATUSES.has(run.status)) {
      onTerminal?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run?.status]);

  const handleRetry = async (jobId: string) => {
    setRetrying((prev) => new Set([...prev, jobId]));
    try {
      const res = await fetch(`/api/billing/dispatch-run/${runId}/retry-job/${jobId}`, {
        method: "POST",
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        toast.error(err.error || "Failed to queue retry");
        return;
      }
      toast.success("Retrying now — this should update within a few seconds");
      // Re-open polling if run was terminal
      if (run && TERMINAL_STATUSES.has(run.status)) {
        setRun((r) => r ? { ...r, status: "running" } : r);
        pollRef.current = setInterval(poll, POLL_INTERVAL_MS);
      }
      await poll();
    } finally {
      setRetrying((prev) => { const next = new Set(prev); next.delete(jobId); return next; });
    }
  };

  if (!run) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const isRunning = !TERMINAL_STATUSES.has(run.status);
  const pct = run.total_jobs > 0 ? Math.round(((run.done_jobs + run.failed_jobs) / run.total_jobs) * 100) : 0;
  const failedJobs = jobs.filter((j) => j.status === "failed");
  const sentJobs   = jobs.filter((j) => j.status === "sent" || j.status === "skipped");
  const pendingJobs = jobs.filter((j) => j.status === "pending" || j.status === "processing");

  return (
    <div className="flex flex-col gap-4">
      {/* Run header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {isRunning && <Loader2 className="h-4 w-4 animate-spin text-blue-500" />}
          <span className="font-semibold text-sm">
            {run.done_jobs + run.failed_jobs}/{run.total_jobs} jobs complete
          </span>
          <Badge className={`text-xs capitalize ${RUN_STATUS_BADGE[run.status] || ""}`}>
            {run.status}
          </Badge>
          {isRunning && lastCheckedAt && (
            <span className="text-xs text-muted-foreground">
              · last checked {lastCheckedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
            </span>
          )}
        </div>
        {onClose && (
          <Button size="sm" variant="ghost" onClick={onClose} className="h-7 px-2 text-xs">
            Close
          </Button>
        )}
      </div>

      {/* Progress bar */}
      <div className="w-full h-2 bg-muted rounded-full overflow-hidden">
        <div
          className="h-full bg-primary rounded-full transition-all duration-500"
          style={{ width: `${pct}%` }}
        />
      </div>

      {/* Stats row */}
      <div className="flex gap-4 text-xs text-muted-foreground">
        <span className="text-green-600 font-medium">{run.done_jobs} sent</span>
        {run.failed_jobs > 0 && (
          <span className="text-destructive font-medium">{run.failed_jobs} failed</span>
        )}
        {isRunning && (
          <span>{pendingJobs.length} pending</span>
        )}
      </div>

      {/* Job list */}
      <div className="flex flex-col gap-2 max-h-[420px] overflow-y-auto">
        {/* Failed first — needs operator attention */}
        {failedJobs.map((job) => (
          <JobRow key={job.id} job={job} onRetry={handleRetry} />
        ))}

        {/* Pending/processing */}
        {pendingJobs.map((job) => (
          <JobRow key={job.id} job={job} onRetry={handleRetry} />
        ))}

        {/* Sent (collapsed at bottom) */}
        {sentJobs.map((job) => (
          <JobRow key={job.id} job={job} onRetry={handleRetry} />
        ))}
      </div>

      {/* Terminal state message */}
      {run.status === "completed" && (
        <div className="rounded-md bg-green-50 border border-green-200 px-3 py-2 text-center">
          <p className="text-sm text-green-700 font-semibold">All {run.total_jobs} invoices dispatched successfully.</p>
        </div>
      )}
      {run.status === "partial" && (
        <div className="rounded-md bg-yellow-50 border-2 border-yellow-400 px-3 py-2 flex items-center gap-2">
          <AlertCircle className="h-4 w-4 text-yellow-600 shrink-0" />
          <p className="text-sm text-yellow-800 font-semibold">
            {run.done_jobs} sent — {run.failed_jobs} failed. Fix the issues above and click Retry on each red row.
          </p>
        </div>
      )}
      {run.status === "failed" && (
        <div className="rounded-md bg-red-50 border-2 border-red-500 px-3 py-2 flex items-center gap-2">
          <AlertCircle className="h-5 w-5 text-red-600 shrink-0" />
          <p className="text-sm text-red-700 font-bold">
            All {run.total_jobs} jobs failed. Fix the suggested issues on each row and click Retry.
          </p>
        </div>
      )}
    </div>
  );
}
