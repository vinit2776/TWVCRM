"use client";

/**
 * My Issues — mobile-first technician home.
 * Mode toggle: Assigned to Me / Reported by Me — each with its own
 * Open / In Progress / Resolved Today tabs (same 3 tabs, different source list).
 * Sticky bottom: Report Issue.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { Plus, Wrench, AlertTriangle, ChevronRight, UserPlus, UserX } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  PRIORITY_STYLES, STATUS_STYLES, timeAgo, timeUntil,
} from "@/lib/facility-ui";
import { FacilityReportWizard } from "@/components/facility/report-wizard";
import { DelegateTaskDialog } from "@/components/facility/delegate-task-dialog";
import type { FacilityIssue, FacilityIssueStatus } from "@/types";

type Tab = "open" | "in_progress" | "resolved_today";
type Mode = "assigned" | "reported";

const TAB_LABEL: Record<Tab, string> = {
  open: "Open",
  in_progress: "In Progress",
  resolved_today: "Resolved Today",
};

const MODE_LABEL: Record<Mode, string> = {
  assigned: "Assigned to Me",
  reported: "Reported by Me",
};

// "assigned" filters by assigned_to=me; "reported" filters by reported_by=me —
// everything else (tab → status/date params) is identical for both.
const MODE_PARAM: Record<Mode, string> = {
  assigned: "assigned_to",
  reported: "reported_by",
};

export default function MyFacilityIssuesPage() {
  const [mode, setMode] = useState<Mode>("assigned");
  const [tab, setTab] = useState<Tab>("open");
  const [issues, setIssues] = useState<FacilityIssue[]>([]);
  const [loading, setLoading] = useState(true);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [delegateOpen, setDelegateOpen] = useState(false);

  // Counts for tabs (co-located with fetchData so both update on tab/mode change)
  const [counts, setCounts] = useState({ open: 0, in_progress: 0, resolved_today: 0 });

  const fetchData = async () => {
    setLoading(true);
    const modeParam = MODE_PARAM[mode];
    const params = new URLSearchParams({ [modeParam]: "me" });
    if (tab === "open") {
      params.set("only_open", "true");
    } else if (tab === "in_progress") {
      params.append("status", "in_progress");
    } else if (tab === "resolved_today") {
      const since = new Date();
      since.setHours(0, 0, 0, 0);
      params.append("status", "resolved");
      params.append("status", "closed");
      params.set("date_from", since.toISOString());
    }
    try {
      const res = await fetch(`/api/facility/issues?${params.toString()}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to load tasks");
      setIssues(json.data || []);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to load tasks");
      setIssues([]);
    } finally {
      setLoading(false);
    }

    // Refresh counts every time tab/mode changes
    try {
      const since = new Date();
      since.setHours(0, 0, 0, 0);
      const [o, p, t] = await Promise.all([
        fetch(`/api/facility/issues?${modeParam}=me&only_open=true`).then((r) => r.json()),
        fetch(`/api/facility/issues?${modeParam}=me&status=in_progress`).then((r) => r.json()),
        fetch(`/api/facility/issues?${modeParam}=me&status=resolved&status=closed&date_from=${since.toISOString()}`).then((r) => r.json()),
      ]);
      setCounts({
        open: (o.data ?? []).length,
        in_progress: (p.data ?? []).length,
        resolved_today: (t.data ?? []).length,
      });
    } catch {
      // counts are best-effort — don't toast on count failures
    }
  };

  useEffect(() => { fetchData(); /* eslint-disable-next-line */ }, [tab, mode]);

  return (
    <div className="p-4 md:p-6 max-w-3xl mx-auto pb-24 md:pb-6 space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-xl md:text-2xl font-semibold">My Tasks</h1>
          <p className="text-xs text-muted-foreground">
            {mode === "assigned" ? "Tickets assigned to you" : "Tickets you reported — track who's attending to them"}
          </p>
        </div>
        <div className="hidden md:flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => setDelegateOpen(true)}>
            <UserPlus className="h-4 w-4 mr-1" /> Delegate
          </Button>
          <Button size="sm" onClick={() => setWizardOpen(true)}>
            <Plus className="h-4 w-4 mr-1" /> New Task
          </Button>
        </div>
      </div>

      {/* Mode toggle — Assigned to Me / Reported by Me */}
      <div className="grid grid-cols-2 gap-1 rounded-lg bg-muted/40 p-1">
        {(["assigned", "reported"] as Mode[]).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => setMode(m)}
            className={cn(
              "py-1.5 text-xs font-medium rounded-md transition",
              mode === m ? "bg-background shadow-sm" : "text-muted-foreground",
            )}
          >
            {MODE_LABEL[m]}
          </button>
        ))}
      </div>

      {/* Tab strip — same Open/In Progress/Resolved Today for either mode */}
      <div className="grid grid-cols-3 gap-1 rounded-lg bg-muted/40 p-1">
        {(["open", "in_progress", "resolved_today"] as Tab[]).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={cn(
              "py-2 text-xs font-medium rounded-md transition flex flex-col items-center justify-center",
              tab === t ? "bg-background shadow-sm" : "text-muted-foreground",
            )}
          >
            <span>{TAB_LABEL[t]}</span>
            <span className={cn("text-[10px]", tab === t ? "text-foreground" : "text-muted-foreground/70")}>
              {counts[t]}
            </span>
          </button>
        ))}
      </div>

      {/* Issue cards */}
      {loading ? (
        <div className="text-center py-12 text-sm text-muted-foreground">Loading…</div>
      ) : issues.length === 0 ? (
        <div className="text-center py-16">
          <Wrench className="h-10 w-10 mx-auto opacity-30 mb-3" />
          <p className="text-sm text-muted-foreground">
            {mode === "assigned" && tab === "open" && "Nothing assigned to you. Nice work."}
            {mode === "assigned" && tab === "in_progress" && "Nothing in progress yet."}
            {mode === "assigned" && tab === "resolved_today" && "Nothing resolved today (yet)."}
            {mode === "reported" && tab === "open" && "Nothing you've reported is open right now."}
            {mode === "reported" && tab === "in_progress" && "Nothing you've reported is in progress."}
            {mode === "reported" && tab === "resolved_today" && "Nothing you've reported was resolved today."}
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {issues.map((i) => <Card key={i.id} issue={i} showAssignee={mode === "reported"} />)}
        </div>
      )}

      {/* Sticky mobile FAB */}
      <div className="fixed bottom-16 right-4 z-30 md:hidden">
        <Button size="lg" onClick={() => setWizardOpen(true)} className="rounded-full h-14 w-14 shadow-lg p-0">
          <Plus className="h-6 w-6" />
        </Button>
      </div>

      <FacilityReportWizard open={wizardOpen} onOpenChange={setWizardOpen} onCreated={() => fetchData()} />
      <DelegateTaskDialog open={delegateOpen} onOpenChange={setDelegateOpen} onCreated={() => fetchData()} />
    </div>
  );
}

