"use client";

/**
 * My Issues — mobile-first technician home.
 * Tabs: Open / In Progress / Resolved Today.
 * Sticky bottom: Report Issue.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { Plus, Wrench, AlertTriangle, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  PRIORITY_STYLES, STATUS_STYLES, timeAgo, timeUntil,
} from "@/lib/facility-ui";
import { FacilityReportWizard } from "@/components/facility/report-wizard";
import type { FacilityIssue, FacilityIssueStatus } from "@/types";

type Tab = "open" | "in_progress" | "resolved_today";

const TAB_LABEL: Record<Tab, string> = {
  open: "Open",
  in_progress: "In Progress",
  resolved_today: "Resolved Today",
};

export default function MyFacilityIssuesPage() {
  const [tab, setTab] = useState<Tab>("open");
  const [issues, setIssues] = useState<FacilityIssue[]>([]);
  const [loading, setLoading] = useState(true);
  const [wizardOpen, setWizardOpen] = useState(false);

  const fetchData = async () => {
    setLoading(true);
    const params = new URLSearchParams({ assigned_to: "me" });
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
    const res = await fetch(`/api/facility/issues?${params.toString()}`);
    const json = await res.json();
    setIssues(json.data || []);
    setLoading(false);
  };

  useEffect(() => { fetchData(); /* eslint-disable-next-line */ }, [tab]);

  // Counts for tabs
  const [counts, setCounts] = useState({ open: 0, in_progress: 0, resolved_today: 0 });
  useEffect(() => {
    const since = new Date();
    since.setHours(0, 0, 0, 0);
    Promise.all([
      fetch("/api/facility/issues?assigned_to=me&only_open=true").then((r) => r.json()),
      fetch("/api/facility/issues?assigned_to=me&status=in_progress").then((r) => r.json()),
      fetch(`/api/facility/issues?assigned_to=me&status=resolved&status=closed&date_from=${since.toISOString()}`).then((r) => r.json()),
    ]).then(([o, p, t]) => setCounts({
      open: (o.data ?? []).length,
      in_progress: (p.data ?? []).length,
      resolved_today: (t.data ?? []).length,
    }));
  }, [issues.length]);

  return (
    <div className="p-4 md:p-6 max-w-3xl mx-auto pb-24 md:pb-6 space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-xl md:text-2xl font-semibold">My Issues</h1>
          <p className="text-xs text-muted-foreground">Tickets assigned to you</p>
        </div>
        <Button size="sm" onClick={() => setWizardOpen(true)} className="hidden md:inline-flex">
          <Plus className="h-4 w-4 mr-1" /> Report Issue
        </Button>
      </div>

      {/* Tab strip */}
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
            {tab === "open" && "Nothing assigned to you. Nice work."}
            {tab === "in_progress" && "Nothing in progress yet."}
            {tab === "resolved_today" && "Nothing resolved today (yet)."}
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {issues.map((i) => <Card key={i.id} issue={i} />)}
        </div>
      )}

      {/* Sticky mobile FAB */}
      <div className="fixed bottom-16 right-4 z-30 md:hidden">
        <Button size="lg" onClick={() => setWizardOpen(true)} className="rounded-full h-14 w-14 shadow-lg p-0">
          <Plus className="h-6 w-6" />
        </Button>
      </div>

      <FacilityReportWizard open={wizardOpen} onOpenChange={setWizardOpen} onCreated={() => fetchData()} />
    </div>
  );
}

function Card({ issue }: { issue: FacilityIssue }) {
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
          <div className="flex items-center gap-1.5 flex-wrap">
            <code className="text-[10px] font-mono text-muted-foreground">{issue.issue_number}</code>
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
