"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowRightLeft, Plus, ChevronLeft, ChevronRight, List, LayoutGrid,
  Clock, CheckCircle2, Truck, Search, X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { EmptyState } from "@/components/shared/empty-state";
import { TableSkeleton } from "@/components/shared/loading-skeleton";
import {
  TRANSFER_STATUS_LABELS,
  TRANSFER_STATUS_COLORS,
} from "@/lib/constants";
import { formatDate } from "@/lib/utils";
import { useScopedLocations } from "@/hooks/use-scoped-locations";
import type { StockTransfer } from "@/types";
import { PageBreadcrumb } from "@/components/page-breadcrumb";
import { pushTrailEntry } from "@/lib/nav-trail";

const FILTER_TABS = [
  { key: "", label: "All" },
  { key: "pending_approval", label: "Pending Approval" },
  { key: "dispatched", label: "In Transit" },
  { key: "completed", label: "Completed" },
  { key: "issue_raised", label: "Issues" },
] as const;

// Pipeline view is always scoped to transfers still in motion — a fixed
// lens, not a status filter the user picks.
const PIPELINE_STATUSES = ["pending_approval", "approved", "dispatched"];

const PIPELINE_STATUS_ICON: Record<string, typeof Clock> = {
  pending_approval: Clock,
  approved: CheckCircle2,
  dispatched: Truck,
};

