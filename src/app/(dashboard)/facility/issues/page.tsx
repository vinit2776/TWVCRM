"use client";

/**
 * Facility Issues — list page (mobile-first; desktop uses table layout).
 *
 * Filters: search, scope, status, priority, location, assigned_to, sla_breached.
 * Top-right action: Report Issue → opens FacilityReportWizard.
 */

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  Plus, Search, Filter, X, Wifi, AlertTriangle, ChevronRight, RefreshCw,
} from "lucide-react";
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

export default function FacilityIssuesPage() {
  const [issues, setIssues] = useState<FacilityIssue[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [loading, setLoading] = useState(true);
  const [wizardOpen, setWizardOpen] = useState(false);

  // ---- filters -------------------------------------------------------------
  const [search, setSearch] = useState("");
  const [statusFilters, setStatusFilters] = useState<FacilityIssueStatus[]>([]);
  const [priority, setPriority] = useState<FacilityIssuePriority | "">("");
  const [locationId, setLocationId] = useState("");
  const [onlyOpen, setOnlyOpen] = useState(true);
  const [onlyMine, setOnlyMine] = useState(false);
  const [slaBreached, setSlaBreached] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);

  const fetchData = async () => {
    setLoading(true);
    const params = new URLSearchParams();
    if (priority) params.set("priority", priority);
    if (locationId) params.set("location_id", locationId);
    if (slaBreached) params.set("sla_breached", "true");
    if (onlyMine) params.set("assigned_to", "me");
    if (statusFilters.length > 0) {
      for (const s of statusFilters) params.append("status", s);
    } else if (onlyOpen) {
      params.set("only_open", "true");
    }

    const res = await fetch(`/api/facility/issues?${params.toString()}`);
    const json = await res.json();
    setIssues(json.data || []);
    setLoading(false);
  };

  useEffect(() => {
    fetch("/api/locations?is_active=true")
      .then((r) => r.json())
      .then((j) => setLocations(j.data || []));
  }, []);

  useEffect(() => {
    fetchData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [priority, locationId, slaBreached, onlyMine, onlyOpen, statusFilters]);

  // Client-side text search (server already returns the right scope)
  const filtered = useMemo(() => {
    if (!search.trim()) return issues;
    const q = search.toLowerCase();
    return issues.filter((i) =>
      i.title.toLowerCase().includes(q) ||
      i.issue_number.toLowerCase().includes(q) ||
      (i.description ?? "").toLowerCase().includes(q) ||
      (i.location?.name ?? "").toLowerCase().includes(q)
    );
  }, [issues, search]);

  return (
    <div className="p-4 md:p-6 max-w-7xl mx-auto space-y-4">
      {/* ───── Header ──────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-xl md:text-2xl font-semibold">Facility Issues</h1>
          <p className="text-xs md:text-sm text-muted-foreground">IT infrastructure tickets across all locations</p>
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
        <Chip active={onlyOpen} onClick={() => { setOnlyOpen(true); setStatusFilters([]); }}>Open only</Chip>
        <Chip active={onlyMine} onClick={() => setOnlyMine((v) => !v)}>Mine</Chip>
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
      ) : (
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

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
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

function IssueCard({ issue }: { issue: FacilityIssue }) {
  const sla = issue.sla_target_at;
  const isOpen = ["new", "acknowledged", "in_progress", "reopened"].includes(issue.status);
  return (
    <Link
      href={`/facility/issues/${issue.id}`}
      className="block rounded-lg border bg-card hover:border-foreground/20 hover:shadow-sm transition p-3"
    >
      <div className="flex items-start gap-3">
        <span className={cn("mt-1 h-2.5 w-2.5 rounded-full shrink-0", PRIORITY_STYLES[issue.priority].dot)} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <code className="text-xs font-mono text-muted-foreground">{issue.issue_number}</code>
            <span className={cn("text-[10px] px-1.5 py-0.5 rounded-full ring-1", STATUS_STYLES[issue.status].chip)}>
              {STATUS_STYLES[issue.status].label}
            </span>
            {issue.sla_breached && isOpen && (
              <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-red-50 text-red-700 ring-1 ring-red-200 inline-flex items-center">
                <AlertTriangle className="h-2.5 w-2.5 mr-0.5" /> Breached
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
          </div>
        </div>
        <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0 self-center" />
      </div>
    </Link>
  );
}
