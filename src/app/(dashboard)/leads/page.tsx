"use client";

import { useState, useMemo } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Plus, Search, ChevronLeft, ChevronRight, Users, Upload, AlertTriangle, Clock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { StatusBadge, RatingBadge } from "@/components/shared/status-badge";
import { EmptyState } from "@/components/shared/empty-state";
import { TableSkeleton } from "@/components/shared/loading-skeleton";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useLeads, useUsers } from "@/hooks/use-leads";
import { LocationSelector } from "@/components/shared/location-selector";
import {
  LEAD_STATUSES,
  LEAD_STATUS_LABELS,
  LEAD_SOURCES,
  LEAD_SOURCE_LABELS,
} from "@/lib/constants";
import { formatDate } from "@/lib/utils";
import dynamic from "next/dynamic";
const ImportLeadsDialog = dynamic(
  () => import("@/components/leads/import-leads-dialog").then((m) => ({ default: m.ImportLeadsDialog })),
  { ssr: false }
);
import { useEnquiryNotifications } from "@/providers/enquiry-notifications-provider";
import { EnquiryQueueRow } from "@/components/enquiries/enquiry-queue-row";
import { OverdueFollowupBanner } from "@/components/leads/overdue-followup-banner";
import { PageBreadcrumb } from "@/components/page-breadcrumb";
import { pushTrailEntry } from "@/lib/nav-trail";

