"use client";

/**
 * Facility Issues — list page (mobile-first; card grid on every breakpoint).
 *
 * Default view: grouped by assignee, "Unclaimed" pinned first so unowned
 * tickets stay visible instead of disappearing until someone claims them.
 * Each assignee's tickets split into Open/Closed tabs (Closed = resolved +
 * closed — anything off their plate, whether or not it's gone through the
 * final admin-only Close step).
 *
 * Filters: search, scope, status, priority, location, assigned_to, sla_breached.
 * Top-right action: Work Order → opens FacilityReportWizard.
 */

import { Suspense, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import {
  Plus, Search, Filter, X, Wifi, AlertTriangle, ChevronRight, RefreshCw, ChevronDown, UserPlus, User, Wrench,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn, getInitials } from "@/lib/utils";
import { FacilityReportWizard } from "@/components/facility/report-wizard";
import { DelegateTaskDialog } from "@/components/facility/delegate-task-dialog";
import {
  PRIORITY_LIST, PRIORITY_STYLES, STATUS_LIST, STATUS_STYLES, kpiPointsStyle,
  timeAgo, timeUntil,
} from "@/lib/facility-ui";
import type {
  FacilityIssue, FacilityIssuePriority, FacilityIssueStatus,
} from "@/types";

interface Location { id: string; name: string; code: string }

const ACTIVE_STATUSES = new Set<FacilityIssueStatus>(["new", "acknowledged", "in_progress", "reopened"]);
// "Closed" from an assignee's own point of view — resolved-but-not-yet-closed
// still reads as done to them, even though an admin hasn't closed it yet.
const DONE_STATUSES = new Set<FacilityIssueStatus>(["resolved", "closed"]);

const UNCLAIMED_KEY = "__unclaimed";

interface AssigneeGroup {
  key: string;
  name: string;
  openItems: FacilityIssue[];
  closedItems: FacilityIssue[];
}

export default function FacilityIssuesPage() {
  return (
    <Suspense fallback={<div className="p-4 md:p-6 text-sm text-muted-foreground">Loading…</div>}>
      <FacilityIssuesPageInner />
    </Suspense>
  );
}

function FacilityIssuesPageInner() {
  const searchParams = useSearchParams();
  const [issues, setIssues] = useState<FacilityIssue[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [loading, setLoading] = useState(true);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [delegateOpen, setDelegateOpen] = useState(false);
  // Groups that are all-closed (nothing open) start collapsed; anyone with
  // open work stays visible by default.
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  // Per-group Open/Closed tab — defaults to whichever bucket actually has
  // items, computed lazily the first time each group is seen (see render).
  const [groupTab, setGroupTab] = useState<Record<string, "open" | "closed">>({});

  // ---- filters -------------------------------------------------------------
  // Seeded from the URL on first render so links like Team KPI's
  // "?assigned_to=<id>&only_open=true" actually pre-filter the list.
  const [search, setSearch] = useState("");
  const [statusFilters, setStatusFilters] = useState<FacilityIssueStatus[]>([]);
  const [priority, setPriority] = useState<FacilityIssuePriority | "">("");
  const [locationId, setLocationId] = useState("");
  const [onlyOpen, setOnlyOpen] = useState(() => searchParams.get("only_open") === "true");
  const [onlyMine, setOnlyMine] = useState(false);
  const [onlyUnowned, setOnlyUnowned] = useState(false);
  const [slaBreached, setSlaBreached] = useState(false);
  const [assignedToFilter, setAssignedToFilter] = useState(() => searchParams.get("assigned_to") ?? "");
  const [filtersOpen, setFiltersOpen] = useState(() => !!searchParams.get("assigned_to"));

  const fetchData = async () => {
    setLoading(true);
    const params = new URLSearchParams();
    if (priority) params.set("priority", priority);
    if (locationId) params.set("location_id", locationId);
    if (slaBreached) params.set("sla_breached", "true");
    if (onlyMine) params.set("assigned_to", "me");
    else if (onlyUnowned) params.set("assigned_to", "unassigned");
    // Note: assignedToFilter (the "Assigned to" person picker) is applied
    // client-side in `filtered` below, not here — sending it server-side would
    // shrink `issues` to just that person's tasks, collapsing the picker's own
    // option list down to a single name the moment you pick someone.
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
      if (!res.ok) throw new Error(json.error || "Failed to load tasks");
      setIssues(json.data || []);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to load tasks");
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

  // Distinct assignees currently present in the loaded set — only people who
  // actually have a task show up, so the dropdown doesn't list the whole company.
  const assigneeOptions = useMemo(() => {
    const byId = new Map<string, string>();
    for (const i of issues) {
      if (i.assignee) byId.set(i.assignee.id, i.assignee.full_name);
    }
    return [...byId.entries()]
      .map(([id, full_name]) => ({ id, full_name }))
      .sort((a, b) => a.full_name.localeCompare(b.full_name));
  }, [issues]);

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
    if (assignedToFilter) {
      result = result.filter((i) => i.assigned_to === assignedToFilter);
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
  }, [issues, search, onlyUnowned, assignedToFilter]);

  // Group by assignee — "Unclaimed" pinned first (own bucket so tickets
  // nobody owns stay visible instead of disappearing until claimed), then
  // one group per person alphabetically. Each group splits into open/closed
  // so a technician can see "what's on my plate" vs "what I've finished"
  // without status jargon.
  const groupedByAssignee = useMemo(() => {
    const map = new Map<string, { name: string; items: FacilityIssue[] }>();
    for (const issue of filtered) {
      const key = issue.assignee?.id ?? UNCLAIMED_KEY;
      const name = issue.assignee?.full_name ?? "Unclaimed";
      if (!map.has(key)) map.set(key, { name, items: [] });
      map.get(key)!.items.push(issue);
    }
    const groups: AssigneeGroup[] = [...map.entries()].map(([key, { name, items }]) => ({
      key,
      name,
      openItems: items.filter((i) => ACTIVE_STATUSES.has(i.status)),
      closedItems: items.filter((i) => DONE_STATUSES.has(i.status)),
    }));
    groups.sort((a, b) => {
      if (a.key === UNCLAIMED_KEY) return -1;
      if (b.key === UNCLAIMED_KEY) return 1;
      return a.name.localeCompare(b.name);
    });
    return groups;
  }, [filtered]);

  const toggleGroup = (key: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  const tabFor = (group: AssigneeGroup): "open" | "closed" =>
    groupTab[group.key] ?? (group.openItems.length > 0 ? "open" : "closed");

  return (
    <div className="p-4 md:p-6 max-w-7xl mx-auto space-y-4">
      {/* ───── Header ──────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-xl md:text-2xl font-semibold">Tasks / Work Orders</h1>
          <p className="text-xs md:text-sm text-muted-foreground">
            All tickets · grouped by assignee
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="icon" onClick={fetchData} title="Refresh" className="hidden sm:inline-flex">
            <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
          </Button>
          <Button variant="outline" size="sm" onClick={() => setDelegateOpen(true)}>
            <UserPlus className="h-4 w-4 mr-1" /> Task
          </Button>
          <Button size="sm" onClick={() => setWizardOpen(true)}>
            <Plus className="h-4 w-4 mr-1" /> Work Order
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
        <Chip active={onlyUnowned} onClick={() => { setOnlyUnowned((v) => !v); setOnlyOpen(false); setOnlyMine(false); setAssignedToFilter(""); setStatusFilters([]); }}>
          Unclaimed{issues.filter((i) => !i.assigned_to && (i.status === "new" || i.status === "reopened")).length > 0 && !onlyUnowned && (
            <span className="ml-1 bg-amber-500 text-white text-[9px] px-1 py-0.5 rounded-full font-bold">
              {issues.filter((i) => !i.assigned_to && (i.status === "new" || i.status === "reopened")).length}
            </span>
          )}
        </Chip>
        <Chip active={onlyOpen} onClick={() => { setOnlyOpen((v) => !v); setOnlyUnowned(false); setStatusFilters([]); }}>Open only</Chip>
        <Chip active={onlyMine} onClick={() => { setOnlyMine((v) => !v); setOnlyUnowned(false); setAssignedToFilter(""); }}>Mine</Chip>
        <Chip active={slaBreached} onClick={() => setSlaBreached((v) => !v)}>
          <AlertTriangle className="h-3 w-3 mr-1 inline" /> Overdue <span className="opacity-70 ml-0.5">(SLA)</span>
        </Chip>
        {(statusFilters.length > 0 || priority || locationId || assignedToFilter) && (
          <button
            type="button"
            onClick={() => { setStatusFilters([]); setPriority(""); setLocationId(""); setAssignedToFilter(""); }}
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
                    "min-h-[44px] px-3 py-1 text-xs rounded-full border inline-flex items-center gap-1",
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
                      "min-h-[44px] px-3 py-1 text-xs rounded-full border",
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

          <div>
            <div className="text-xs font-medium mb-1.5">Assigned to</div>
            <select
              value={assignedToFilter}
              onChange={(e) => {
                setAssignedToFilter(e.target.value);
                if (e.target.value) { setOnlyMine(false); setOnlyUnowned(false); }
              }}
              className="h-9 px-2 rounded-md border bg-background text-sm w-full"
            >
              <option value="">Everyone</option>
              {assigneeOptions.map((a) => (
                <option key={a.id} value={a.id}>{a.full_name}</option>
              ))}
            </select>
            {assigneeOptions.length === 0 && (
              <p className="text-[11px] text-muted-foreground mt-1">
                No one has a task in the currently loaded set — clear other filters to widen it.
              </p>
            )}
          </div>
        </div>
      )}

      {/* ───── Issue list — grouped by assignee ─────────────────────────────── */}
      {loading ? (
        <div className="text-sm text-muted-foreground py-12 text-center">Loading issues…</div>
      ) : filtered.length === 0 ? (
        <div className="text-sm text-muted-foreground py-12 text-center">
          <Wifi className="h-10 w-10 mx-auto opacity-30 mb-3" />
          No issues match these filters.
        </div>
      ) : (
        <div className="space-y-3">
          {groupedByAssignee.map((group) => {
            const collapsed = collapsedGroups.has(group.key);
            const tab = tabFor(group);
            const activeItems = tab === "open" ? group.openItems : group.closedItems;
            const breachedCount = group.openItems.filter((i) => i.sla_breached).length;
            const isUnclaimed = group.key === UNCLAIMED_KEY;

            return (
              <div key={group.key} className="rounded-lg border overflow-hidden">
                <button
                  type="button"
                  onClick={() => toggleGroup(group.key)}
                  className={cn(
                    "w-full flex items-center gap-2.5 px-3 py-2.5 text-left hover:bg-muted/30 transition-colors",
                    isUnclaimed ? "bg-amber-50/60" : "bg-muted/10",
                  )}
                >
                  <span className={cn(
                    "h-7 w-7 rounded-full flex items-center justify-center text-[11px] font-semibold shrink-0",
                    isUnclaimed ? "bg-amber-200 text-amber-800" : "bg-[#015E65]/15 text-[#015E65]",
                  )}>
                    {isUnclaimed ? <User className="h-3.5 w-3.5" /> : getInitials(group.name)}
                  </span>
                  <span className="text-sm font-medium shrink-0">{group.name}</span>
                  <span className="text-xs text-muted-foreground">
                    {group.openItems.length} open · {group.closedItems.length} closed
                  </span>
                  {breachedCount > 0 && (
                    <span className="text-[10px] text-red-600 font-medium inline-flex items-center gap-0.5 ml-1">
                      <AlertTriangle className="h-2.5 w-2.5" />
                      {breachedCount} overdue
                    </span>
                  )}
                  <ChevronDown
                    className={cn(
                      "h-3.5 w-3.5 ml-auto text-muted-foreground transition-transform duration-150 shrink-0",
                      collapsed && "-rotate-90",
                    )}
                  />
                </button>

                {!collapsed && (
                  <div className="p-3 space-y-3">
                    {group.openItems.length > 0 && group.closedItems.length > 0 && (
                      <div className="flex items-center gap-1 rounded-md bg-muted/40 p-0.5 w-fit">
                        <button
                          type="button"
                          onClick={() => setGroupTab((prev) => ({ ...prev, [group.key]: "open" }))}
                          className={cn(
                            "px-3 py-1 text-xs font-medium rounded-sm transition min-h-[36px]",
                            tab === "open" ? "bg-background shadow-sm" : "text-muted-foreground",
                          )}
                        >Open ({group.openItems.length})</button>
                        <button
                          type="button"
                          onClick={() => setGroupTab((prev) => ({ ...prev, [group.key]: "closed" }))}
                          className={cn(
                            "px-3 py-1 text-xs font-medium rounded-sm transition min-h-[36px]",
                            tab === "closed" ? "bg-background shadow-sm" : "text-muted-foreground",
                          )}
                        >Closed ({group.closedItems.length})</button>
                      </div>
                    )}
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      {activeItems.map((i) => (
                        <IssueCard key={i.id} issue={i} />
                      ))}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <FacilityReportWizard
        open={wizardOpen}
        onOpenChange={setWizardOpen}
        onCreated={() => fetchData()}
      />

      <DelegateTaskDialog
        open={delegateOpen}
        onOpenChange={setDelegateOpen}
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
        "min-h-[44px] px-3 py-1 text-xs rounded-full border inline-flex items-center",
        active ? "bg-[#015E65] text-white border-[#015E65]" : "bg-background hover:bg-muted/40",
      )}
    >
      {children}
    </button>
  );
}

function IssueCard({ issue }: { issue: FacilityIssue }) {
  const sla = issue.sla_target_at;
  const isOpen = ACTIVE_STATUSES.has(issue.status);
  const isUnowned = !issue.assigned_to && (issue.status === "new" || issue.status === "reopened");
  const claimOverdue = isUnowned && issue.claim_sla_breached;
  const isTask = issue.task_type === "delegated_task";

  return (
    <Link
      href={`/facility/issues/${issue.id}`}
      className={cn(
        "block hover:shadow-sm transition-colors p-3 rounded-lg",
        isTask
          ? "bg-teal-100 border-2 border-teal-400 hover:border-teal-500"
          : "bg-card border hover:bg-muted/20 hover:border-foreground/20",
        claimOverdue && !isTask && "border-amber-300",
      )}
    >
      <div className="flex items-start gap-3">
        <span className={cn("mt-1 h-2.5 w-2.5 rounded-full shrink-0", PRIORITY_STYLES[issue.priority].dot)} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <code className={cn("text-xs font-mono", isTask ? "text-teal-800" : "text-muted-foreground")}>{issue.issue_number}</code>
            {isTask ? (
              <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-white text-teal-800 font-semibold inline-flex items-center gap-0.5">
                <UserPlus className="h-2.5 w-2.5" /> Task
              </span>
            ) : (
              <span className="text-[10px] px-1.5 py-0.5 rounded-full ring-1 bg-slate-50 text-slate-700 ring-slate-200 inline-flex items-center gap-0.5">
                <Wrench className="h-2.5 w-2.5" /> Work Order
              </span>
            )}
            {isUnowned && (
              <span className={cn(
                "text-[10px] px-1.5 py-0.5 rounded-full ring-1 font-medium",
                claimOverdue ? "bg-red-50 text-red-700 ring-red-200" : "bg-amber-50 text-amber-700 ring-amber-200",
              )}>
                {claimOverdue ? "Claim overdue" : "Unclaimed"}
              </span>
            )}
            {!isUnowned && (
              <span className={cn("text-[10px] px-1.5 py-0.5 rounded-full ring-1", STATUS_STYLES[issue.status].chip)}>
                {STATUS_STYLES[issue.status].label}
              </span>
            )}
            {issue.sla_breached && isOpen && (
              <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-red-50 text-red-700 ring-1 ring-red-200 inline-flex items-center">
                <AlertTriangle className="h-2.5 w-2.5 mr-0.5" /> SLA Breached
              </span>
            )}
            {issue.kpi_points != null && (
              <span className={cn("text-[10px] px-1.5 py-0.5 rounded-full ring-1 font-medium", kpiPointsStyle(issue.kpi_points).className)}>
                {kpiPointsStyle(issue.kpi_points).label}
              </span>
            )}
          </div>
          <div className={cn("text-sm font-medium mt-0.5 truncate", isTask && "text-teal-950")}>{issue.title}</div>
          <div className={cn("text-xs mt-1 flex flex-wrap gap-2", isTask ? "text-teal-700" : "text-muted-foreground")}>
            <span>{issue.location?.name ?? "—"}</span>
            {issue.category?.name && <><span>·</span><span>{issue.category.name}</span></>}
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
