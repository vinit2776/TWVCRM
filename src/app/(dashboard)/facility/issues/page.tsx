"use client";

/**
 * Facility Issues — list page (mobile-first; desktop uses table layout).
 *
 * Default view: all tickets grouped by status. Active groups (new, acknowledged,
 * in_progress, reopened) are expanded. Resolved / closed start collapsed but are
 * visible so the team can reference them without changing filters.
 *
 * Filters: search, scope, status, priority, location, assigned_to, sla_breached.
 * Top-right action: Report Issue → opens FacilityReportWizard.
 */

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  Plus, Search, Filter, X, Wifi, AlertTriangle, ChevronRight, RefreshCw, ChevronDown,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { FacilityReportWizard } from "@/components/facility/report-wizard";
import {
  PRIORITY_LIST, PRIORITY_STYLES, STATUS_LIST, STATUS_STYLES,
  timeAgo, timeUntil,
} from "@/lib/facility-ui";
import type {
  FacilityIssue, FacilityIssuePriority, FacilityIssueStatus,
} from "@/types";

interface Location { id: string; name: string; code: string }

// Active statuses rendered first; resolved/closed appended at bottom
const STATUS_ORDER: FacilityIssueStatus[] = [
  "reopened", "new", "acknowledged", "in_progress", "resolved", "closed",
];
const ACTIVE_STATUSES = new Set<FacilityIssueStatus>(["new", "acknowledged", "in_progress", "reopened"]);