function Card({ issue, showAssignee }: { issue: FacilityIssue; showAssignee: boolean }) {
  const isOpen: FacilityIssueStatus[] = ["new", "acknowledged", "in_progress", "reopened"];
  const open = isOpen.includes(issue.status);
  return (
    <Link
      href={`/facility/issues/${issue.id}`}
      className="block rounded-lg border bg-card p-3 active:bg-muted/40 transition"
    >
      <div className="flex items-start gap-3">
        <span className={cn("mt-1 h-3 w-3 rounded-full shrink-0", PRIORITY_STYLES[issue.priority].dot)} />
        <div className="min-w-0 flex-1">
          {/* Reported-by-me mode: who's attending to it is the whole point, so it leads the card. */}
          {showAssignee && (
            issue.assignee ? (
              <div className="text-xs font-medium text-[#015E65] mb-0.5">{issue.assignee.full_name}</div>
            ) : (
              <div className="text-xs font-semibold text-amber-700 bg-amber-50 ring-1 ring-amber-200 rounded px-1.5 py-0.5 inline-flex items-center gap-1 mb-1">
                <UserX className="h-3 w-3" /> Unclaimed — nobody&apos;s picked this up yet
              </div>
            )
          )}
          <div className="flex items-center gap-1.5 flex-wrap">
            <code className="text-[10px] font-mono text-muted-foreground">{issue.issue_number}</code>
            {issue.task_type === "delegated_task" && (
              <span className="text-[10px] px-1.5 py-0.5 rounded-full ring-1 bg-teal-50 text-teal-700 ring-teal-200 inline-flex items-center gap-0.5">
                <UserPlus className="h-2.5 w-2.5" /> Delegated
              </span>
            )}
            <span className={cn("text-[10px] px-1.5 py-0.5 rounded-full ring-1", STATUS_STYLES[issue.status].chip)}>
              {STATUS_STYLES[issue.status].label}
            </span>
            {issue.sla_breached && open && (
              <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-red-50 text-red-700 ring-1 ring-red-200 inline-flex items-center">
                <AlertTriangle className="h-2.5 w-2.5 mr-0.5" /> Breached
              </span>
            )}
          </div>
          <div className="text-sm font-medium mt-0.5 line-clamp-2">{issue.title}</div>
          <div className="text-xs text-muted-foreground mt-1 truncate">
            {issue.location?.name ?? "—"}{issue.category?.name ? ` · ${issue.category.name}` : ""} · {timeAgo(issue.created_at)}
            {open && issue.sla_target_at && (
              <> · <span className={issue.sla_breached ? "text-red-600 font-medium" : ""}>{timeUntil(issue.sla_target_at)}</span></>
            )}
          </div>
        </div>
        <ChevronRight className="h-4 w-4 text-muted-foreground self-center" />
      </div>
    </Link>
  );
}