export default function TransfersPage() {
  const router = useRouter();
  const { isScoped, assignedLocationIds, availableLocations, loading: scopeLoading } = useScopedLocations();
  const [transfers, setTransfers] = useState<StockTransfer[]>([]);
  const [pagination, setPagination] = useState({ page: 1, limit: 25, total: 0, totalPages: 0 });
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState("");
  const [viewMode, setViewMode] = useState<"list" | "pipeline">("list");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [locationFilter, setLocationFilter] = useState("");

  // Debounce the search box so we don't refetch on every keystroke.
  useEffect(() => {
    const t = setTimeout(() => { setSearch(searchInput.trim()); setPage(1); }, 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  const fetchTransfers = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams({ page: String(page), limit: "25" });
    if (viewMode === "pipeline") {
      // Pipeline is a fixed lens (everything still in flight) — fetch up to
      // the API's max page size in one go rather than paginating a view
      // that's meant to be a quick snapshot.
      params.set("statuses", PIPELINE_STATUSES.join(","));
      params.set("limit", "50");
    } else if (statusFilter) {
      params.set("status", statusFilter);
    }
    // A specific location filter narrows to just that location; otherwise
    // scoped (non-HO) users only see their assigned location(s), and
    // everyone else (HO roles, or unassigned users) sees all.
    if (locationFilter) {
      params.set("location_ids", locationFilter);
    } else if (isScoped) {
      params.set("location_ids", assignedLocationIds.join(","));
    }
    if (search) params.set("search", search);
    const res = await fetch(`/api/procurement/transfers?${params}`);
    if (res.ok) {
      const json = await res.json();
      setTransfers(json.data || []);
      setPagination(json.pagination);
    }
    setLoading(false);
  }, [page, statusFilter, viewMode, isScoped, assignedLocationIds, locationFilter, search]);

  useEffect(() => { if (!scopeLoading) fetchTransfers(); }, [fetchTransfers, scopeLoading]);

  const pipelineTotals = useMemo(() => {
    if (viewMode !== "pipeline") return null;
    let requested = 0, approved = 0, sent = 0;
    for (const t of transfers) {
      for (const item of t.stock_transfer_items ?? []) {
        requested += item.quantity_requested ?? 0;
        approved += item.quantity_approved ?? 0;
        sent += item.quantity_sent ?? 0;
      }
    }
    return { requested, approved, sent };
  }, [transfers, viewMode]);

  return (
    <div className="space-y-4">
      <PageBreadcrumb resetTo={{ label: "Transfers" }} />
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Stock Transfers</h1>
          <p className="text-sm text-muted-foreground">
            {viewMode === "pipeline" ? `${transfers.length} active` : `${pagination.total} total transfers`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center rounded-md border p-0.5">
            <button
              onClick={() => setViewMode("list")}
              className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded text-sm font-medium transition-colors ${
                viewMode === "list" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"
              }`}
            >
              <List className="h-3.5 w-3.5" /> List
            </button>
            <button
              onClick={() => setViewMode("pipeline")}
              className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded text-sm font-medium transition-colors ${
                viewMode === "pipeline" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"
              }`}
            >
              <LayoutGrid className="h-3.5 w-3.5" /> Pipeline
            </button>
          </div>
          <Button onClick={() => router.push("/procurement/transfers/new")}>
            <Plus className="h-4 w-4 mr-1" /> New Request
          </Button>
        </div>
      </div>

      {/* Search + location filter */}
      <div className="flex flex-col sm:flex-row gap-2">
        <div className="relative flex-1 sm:max-w-xs">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search by transfer #..."
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            className="pl-8 pr-8"
          />
          {searchInput && (
            <button
              onClick={() => setSearchInput("")}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              aria-label="Clear search"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
        <Select
          value={locationFilter || "__all__"}
          onValueChange={(v) => { setLocationFilter(v === "__all__" ? "" : v); setPage(1); }}
        >
          <SelectTrigger className="sm:w-56">
            <SelectValue placeholder="All locations" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">All locations</SelectItem>
            {availableLocations.map((loc) => (
              <SelectItem key={loc.id} value={loc.id}>{loc.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Status filter tabs (list view only — pipeline is a fixed lens) */}
      {viewMode === "list" && (
      <div className="flex items-center gap-2 flex-wrap">
        {FILTER_TABS.map((tab) => (
          <button
            key={tab.key}
            onClick={() => { setStatusFilter(tab.key); setPage(1); }}
            className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
              statusFilter === tab.key
                ? "bg-primary text-primary-foreground"
                : "bg-muted text-muted-foreground hover:bg-muted/80"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>
      )}

      {loading ? (
        <TableSkeleton rows={8} />
      ) : transfers.length === 0 ? (
        <EmptyState
          icon={ArrowRightLeft}
          title={viewMode === "pipeline" ? "Nothing in flight" : "No transfers found"}
          description={
            search || locationFilter
              ? "No transfers match your search and filter."
              : viewMode === "pipeline"
              ? "No requests are currently pending approval, approved, or dispatched."
              : statusFilter
              ? "No transfers match the selected filter."
              : "Create your first stock transfer to move inventory between locations."
          }
          actionLabel="New Request"
          onAction={() => router.push("/procurement/transfers/new")}
        />
      ) : viewMode === "pipeline" ? (
        <div className="space-y-4">
          {pipelineTotals && (
            <div className="grid grid-cols-3 gap-3">
              <div className="rounded-md bg-muted/50 p-3">
                <p className="text-xs text-muted-foreground">Requested</p>
                <p className="text-xl font-semibold">{pipelineTotals.requested}</p>
              </div>
              <div className="rounded-md bg-muted/50 p-3">
                <p className="text-xs text-muted-foreground">Approved</p>
                <p className="text-xl font-semibold">{pipelineTotals.approved}</p>
              </div>
              <div className="rounded-md bg-muted/50 p-3">
                <p className="text-xs text-muted-foreground">Dispatched</p>
                <p className="text-xl font-semibold">{pipelineTotals.sent}</p>
              </div>
            </div>
          )}

          {transfers.map((t) => {
            const StatusIcon = PIPELINE_STATUS_ICON[t.status] ?? Clock;
            return (
              <Card key={t.id} className="overflow-hidden py-0">
                <div
                  className="flex items-center justify-between px-4 py-2.5 bg-muted/30 border-b cursor-pointer"
                  onClick={() => {
                    pushTrailEntry({ href: `/procurement/transfers/${t.id}`, label: t.transfer_number });
                    router.push(`/procurement/transfers/${t.id}`);
                  }}
                >
                  <div className="flex items-center gap-2.5">
                    <Link
                      href={`/procurement/transfers/${t.id}`}
                      className="font-medium text-sm text-primary hover:underline"
                      onClick={(e) => {
                        e.stopPropagation();
                        pushTrailEntry({ href: `/procurement/transfers/${t.id}`, label: t.transfer_number });
                      }}
                    >
                      {t.transfer_number}
                    </Link>
                    <span className="text-xs text-muted-foreground">{t.to_location?.name ?? "—"}</span>
                  </div>
                  <Badge variant="secondary" className={`gap-1 ${TRANSFER_STATUS_COLORS[t.status]}`}>
                    <StatusIcon className="h-3 w-3" /> {TRANSFER_STATUS_LABELS[t.status]}
                  </Badge>
                </div>
                <CardContent className="p-0">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-muted-foreground">
                        <td className="px-4 py-1.5 text-xs">Item</td>
                        <td className="px-4 py-1.5 text-xs text-right">Requested</td>
                        <td className="px-4 py-1.5 text-xs text-right">Approved</td>
                        <td className="px-4 py-1.5 text-xs text-right">Sent</td>
                      </tr>
                    </thead>
                    <tbody>
                      {(t.stock_transfer_items ?? []).map((item) => {
                        const approvedShort = item.quantity_approved !== null && item.quantity_approved < item.quantity_requested;
                        return (
                          <tr key={item.id} className="border-t">
                            <td className="px-4 py-2">{item.item_name}</td>
                            <td className="px-4 py-2 text-right">{item.quantity_requested}</td>
                            <td className={`px-4 py-2 text-right ${approvedShort ? "text-amber-600 font-medium" : ""}`}>
                              {item.quantity_approved ?? "—"}
                            </td>
                            <td className="px-4 py-2 text-right text-muted-foreground">
                              {t.status === "dispatched" || t.status === "received" || t.status === "completed"
                                ? item.quantity_sent
                                : "—"}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </CardContent>
              </Card>
            );
          })}
        </div>
      ) : (
        <div className="rounded-md border overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/50">
                <th className="px-4 py-3 text-left font-medium">Transfer #</th>
                <th className="px-4 py-3 text-left font-medium">From</th>
                <th className="px-4 py-3 text-left font-medium">To</th>
                <th className="px-4 py-3 text-left font-medium hidden md:table-cell">Status</th>
                <th className="px-4 py-3 text-left font-medium hidden lg:table-cell">Initiated By</th>
                <th className="px-4 py-3 text-left font-medium hidden lg:table-cell">Date</th>
              </tr>
            </thead>
            <tbody>
              {transfers.map((t) => (
                <tr
                  key={t.id}
                  className="border-b hover:bg-muted/30 transition-colors cursor-pointer"
                  onClick={() => {
                    pushTrailEntry({ href: `/procurement/transfers/${t.id}`, label: t.transfer_number });
                    router.push(`/procurement/transfers/${t.id}`);
                  }}
                >
                  <td className="px-4 py-3 font-mono text-xs font-medium">
                    <Link
                      href={`/procurement/transfers/${t.id}`}
                      className="text-primary hover:underline"
                      onClick={(e) => {
                        e.stopPropagation();
                        pushTrailEntry({ href: `/procurement/transfers/${t.id}`, label: t.transfer_number });
                      }}
                    >
                      {t.transfer_number}
                    </Link>
                  </td>
                  <td className="px-4 py-3">
                    {t.from_location?.name ?? "—"}
                  </td>
                  <td className="px-4 py-3">
                    {t.to_location?.name ?? "—"}
                  </td>
                  <td className="px-4 py-3 hidden md:table-cell">
                    <Badge variant="secondary" className={TRANSFER_STATUS_COLORS[t.status]}>
                      {TRANSFER_STATUS_LABELS[t.status]}
                    </Badge>
                  </td>
                  <td className="px-4 py-3 hidden lg:table-cell text-muted-foreground">
                    {t.initiator?.full_name ?? "—"}
                  </td>
                  <td className="px-4 py-3 hidden lg:table-cell text-muted-foreground">
                    {formatDate(t.created_at)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {viewMode === "list" && pagination.totalPages > 1 && (
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
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={page >= pagination.totalPages}
              onClick={() => setPage(page + 1)}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