export default function FacilityIssuesPage() {
  const [issues, setIssues] = useState<FacilityIssue[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [loading, setLoading] = useState(true);
  const [wizardOpen, setWizardOpen] = useState(false);
  // resolved + closed start collapsed; active groups start expanded
  const [collapsedGroups, setCollapsedGroups] = useState<Set<FacilityIssueStatus>>(
    new Set(["resolved", "closed"]),
  );

  // ---- filters -------------------------------------------------------------
  const [search, setSearch] = useState("");
  const [statusFilters, setStatusFilters] = useState<FacilityIssueStatus[]>([]);
  const [priority, setPriority] = useState<FacilityIssuePriority | "">("");
  const [locationId, setLocationId] = useState("");
  const [onlyOpen, setOnlyOpen] = useState(false);
  const [onlyMine, setOnlyMine] = useState(false);
  const [onlyUnowned, setOnlyUnowned] = useState(false);
  const [slaBreached, setSlaBreached] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);

  const fetchData = async () => {
    setLoading(true);
    const params = new URLSearchParams();
    if (priority) params.set("priority", priority);
    if (locationId) params.set("location_id", locationId);
    if (slaBreached) params.set("sla_breached", "true");
    if (onlyMine) params.set("assigned_to", "me");
    if (onlyUnowned) params.set("assigned_to", "unassigned");
    if (statusFilters.length > 0) {
      for (const s of statusFilters) params.append("status", s);
    } else if (onlyUnowned) {
      params.append("status", "new");
      params.append("status", "reopened");
    } else if (onlyOpen) {
      params.set("only_open", "true");
    }

    try {
      const res = await fetch(`/api/facility/issues?${params.toString()}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to load issues");
      setIssues(json.data || []);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to load issues");
      setIssues([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetch("/api/locations?is_active=true")
      .then((r) => r.json())
      .then((j) => setLocations(j.data || []));
  }, []);

  useEffect(() => {
    fetchData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [priority, locationId, slaBreached, onlyMine, onlyOpen, onlyUnowned, statusFilters]);

  // Client-side text search + sort for unowned view
  const filtered = useMemo(() => {
    let result = issues;
    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter((i) =>
        i.title.toLowerCase().includes(q) ||
        i.issue_number.toLowerCase().includes(q) ||
        (i.description ?? "").toLowerCase().includes(q) ||
        (i.location?.name ?? "").toLowerCase().includes(q)
      );
    }
    if (onlyUnowned) {
      // Sort: claim_sla_breached first, then by priority (critical → low), then by created_at
      const PRIORITY_WEIGHT: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
      result = [...result].sort((a, b) => {
        const aBreached = a.claim_sla_breached ? 0 : 1;
        const bBreached = b.claim_sla_breached ? 0 : 1;
        if (aBreached !== bBreached) return aBreached - bBreached;
        const aPri = PRIORITY_WEIGHT[a.priority] ?? 4;
        const bPri = PRIORITY_WEIGHT[b.priority] ?? 4;
        if (aPri !== bPri) return aPri - bPri;
        return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
      });
    }
    return result;
  }, [issues, search, onlyUnowned]);

  // Group by status in canonical order; only include groups that have issues
  const grouped = useMemo(() => {
    const map = new Map<FacilityIssueStatus, FacilityIssue[]>();
    for (const s of STATUS_ORDER) map.set(s, []);
    for (const issue of filtered) {
      map.get(issue.status)?.push(issue);
    }
    return STATUS_ORDER
      .map((s) => ({ status: s, items: map.get(s) ?? [] }))
      .filter(({ items }) => items.length > 0);
  }, [filtered]);

  // Show grouped view unless the user has drilled into specific statuses or is in unowned view
  const showGrouped = statusFilters.length === 0 && !onlyUnowned;

  const toggleGroup = (status: FacilityIssueStatus) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(status)) next.delete(status); else next.add(status);
      return next;
    });
  };

  return (
    <div className="p-4 md:p-6 max-w-7xl mx-auto space-y-4">
      {/* ───── Header ──────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-xl md:text-2xl font-semibold">Facility Issues</h1>
          <p className="text-xs md:text-sm text-muted-foreground">
            {showGrouped ? "All tickets · grouped by status" : "IT infrastructure tickets across all locations"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="icon" onClick={fetchData} title="Refresh" className="hidden sm:inline-flex">
            <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
          </Button>
          <Button size="sm" onClick={() => setWizardOpen(true)}>
            <Plus className="h-4 w-4 mr-1" /> Report Issue
          </Button>
        </div>
      </div>

      {/* ───── Search + filter toggle ──────────────────────────────────────── */}
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search title, number, location…"
            className="pl-9"
          />
        </div>
        <Button
          variant={filtersOpen ? "default" : "outline"}
          size="icon"
          onClick={() => setFiltersOpen((v) => !v)}
          title="Filters"
        >
          <Filter className="h-4 w-4" />
        </Button>
      </div>

      {/* ───── Quick filter chips (always visible) ────────────────────────── */}
      <div className="flex flex-wrap gap-1.5">
        <Chip active={onlyUnowned} onClick={() => { setOnlyUnowned((v) => !v); setOnlyOpen(false); setOnlyMine(false); setStatusFilters([]); }}>
          Unowned{issues.filter((i) => !i.assigned_to && (i.status === "new" || i.status === "reopened")).length > 0 && !onlyUnowned && (
            <span className="ml-1 bg-amber-500 text-white text-[9px] px-1 py-0.5 rounded-full font-bold">
              {issues.filter((i) => !i.assigned_to && (i.status === "new" || i.status === "reopened")).length}
            </span>
          )}
        </Chip>
        <Chip active={onlyOpen} onClick={() => { setOnlyOpen((v) => !v); setOnlyUnowned(false); setStatusFilters([]); }}>Open only</Chip>
        <Chip active={onlyMine} onClick={() => { setOnlyMine((v) => !v); setOnlyUnowned(false); }}>Mine</Chip>
        <Chip active={slaBreached} onClick={() => setSlaBreached((v) => !v)}>
          <AlertTriangle className="h-3 w-3 mr-1 inline" /> SLA breached
        </Chip>
        {(statusFilters.length > 0 || priority || locationId) && (
          <button
            type="button"
            onClick={() => { setStatusFilters([]); setPriority(""); setLocationId(""); }}
            className="px-2 py-1 text-xs rounded-full border border-dashed text-muted-foreground hover:bg-muted/40 inline-flex items-center"
          >
            <X className="h-3 w-3 mr-1" /> Clear
          </button>
        )}
      </div>

      {/* ───── Filter drawer ───────────────────────────────────────────────── */}
      {filtersOpen && (
        <div className="rounded-lg border bg-muted/20 p-3 space-y-3">
          <div>
            <div className="text-xs font-medium mb-1.5">Priority</div>
            <div className="flex flex-wrap gap-1.5">
              {PRIORITY_LIST.map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => setPriority((cur) => cur === p ? "" : p)}
                  className={cn(
                    "px-2.5 py-1 text-xs rounded-full border inline-flex items-center gap-1",
                    priority === p ? "bg-[#015E65] text-white border-[#015E65]" : "bg-background",
                  )}
                >
                  <span className={cn("h-2 w-2 rounded-full", PRIORITY_STYLES[p].dot)} />
                  {PRIORITY_STYLES[p].label}
                </button>
              ))}
            </div>
          </div>

          <div>
            <div className="text-xs font-medium mb-1.5">Status</div>
            <div className="flex flex-wrap gap-1.5">
              {STATUS_LIST.map((s) => {
                const sel = statusFilters.includes(s);
                return (
                  <button
                    key={s}
                    type="button"
                    onClick={() => {
                      setOnlyOpen(false);
                      setStatusFilters((cur) =>
                        cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s]
                      );
                    }}
                    className={cn(
                      "px-2.5 py-1 text-xs rounded-full border",
                      sel ? "bg-[#015E65] text-white border-[#015E65]" : "bg-background",
                    )}
                  >{STATUS_STYLES[s].label}</button>
                );
              })}
            </div>
          </div>

          <div>
            <div className="text-xs font-medium mb-1.5">Location</div>
            <select
              value={locationId}
              onChange={(e) => setLocationId(e.target.value)}
              className="h-9 px-2 rounded-md border bg-background text-sm w-full"
            >
              <option value="">All locations</option>
              {locations.map((l) => (
                <option key={l.id} value={l.id}>{l.name}</option>
              ))}
            </select>
          </div>
        </div>
      )}

      {/* ───── Issue list ──────────────────────────────────────────────────── */}
      {loading ? (
        <div className="text-sm text-muted-foreground py-12 text-center">Loading issues…</div>
      ) : filtered.length === 0 ? (
        <div className="text-sm text-muted-foreground py-12 text-center">
          <Wifi className="h-10 w-10 mx-auto opacity-30 mb-3" />
          No issues match these filters.
        </div>
      ) : showGrouped ? (
        /* ── Grouped view ─────────────────────────────────────────────────── */
        <div className="space-y-2">
          {grouped.map(({ status, items }) => {
            const collapsed = collapsedGroups.has(status);
            const isActive = ACTIVE_STATUSES.has(status);
            const breachedCount = items.filter((i) => i.sla_breached).length;
            return (
              <div key={status} className="rounded-lg border overflow-hidden">
                <button
                  type="button"
                  onClick={() => toggleGroup(status)}
                  className={cn(
                    "w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-muted/30 transition-colors",
                    isActive ? "bg-muted/10" : "bg-muted/40",
                  )}
                >
                  <span className={cn("text-[11px] px-2 py-0.5 rounded-full ring-1 font-medium shrink-0", STATUS_STYLES[status].chip)}>
                    {STATUS_STYLES[status].label}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {items.length} {items.length === 1 ? "issue" : "issues"}
                  </span>
                  {isActive && breachedCount > 0 && (
                    <span className="text-[10px] text-red-600 font-medium inline-flex items-center gap-0.5 ml-1">
                      <AlertTriangle className="h-2.5 w-2.5" />
                      {breachedCount} SLA breach{breachedCount > 1 ? "es" : ""}
                    </span>
                  )}
                  {!isActive && (
                    <span className="text-[10px] text-muted-foreground/50 ml-1">· for reference</span>
                  )}
                  <ChevronDown
                    className={cn(
                      "h-3.5 w-3.5 ml-auto text-muted-foreground transition-transform duration-150",
                      collapsed && "-rotate-90",
                    )}
                  />
                </button>

                {!collapsed && (
                  <div className="divide-y">
                    {items.map((i) => (
                      <IssueCard key={i.id} issue={i} inGroup />
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        /* ── Flat view (when status filter is active) ─────────────────────── */
        <div className="space-y-2">
          {filtered.map((i) => (
            <IssueCard key={i.id} issue={i} />
          ))}
        </div>
      )}

      <FacilityReportWizard
        open={wizardOpen}
        onOpenChange={setWizardOpen}
        onCreated={() => fetchData()}
      />
    </div>
  );
}

function Chip({ active, onClick, children }: {
  active: boolean; onClick: () => void; children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "px-2.5 py-1 text-xs rounded-full border inline-flex items-center",
        active ? "bg-[#015E65] text-white border-[#015E65]" : "bg-background hover:bg-muted/40",
      )}
    >
      {children}
    </button>
  );
}

function IssueCard({ issue, inGroup }: { issue: FacilityIssue; inGroup?: boolean }) {
  const sla = issue.sla_target_at;
  const isOpen = ACTIVE_STATUSES.has(issue.status);
  const isUnowned = !issue.assigned_to && (issue.status === "new" || issue.status === "reopened");
  const claimOverdue = isUnowned && issue.claim_sla_breached;

  return (
    <Link
      href={`/facility/issues/${issue.id}`}
      className={cn(
        "block bg-card hover:bg-muted/20 transition-colors p-3",
        !inGroup && "rounded-lg border hover:border-foreground/20 hover:shadow-sm",
        claimOverdue && !inGroup && "border-amber-300",
      )}
    >
      <div className="flex items-start gap-3">
        <span className={cn("mt-1 h-2.5 w-2.5 rounded-full shrink-0", PRIORITY_STYLES[issue.priority].dot)} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <code className="text-xs font-mono text-muted-foreground">{issue.issue_number}</code>
            {isUnowned && (
              <span className={cn(
                "text-[10px] px-1.5 py-0.5 rounded-full ring-1 font-medium",
                claimOverdue ? "bg-red-50 text-red-700 ring-red-200" : "bg-amber-50 text-amber-700 ring-amber-200",
              )}>
                {claimOverdue ? "Claim overdue" : "Unowned"}
              </span>
            )}
            {!inGroup && !isUnowned && (
              <span className={cn("text-[10px] px-1.5 py-0.5 rounded-full ring-1", STATUS_STYLES[issue.status].chip)}>
                {STATUS_STYLES[issue.status].label}
              </span>
            )}
            {issue.sla_breached && isOpen && (
              <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-red-50 text-red-700 ring-1 ring-red-200 inline-flex items-center">
                <AlertTriangle className="h-2.5 w-2.5 mr-0.5" /> SLA Breached
              </span>
            )}
          </div>
          <div className="text-sm font-medium mt-0.5 truncate">{issue.title}</div>
          <div className="text-xs text-muted-foreground mt-1 flex flex-wrap gap-2">
            <span>{issue.location?.name ?? "—"}</span>
            {issue.category?.name && <><span>·</span><span>{issue.category.name}</span></>}
            {issue.assignee?.full_name && <><span>·</span><span>👤 {issue.assignee.full_name}</span></>}
            <span>·</span>
            <span>{timeAgo(issue.created_at)}</span>
            {isOpen && sla && (
              <>
                <span>·</span>
                <span className={issue.sla_breached ? "text-red-600 font-medium" : ""}>SLA {timeUntil(sla)}</span>
              </>
            )}
            {isUnowned && issue.claim_sla_target_at && (
              <>
                <span>·</span>
                <span className={cn("font-medium", claimOverdue ? "text-red-600" : "text-amber-600")}>
                  {timeUntil(issue.claim_sla_target_at)}
                </span>
              </>
            )}
          </div>
        </div>
        <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0 self-center" />
      </div>
    </Link>
  );
}
