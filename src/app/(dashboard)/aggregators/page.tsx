"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Plus, Search, ChevronLeft, ChevronRight, Handshake } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { StatusBadge } from "@/components/shared/status-badge";
import { AGGREGATOR_BILLING_METHOD_LABELS } from "@/lib/constants";
import { EmptyState } from "@/components/shared/empty-state";
import { TableSkeleton } from "@/components/shared/loading-skeleton";
import { PageBreadcrumb } from "@/components/page-breadcrumb";
import { useAggregators } from "@/hooks/use-aggregators";
import { pushTrailEntry } from "@/lib/nav-trail";
import {
  AGGREGATOR_STATUSES,
  AGGREGATOR_STATUS_LABELS,
} from "@/lib/constants";
import { formatDate } from "@/lib/utils";

export default function AggregatorsPage() {
  const router = useRouter();
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [searchInput, setSearchInput] = useState("");

  const { data: aggregators, pagination, loading } = useAggregators({
    page,
    search,
    status: statusFilter || undefined,
  });

  const [caseCounts, setCaseCounts] = useState<Record<string, { total: number; incomplete: number }>>({});
  const [caseCountsLoading, setCaseCountsLoading] = useState(false);

  // Key off a stable string, not the `aggregators` array reference — usePaginatedFetch
  // returns a fresh `[]` on every render until the first fetch resolves, which would
  // otherwise re-fire this effect (and its unconditional setState) every render.
  const aggregatorIdsKey = aggregators.map((a) => a.id).join(",");

  useEffect(() => {
    if (!aggregatorIdsKey) {
      setCaseCounts({});
      return;
    }
    setCaseCountsLoading(true);
    fetch(`/api/aggregators/case-counts?ids=${aggregatorIdsKey}`)
      .then((r) => r.json())
      .then((j) => setCaseCounts(j.data ?? {}))
      .finally(() => setCaseCountsLoading(false));
  }, [aggregatorIdsKey]);

  const handleSearch = () => {
    setSearch(searchInput);
    setPage(1);
  };

  return (
    <div className="space-y-4">
      <PageBreadcrumb resetTo={{ label: "Aggregators" }} />
      {/* Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Aggregators</h1>
          <p className="text-sm text-muted-foreground">
            {pagination.total} total aggregators
          </p>
        </div>
        <Button onClick={() => router.push("/aggregators/new")}>
          <Plus className="mr-2 h-4 w-4" />
          Add Aggregator
        </Button>
      </div>

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="flex flex-1 gap-2">
          <Input
            placeholder="Search aggregators..."
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSearch()}
            className="max-w-sm"
          />
          <Button variant="outline" size="icon" onClick={handleSearch}>
            <Search className="h-4 w-4" />
          </Button>
        </div>
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
            {AGGREGATOR_STATUSES.map((s) => (
              <SelectItem key={s} value={s}>
                {AGGREGATOR_STATUS_LABELS[s]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Table */}
      {loading ? (
        <TableSkeleton rows={8} />
      ) : aggregators.length === 0 ? (
        <EmptyState
          icon={Handshake}
          title="No aggregators found"
          description="Add your first aggregator partner or adjust your filters."
          actionLabel="Add Aggregator"
          onAction={() => router.push("/aggregators/new")}
        />
      ) : (
        <div className="rounded-md border overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/50">
                <th className="px-4 py-3 text-left font-medium">Code</th>
                <th className="px-4 py-3 text-left font-medium">Name</th>
                <th className="px-4 py-3 text-left font-medium hidden md:table-cell">Email Domain</th>
                <th className="px-4 py-3 text-left font-medium hidden lg:table-cell">Phone</th>
                <th className="px-4 py-3 text-left font-medium">Status</th>
                <th className="px-4 py-3 text-left font-medium hidden md:table-cell">Cases</th>
                <th className="px-4 py-3 text-left font-medium hidden lg:table-cell">Billing Method</th>
                <th className="px-4 py-3 text-left font-medium hidden xl:table-cell">Created</th>
              </tr>
            </thead>
            <tbody>
              {aggregators.map((agg) => (
                <tr
                  key={agg.id}
                  className="border-b hover:bg-muted/30 cursor-pointer transition-colors"
                  onClick={() => {
                    pushTrailEntry({ href: `/aggregators/${agg.id}`, label: agg.name });
                    router.push(`/aggregators/${agg.id}`);
                  }}
                >
                  <td className="px-4 py-3">
                    <span className="font-mono text-xs text-muted-foreground">{agg.code}</span>
                  </td>
                  <td className="px-4 py-3">
                    <Link
                      href={`/aggregators/${agg.id}`}
                      className="font-medium text-primary hover:underline"
                      onClick={(e) => {
                        e.stopPropagation();
                        pushTrailEntry({ href: `/aggregators/${agg.id}`, label: agg.name });
                      }}
                    >
                      {agg.company_name || agg.name}
                    </Link>
                    {agg.company_name && (
                      <p className="text-xs text-muted-foreground">{agg.name}</p>
                    )}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground hidden md:table-cell">
                    {agg.email_domain || "-"}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground hidden lg:table-cell">
                    {agg.primary_phone || "-"}
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge type="aggregator_status" value={agg.status} />
                  </td>
                  <td className="px-4 py-3 hidden md:table-cell">
                    {caseCountsLoading ? (
                      <span className="text-muted-foreground text-xs">…</span>
                    ) : caseCounts[agg.id] ? (
                      <Link
                        href={`/aggregators/${agg.id}`}
                        onClick={(e) => e.stopPropagation()}
                        className="hover:underline"
                      >
                        <span className="font-medium">{caseCounts[agg.id].total}</span>
                        {caseCounts[agg.id].incomplete > 0 && (
                          <span className="ml-1.5 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-full px-1.5 py-0.5">
                            {caseCounts[agg.id].incomplete} pending
                          </span>
                        )}
                      </Link>
                    ) : (
                      <span className="text-muted-foreground">-</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground hidden lg:table-cell">
                    {AGGREGATOR_BILLING_METHOD_LABELS[agg.billing_method] || agg.billing_method}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground hidden xl:table-cell">
                    {formatDate(agg.created_at)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Legend */}
      {!loading && aggregators.length > 0 && (
        <div className="rounded-md border bg-muted/20 px-4 py-3">
          <p className="text-xs font-medium text-muted-foreground mb-2">Legend</p>
          <div className="flex flex-wrap gap-x-5 gap-y-2">
            <div className="flex items-center gap-2">
              <StatusBadge type="aggregator_status" value="active" />
              <span className="text-xs text-muted-foreground">currently engaged</span>
            </div>
            <div className="flex items-center gap-2">
              <StatusBadge type="aggregator_status" value="inactive" />
              <span className="text-xs text-muted-foreground">not currently referring</span>
            </div>
            <div className="flex items-center gap-2">
              <StatusBadge type="aggregator_status" value="suspended" />
              <span className="text-xs text-muted-foreground">flagged, under review</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-full px-1.5 py-0.5">
                N pending
              </span>
              <span className="text-xs text-muted-foreground">
                cases not yet Active — won&apos;t show on the Billing tab
              </span>
            </div>
          </div>
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
    </div>
  );
}
