"use client";

import { useState, useMemo, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Plus, Search, ChevronLeft, ChevronRight, Users, Upload, SlidersHorizontal, Phone, CalendarDays, BarChart3 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { EmptyState } from "@/components/shared/empty-state";
import { TableSkeleton } from "@/components/shared/loading-skeleton";
import { useLeads, useUsers } from "@/hooks/use-leads";
import { LocationSelector } from "@/components/shared/location-selector";
import { MultiSelectFilter } from "@/components/shared/multi-select-filter";
import {
  LEAD_STATUSES,
  LEAD_STATUS_LABELS,
  LEAD_SOURCES,
  LEAD_SOURCE_LABELS,
} from "@/lib/constants";
import dynamic from "next/dynamic";
const ImportLeadsDialog = dynamic(
  () => import("@/components/leads/import-leads-dialog").then((m) => ({ default: m.ImportLeadsDialog })),
  { ssr: false }
);
import { useEnquiryNotifications } from "@/providers/enquiry-notifications-provider";
import { OverdueFollowupBanner, type FollowupSummary } from "@/components/leads/overdue-followup-banner";
import { EnquiryTracker } from "@/components/leads/enquiry-tracker";
import { LeadListRow } from "@/components/leads/lead-list-row";
import { LeadDayHeader } from "@/components/leads/lead-day-header";
import { groupByDay, istDayKey, type DaySummary } from "@/lib/lead-days";
import { PageBreadcrumb } from "@/components/page-breadcrumb";
import { pushTrailEntry } from "@/lib/nav-trail";

type LeadsTab = "enquiries" | "followups" | "all";

export default function LeadsPage() {
  const router = useRouter();
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [sourceFilter, setSourceFilter] = useState<string[]>([]);
  const [locationFilter, setLocationFilter] = useState<string | null>(null);
  const [searchInput, setSearchInput] = useState("");
  const [assignedToFilter, setAssignedToFilter] = useState<string>("");
  const [importOpen, setImportOpen] = useState(false);
  const [showDisabled, setShowDisabled] = useState(false);
  const [pinnedOnly, setPinnedOnly] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [tab, setTab] = useState<LeadsTab>("all");
  const [followupSummary, setFollowupSummary] = useState<FollowupSummary | null>(null);

  useEffect(() => {
    fetch("/api/leads/followup-summary")
      .then((res) => (res.ok ? res.json() : null))
      .then((json) => setFollowupSummary(json))
      .catch(() => {});
  }, []);

  const { users } = useUsers();
  const [daySummary, setDaySummary] = useState<Record<string, DaySummary>>({});

  const activeFilterCount =
    (statusFilter ? 1 : 0) +
    (sourceFilter.length > 0 ? 1 : 0) +
    (locationFilter ? 1 : 0) +
    (assignedToFilter ? 1 : 0) +
    (showDisabled ? 1 : 0);

  // Live enquiry data from shared context (real-time)
  const { items: enquiryItems, activeCount } = useEnquiryNotifications();

  const unresolvedItems = useMemo(
    () => enquiryItems.filter((i) => !i.resolvedAt),
    [enquiryItems]
  );
  const attentionLeadIds = useMemo(
    () => new Set(unresolvedItems.map((i) => i.leadId)),
    [unresolvedItems]
  );
  const reEnquiryLeadIds = useMemo(
    () => new Set(unresolvedItems.filter((i) => i.isReEnquiry).map((i) => i.leadId)),
    [unresolvedItems]
  );
  const isUnreadFormLead = (lead: { id: string }) =>
    unresolvedItems.some((i) => i.leadId === lead.id && !i.isReEnquiry);

  const { data: leads, pagination, loading, refetch } = useLeads({
    page,
    search,
    status: statusFilter || undefined,
    source: sourceFilter.length > 0 ? sourceFilter.join(",") : undefined,
    location_id: locationFilter || undefined,
    assigned_to: assignedToFilter || undefined,
    include_archived: showDisabled,
    pinned: pinnedOnly,
    view: tab === "followups" ? "overdue" : "all",
  });

  // Whole-day counts for the day headers, for the days this page spans, under the same filters.
  const leadDays = useMemo(() => {
    const keys = leads.map((l) => istDayKey(l.created_at)).sort();
    return keys.length > 0 ? { from: keys[0], to: keys[keys.length - 1] } : null;
  }, [leads]);
  useEffect(() => {
    if (tab !== "all" || !leadDays) return;
    const params = new URLSearchParams({ from: leadDays.from, to: leadDays.to });
    if (sourceFilter.length > 0) params.set("source", sourceFilter.join(","));
    if (locationFilter) params.set("location_id", locationFilter);
    if (assignedToFilter) params.set("assigned_to", assignedToFilter);
    let cancelled = false;
    fetch(`/api/leads/inflow?${params}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((json) => {
        if (!cancelled && json?.data) setDaySummary(json.data);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [tab, leadDays, sourceFilter, locationFilter, assignedToFilter]);

  // Client-side: sort leads — unresolved attention items first
  const sortedLeads = useMemo(() => {
    return [...leads].sort((a, b) => {
      const aPri = attentionLeadIds.has(a.id) ? 0 : 1;
      const bPri = attentionLeadIds.has(b.id) ? 0 : 1;
      return aPri - bPri;
    });
  }, [leads, attentionLeadIds]);

  const handleSearch = () => {
    setSearch(searchInput);
    setPage(1);
  };

  const switchTab = (next: LeadsTab) => {
    setTab(next);
    setPage(1);
  };

  // The follow-ups tab lists only leads with an overdue/due-today follow-up, but still
  // within whatever filters are applied — clear them so nothing hides the leads that need action.
  const handleReviewOverdue = () => {
    setTab("followups");
    setStatusFilter("");
    setSourceFilter([]);
    setLocationFilter(null);
    setAssignedToFilter("");
    setSearch("");
    setSearchInput("");
    setShowDisabled(false);
    setPage(1);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  return (
    <div className="space-y-4">
      <PageBreadcrumb resetTo={{ label: "Leads" }} />
      {/* Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Leads</h1>
          <p className="text-sm text-muted-foreground">
            {pagination.total} total leads
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => setImportOpen(true)}>
            <Upload className="mr-2 h-4 w-4" />
            Import CSV
          </Button>
          <Button variant="outline" onClick={() => router.push("/leads/overview")}>
            <BarChart3 className="mr-2 h-4 w-4" />
            Overview
          </Button>
          <Button variant="outline" onClick={() => router.push("/leads/calendar")}>
            <CalendarDays className="mr-2 h-4 w-4" />
            Calendar
          </Button>
          <Button variant="outline" onClick={() => router.push("/leads/new/call")}>
            <Phone className="mr-2 h-4 w-4" />
            Log a call
          </Button>
          <Button onClick={() => router.push("/leads/new")}>
            <Plus className="mr-2 h-4 w-4" />
            Create Lead
          </Button>
        </div>
      </div>

      {/* ── View tabs: new enquiries stay discoverable instead of competing with the follow-up backlog ── */}
      <div className="flex flex-wrap gap-2">
        {([
          { key: "enquiries", label: "New enquiries", count: activeCount, tone: "bg-emerald-500 text-white" },
          {
            key: "followups",
            label: "Follow-ups due",
            count: followupSummary ? followupSummary.overdue + followupSummary.due_today : 0,
            tone: "bg-red-500 text-white",
          },
          { key: "all", label: "All leads", count: 0, tone: "" },
        ] as const).map((t) => (
          <button
            key={t.key}
            onClick={() => switchTab(t.key)}
            className={`inline-flex items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-sm font-medium transition-colors ${
              tab === t.key
                ? "bg-foreground text-background border-foreground"
                : "text-muted-foreground hover:bg-muted"
            }`}
          >
            {t.label}
            {t.count > 0 && (
              <span className={`flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-[10px] font-bold ${t.tone}`}>
                {t.count}
              </span>
            )}
          </button>
        ))}
      </div>

      {tab === "enquiries" && <EnquiryTracker />}

      {tab !== "enquiries" && (
        <>
      {tab === "all" && <OverdueFollowupBanner summary={followupSummary} onReview={handleReviewOverdue} />}

      {/* Filters: search always visible, the rest behind one button so the list gets the room */}
      <div className="space-y-3">
        <div className="flex gap-2">
          <Input
            placeholder="Search leads..."
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSearch()}
            className="max-w-sm"
          />
          <Button variant="outline" size="icon" onClick={handleSearch}>
            <Search className="h-4 w-4" />
          </Button>
          <Button
            variant={pinnedOnly ? "default" : "outline"}
            onClick={() => {
              setPinnedOnly((v) => !v);
              setPage(1);
            }}
          >
            Pinned
          </Button>
          <Button
            variant={assignedToFilter === "none" ? "default" : "outline"}
            onClick={() => {
              setAssignedToFilter((v) => (v === "none" ? "" : "none"));
              setPage(1);
            }}
          >
            Unclaimed
          </Button>
          <Button variant={activeFilterCount > 0 ? "default" : "outline"} onClick={() => setFiltersOpen((v) => !v)}>
            <SlidersHorizontal className="mr-2 h-4 w-4" />
            Filters{activeFilterCount > 0 ? ` (${activeFilterCount})` : ""}
          </Button>
        </div>
        {(filtersOpen || activeFilterCount > 0) && (
          <div className="flex flex-wrap gap-2">
            <Select
              value={statusFilter}
              onValueChange={(val) => {
                setStatusFilter(val === "all" ? "" : val);
                setPage(1);
              }}
            >
              <SelectTrigger className="w-[160px]">
                <SelectValue placeholder="All Statuses" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Statuses</SelectItem>
                {LEAD_STATUSES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {LEAD_STATUS_LABELS[s]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <MultiSelectFilter
              options={LEAD_SOURCES.map((s) => ({ value: s, label: LEAD_SOURCE_LABELS[s] }))}
              selected={sourceFilter}
              onChange={(vals) => {
                setSourceFilter(vals);
                setPage(1);
              }}
              placeholder="All Sources"
            />
            <div className="w-[180px]">
              <LocationSelector
                value={locationFilter}
                onValueChange={(id) => {
                  setLocationFilter(id);
                  setPage(1);
                }}
                includeAllOption
                placeholder="All Locations"
              />
            </div>
            <Select
              value={assignedToFilter}
              onValueChange={(val) => {
                setAssignedToFilter(val === "all" ? "" : val);
                setPage(1);
              }}
            >
              <SelectTrigger className="w-[160px]">
                <SelectValue placeholder="All Owners" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Owners</SelectItem>
                <SelectItem value="none">Unclaimed (nobody handling)</SelectItem>
                {users.map((u) => (
                  <SelectItem key={u.id} value={u.id}>
                    {u.full_name || u.email}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              variant={showDisabled ? "default" : "outline"}
              onClick={() => {
                setShowDisabled((v) => !v);
                setPage(1);
              }}
            >
              {showDisabled ? "Hide disabled" : "Show disabled"}
            </Button>
          </div>
        )}
      </div>

      {/* List */}
      {loading ? (
        <TableSkeleton rows={8} />
      ) : sortedLeads.length === 0 ? (
        <EmptyState
          icon={Users}
          title={tab === "followups" ? "No follow-ups due" : "No leads found"}
          description={
            tab === "followups"
              ? "Nothing is overdue or due today with the current filters."
              : "Create your first lead or adjust your filters."
          }
          actionLabel={tab === "followups" ? undefined : "Create Lead"}
          onAction={tab === "followups" ? undefined : () => router.push("/leads/new")}
        />
      ) : (
        <div className="divide-y rounded-md border">
          {// The day view keeps the server's newest-first order: re-sorting would split a day into pieces.
          (tab === "all" ? groupByDay(leads) : [{ key: "", leads: sortedLeads }]).map((group) => (
            <div key={group.key || "flat"} className="divide-y">
              {group.key && (
                <LeadDayHeader dayKey={group.key} summary={daySummary[group.key]} pageCount={group.leads.length} />
              )}
              {group.leads.map((lead) => {
                const isFormLead = isUnreadFormLead(lead);
                return (
                  <LeadListRow
                    key={lead.id}
                    lead={lead}
                    unread={isFormLead}
                    reEnquiry={!isFormLead && reEnquiryLeadIds.has(lead.id)}
                    users={users}
                    onChanged={refetch}
                    onOpen={() => {
                      pushTrailEntry({ href: `/leads/${lead.id}/activity`, label: `${lead.first_name} ${lead.last_name}` });
                      router.push(`/leads/${lead.id}/activity`);
                    }}
                  />
                );
              })}
            </div>
          ))}
        </div>
      )}

      {/* Pagination */}
      {pagination.totalPages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">
            Page {pagination.page} of {pagination.totalPages}
          </p>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={page <= 1}
              onClick={() => setPage(page - 1)}
            >
              <ChevronLeft className="h-4 w-4" />
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={page >= pagination.totalPages}
              onClick={() => setPage(page + 1)}
            >
              Next
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}

        </>
      )}

      {/* Import Leads Dialog */}
      <ImportLeadsDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        onSuccess={refetch}
      />
    </div>
  );
}
