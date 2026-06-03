"use client";

import { useState, useMemo } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Plus, Search, ChevronLeft, ChevronRight, Users, Upload, Bell, RefreshCw, AlertTriangle, Clock } from "lucide-react";
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

const FORM_TAGS = ["google-ads-form", "meta-ads-form", "walkin-form"];
function isUnreadFormLead(lead: { status: string; tags: string[] }) {
  return lead.status === "new" && lead.tags?.some((t) => FORM_TAGS.includes(t));
}

function timeAgo(iso: string): string {
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

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
  const {
    newLeadCount,
    reEnquiryCount,
    recentItems,
    markReEnquiriesSeen,
    dismissReEnquiryItem,
  } = useEnquiryNotifications();

  const pinnedLeads = recentItems.filter((i) => i.type === "lead");
  const pinnedReEnquiries = recentItems.filter((i) => i.type === "activity");
  const hasPinned = pinnedLeads.length > 0 || pinnedReEnquiries.length > 0;

  const { data: leads, pagination, loading, refetch } = useLeads({
    page,
    search,
    status: statusFilter || undefined,
    source: sourceFilter || undefined,
    location_id: locationFilter || undefined,
    assigned_to: assignedToFilter || undefined,
    include_archived: showDisabled,
  });

  // Client-side: sort leads so new form leads appear first within the current page
  const sortedLeads = useMemo(() => {
    return [...leads].sort((a, b) => {
      const aPin = isUnreadFormLead(a) ? 0 : 1;
      const bPin = isUnreadFormLead(b) ? 0 : 1;
      return aPin - bPin;
    });
  }, [leads]);

  const handleSearch = () => {
    setSearch(searchInput);
    setPage(1);
  };

  return (
    <div className="space-y-4">
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

      {/* ── Pinned: New Form Enquiries (real-time, always at top) ── */}
      {hasPinned && (
        <div className="rounded-lg border-2 border-emerald-400 bg-emerald-50/60 dark:bg-emerald-950/20 overflow-hidden">
          {/* Section header */}
          <div className="flex items-center justify-between px-4 py-2.5 bg-emerald-100/60 dark:bg-emerald-900/30 border-b border-emerald-300/60">
            <div className="flex items-center gap-2">
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
              </span>
              <span className="text-xs font-semibold text-emerald-800 dark:text-emerald-200 uppercase tracking-wider">
                New Form Enquiries Requiring Action
              </span>
              {(newLeadCount + reEnquiryCount) > 0 && (
                <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-emerald-500 px-1.5 text-[10px] font-bold text-white">
                  {newLeadCount + reEnquiryCount}
                </span>
              )}
            </div>
            <Link
              href="/leads?status=new"
              className="text-xs font-medium text-emerald-700 hover:underline underline-offset-2"
            >
              View all new →
            </Link>
          </div>

          <div className="p-3 space-y-3">
            {/* New Leads */}
            {pinnedLeads.length > 0 && (
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-wider text-emerald-700 mb-1.5 flex items-center gap-1 px-1">
                  <Bell className="h-3 w-3" />
                  New Enquiries ({newLeadCount})
                </p>
                <div className="grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
                  {pinnedLeads.map((item) => (
                    <Link
                      key={item.leadId}
                      href={`/leads/${item.leadId}`}
                      className="flex items-center justify-between rounded-md px-3 py-2 bg-white/90 hover:bg-white transition-colors border border-emerald-200 group shadow-sm"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-semibold truncate group-hover:text-emerald-700 transition-colors">
                          {item.name}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          <span className="font-mono">#{item.leadId.slice(0, 6)}</span> · {item.source} · {timeAgo(item.time)}
                        </p>
                      </div>
                      <span className="shrink-0 ml-2 text-xs font-bold text-emerald-600 bg-emerald-100 px-1.5 py-0.5 rounded">
                        NEW
                      </span>
                    </Link>
                  ))}
                </div>
              </div>
            )}

            {/* Re-Enquiries */}
            {pinnedReEnquiries.length > 0 && (
              <div className={pinnedLeads.length > 0 ? "border-t border-emerald-200 pt-3" : ""}>
                <div className="flex items-center justify-between mb-1.5 px-1">
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-amber-700 flex items-center gap-1">
                    <RefreshCw className="h-3 w-3" />
                    Re-Enquiries ({reEnquiryCount})
                  </p>
                  {reEnquiryCount > 0 && (
                    <button
                      onClick={markReEnquiriesSeen}
                      className="text-[10px] text-muted-foreground hover:text-foreground transition-colors hover:underline underline-offset-2"
                    >
                      Mark seen
                    </button>
                  )}
                </div>
                <div className="grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
                  {pinnedReEnquiries.map((item, idx) => (
                    <button
                      key={item.leadId + "-" + idx}
                      onClick={() => { dismissReEnquiryItem(item.leadId); router.push(`/leads/${item.leadId}`); }}
                      className="flex items-center justify-between rounded-md px-3 py-2 bg-amber-50/90 hover:bg-amber-50 transition-colors border border-amber-200 group shadow-sm text-left w-full"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-semibold truncate group-hover:text-amber-700 transition-colors">
                          {item.name}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          <span className="font-mono">#{item.leadId.slice(0, 6)}</span> · {item.source} · {timeAgo(item.time)}
                        </p>
                      </div>
                      <span className="shrink-0 ml-2 text-xs font-bold text-amber-600 bg-amber-100 px-1.5 py-0.5 rounded">
                        RE-ENQ
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )}
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
                return (
                  <tr
                    key={lead.id}
                    className={`border-b cursor-pointer transition-colors
                      ${isFormLead
                        ? "bg-emerald-50/40 hover:bg-emerald-50 dark:bg-emerald-950/10"
                        : "hover:bg-muted/30"
                      }${lead.archived_at ? " opacity-60" : ""}`}
                    onClick={() => router.push(`/leads/${lead.id}`)}
                  >
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        {isFormLead && (
                          <span className="relative flex h-2 w-2 shrink-0">
                            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                            <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
                          </span>
                        )}
                        <Link
                          href={`/leads/${lead.id}`}
                          className={`font-medium hover:underline ${isFormLead ? "text-emerald-700" : "text-primary"}`}
                          onClick={(e) => e.stopPropagation()}
                        >
                          {lead.first_name} {lead.last_name}
                        </Link>
                        <span className="text-xs font-mono text-muted-foreground">
                          #{lead.lead_number}
                        </span>
                        {/* Followup flag */}
                        {lead._followup?.overdue && (
                          <span title="Overdue follow-up" className="shrink-0">
                            <AlertTriangle className="h-3.5 w-3.5 text-red-500" />
                          </span>
                        )}
                        {!lead._followup?.overdue && lead._followup?.due_today && (
                          <span title="Follow-up due today" className="shrink-0">
                            <Clock className="h-3.5 w-3.5 text-amber-500" />
                          </span>
                        )}
                        {!lead._followup?.overdue && !lead._followup?.due_today && lead._followup?.upcoming && (
                          <span title="Upcoming follow-up" className="shrink-0">
                            <Clock className="h-3.5 w-3.5 text-blue-500" />
                          </span>
                        )}
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
