"use client";

import { useEffect, useState } from "react";
import { Send } from "lucide-react";
import { useHandoverJobsEnabled } from "@/hooks/use-handover-jobs";
import type { JobRow } from "@/lib/job-groups";
import { JOB_KIND_LABELS, type JobKind } from "@/lib/handover-jobs";
import { formatDate } from "@/lib/utils";

/**
 * The hand-over jobs still open on this lead, whoever they were given to, so a second person does
 * not start the same job. Shown only when handing over is switched on; clears itself when the job is done.
 * `version` changes whenever the page reloads the lead, so the line follows a fresh hand-over.
 */
export function LeadOpenJobs({ leadId, version }: { leadId: string; version?: unknown }) {
  const enabled = useHandoverJobsEnabled();
  const [jobs, setJobs] = useState<JobRow[]>([]);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    fetch(`/api/leads/jobs?lead_id=${encodeURIComponent(leadId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((json) => {
        if (!cancelled && json?.data) setJobs(json.data as JobRow[]);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [enabled, leadId, version]);

  if (!enabled || jobs.length === 0) return null;
  return (
    <div className="space-y-1">
      {jobs.map((j) => (
        <div key={j.id} className="flex flex-wrap items-center gap-x-2 rounded-md border border-sky-200 bg-sky-50 px-3 py-1.5 text-sm text-sky-900">
          <Send className="h-3.5 w-3.5 shrink-0" />
          <span>
            <b>{JOB_KIND_LABELS[j.kind as JobKind] ?? j.title}</b> handed to <b>{j.assignee?.full_name ?? "someone"}</b>
            {j.giver?.full_name ? ` by ${j.giver.full_name}` : ""}
            {j.due_date ? ` · due ${formatDate(j.due_date)}` : ""}
            {j.status === "in_progress" ? " · started" : ""}
          </span>
        </div>
      ))}
    </div>
  );
}