export default function LeadsPage() {
  const router = useRouter();
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [sourceFilter, setSourceFilter] = useState<string>("");
  const [locationFilter, setLocationFilter] = useState<string | null>(null);
  const [searchInput, setSearchInput] = useState("");
  const [assignedToFilter, setAssignedToFilter] = useState<string>("");
  const [importOpen, setImportOpen] = useState(false);
  const [showDisabled, setShowDisabled] = useState(false);

  const { users } = useUsers();

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
  const hasPinned = enquiryItems.length > 0;

  const { data: leads, pagination, loading, refetch } = useLeads({
    page,
    search,
    status: statusFilter || undefined,
    source: sourceFilter || undefined,
    location_id: locationFilter || undefined,
    assigned_to: assignedToFilter || undefined,
    include_archived: showDisabled,
  });

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

  // Overdue follow-ups sort to the top of page 1 by default, but only within whatever
  // filters are currently applied — clear them so nothing hides the leads that need action.
  const handleReviewOverdue = () => {
    setStatusFilter("");
    setSourceFilter("");
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
          <Button onClick={() => router.push("/leads/new")}>
            <Plus className="mr-2 h-4 w-4" />
            Create Lead
          </Button>
        </div>
      </div>

      {/* ── Overdue follow-ups need action — visible regardless of default page/filters ── */}
      <OverdueFollowupBanner onReview={handleReviewOverdue} />

      {/* ── Pinned: Public-form enquiries needing attention (real-time) ── */}
      {hasPinned && (
        <div className="rounded-lg border-2 border-emerald-400 bg-emerald-50/60 dark:bg-emerald-950/20 overflow-hidden">
          <div className="flex items-center justify-between px-4 py-2.5 bg-emerald-100/60 dark:bg-emerald-900/30 border-b border-emerald-300/60">
            <div className="flex items-center gap-2">
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
              </span>
              <span className="text-xs font-semibold text-emerald-800 dark:text-emerald-200 uppercase tracking-wider">
                Public-form enquiries
              </span>
              {activeCount > 0 && (
                <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-emerald-500 px-1.5 text-[10px] font-bold text-white">
                  {activeCount}
                </span>
              )}
            </div>
            <Link
              href="/leads/enquiry-log"
              className="text-xs font-medium text-emerald-700 hover:underline underline-offset-2"
            >
              Enquiry log →
            </Link>
          </div>

          <div className="p-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {enquiryItems.map((item) => (
              <EnquiryQueueRow key={item.leadId} item={item} />
            ))}
          </div>
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="flex flex-1 gap-2">
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
        </div>
        <div className="flex gap-2">
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
          <Select
            value={sourceFilter}
            onValueChange={(val) => {
              setSourceFilter(val === "all" ? "" : val);
              setPage(1);
            }}
          >
            <SelectTrigger className="w-[160px]">
              <SelectValue placeholder="All Sources" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Sources</SelectItem>
              {LEAD_SOURCES.map((s) => (
                <SelectItem key={s} value={s}>
                  {LEAD_SOURCE_LABELS[s]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
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
      </div>

      {/* Table */}
      {loading ? (
        <TableSkeleton rows={8} />
      ) : sortedLeads.length === 0 ? (
        <EmptyState
          icon={Users}
          title="No leads found"
          description="Create your first lead or adjust your filters."
          actionLabel="Create Lead"
          onAction={() => router.push("/leads/new")}
        />
      ) : (
        <div className="rounded-md border overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/50">
                <th className="px-4 py-3 text-left font-medium">Lead Name</th>
                <th className="px-4 py-3 text-left font-medium hidden md:table-cell">
                  Company
                </th>
                <th className="px-4 py-3 text-left font-medium hidden lg:table-cell">
                  Email
                </th>
                <th className="px-4 py-3 text-left font-medium hidden lg:table-cell">
                  Phone
                </th>
                <th className="px-4 py-3 text-left font-medium">Status</th>
                <th className="px-4 py-3 text-left font-medium hidden md:table-cell">
                  Source
                </th>
                <th className="px-4 py-3 text-left font-medium hidden lg:table-cell">
                  Location
                </th>
                <th className="px-4 py-3 text-left font-medium hidden xl:table-cell">
                  Rating
                </th>
                <th className="px-4 py-3 text-left font-medium hidden xl:table-cell">
                  Created
                </th>
              </tr>
            </thead>
            <tbody>
              {sortedLeads.map((lead) => {
                const isFormLead = isUnreadFormLead(lead);
                const isReEnquiry = !isFormLead && reEnquiryLeadIds.has(lead.id);
                return (
                  <tr
                    key={lead.id}
                    className={`border-b cursor-pointer transition-colors
                      ${isFormLead
                        ? "bg-emerald-50/40 hover:bg-emerald-50 dark:bg-emerald-950/10"
                        : isReEnquiry
                          ? "bg-amber-50/40 hover:bg-amber-50 dark:bg-amber-950/10"
                          : "hover:bg-muted/30"
                      }${lead.archived_at ? " opacity-60" : ""}`}
                    onClick={() => {
                      pushTrailEntry({ href: `/leads/${lead.id}`, label: `${lead.first_name} ${lead.last_name}` });
                      router.push(`/leads/${lead.id}`);
                    }}
                  >
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        {isFormLead && (
                          <span className="relative flex h-2 w-2 shrink-0">
                            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                            <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
                          </span>
                        )}
                        {isReEnquiry && (
                          <span className="relative flex h-2 w-2 shrink-0">
                            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75" />
                            <span className="relative inline-flex rounded-full h-2 w-2 bg-amber-500" />
                          </span>
                        )}
                        <Link
                          href={`/leads/${lead.id}`}
                          className={`font-medium hover:underline ${isFormLead ? "text-emerald-700" : isReEnquiry ? "text-amber-700" : "text-primary"}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            pushTrailEntry({ href: `/leads/${lead.id}`, label: `${lead.first_name} ${lead.last_name}` });
                          }}
                        >
                          {lead.first_name} {lead.last_name}
                        </Link>
                        <span className="text-xs font-mono text-muted-foreground">
                          #{lead.lead_number}
                        </span>
                        {isReEnquiry && (
                          <span className="shrink-0 text-[10px] font-bold text-amber-700 bg-amber-100 px-1.5 py-0.5 rounded uppercase">
                            Re-Enq
                          </span>
                        )}
                        {/* Followup flag */}
                        <TooltipProvider delayDuration={100}>
                          {lead._followup?.overdue && (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <span className="shrink-0 cursor-default">
                                  <AlertTriangle className="h-3.5 w-3.5 text-red-500" />
                                </span>
                              </TooltipTrigger>
                              <TooltipContent side="top">Overdue follow-up</TooltipContent>
                            </Tooltip>
                          )}
                          {!lead._followup?.overdue && lead._followup?.due_today && (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <span className="shrink-0 cursor-default">
                                  <Clock className="h-3.5 w-3.5 text-amber-500" />
                                </span>
                              </TooltipTrigger>
                              <TooltipContent side="top">Follow-up due today</TooltipContent>
                            </Tooltip>
                          )}
                          {!lead._followup?.overdue && !lead._followup?.due_today && lead._followup?.upcoming && (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <span className="shrink-0 cursor-default">
                                  <Clock className="h-3.5 w-3.5 text-blue-500" />
                                </span>
                              </TooltipTrigger>
                              <TooltipContent side="top">Upcoming follow-up</TooltipContent>
                            </Tooltip>
                          )}
                        </TooltipProvider>
                        {lead.archived_at && (
                          <span className="shrink-0 text-[10px] font-bold text-muted-foreground bg-muted px-1.5 py-0.5 rounded uppercase">
                            Disabled
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground hidden md:table-cell">
                      {lead.company || "-"}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground hidden lg:table-cell">
                      {lead.email || "-"}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground hidden lg:table-cell">
                      {lead.phone || lead.mobile || "-"}
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge type="lead_status" value={lead.status} />
                    </td>
                    <td className="px-4 py-3 hidden md:table-cell">
                      {LEAD_SOURCE_LABELS[lead.source] || lead.source}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground hidden lg:table-cell">
                      {lead.location?.name || "—"}
                    </td>
                    <td className="px-4 py-3 hidden xl:table-cell">
                      <RatingBadge rating={lead.rating} />
                    </td>
                    <td className="px-4 py-3 text-muted-foreground hidden xl:table-cell">
                      {formatDate(lead.created_at)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
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

      {/* Import Leads Dialog */}
      <ImportLeadsDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        onSuccess={refetch}
      />
    </div>
  );
}
