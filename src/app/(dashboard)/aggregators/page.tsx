"use client";

import { useState } from "react";
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
                <th className="px-4 py-3 text-left font-medium hidden lg:table-cell">State</th>
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
                      {agg.name}
                    </Link>
                    {agg.company_name && (
                      <p className="text-xs text-muted-foreground">{agg.company_name}</p>
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
                  <td className="px-4 py-3 text-muted-foreground hidden lg:table-cell">
                    {agg.same_state_as_twv ? "Same (TN)" : "Interstate"}
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
