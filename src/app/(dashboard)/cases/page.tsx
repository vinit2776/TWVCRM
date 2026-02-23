"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  Plus,
  Search,
  ChevronLeft,
  ChevronRight,
  Briefcase,
  LayoutGrid,
  List,
} from "lucide-react";
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
import { CaseKanbanBoard } from "@/components/cases/case-kanban-board";
import { useCases } from "@/hooks/use-cases";
import { LocationSelector } from "@/components/shared/location-selector";
import {
  CASE_STATUSES,
  CASE_STATUS_LABELS,
  VO_PURPOSES,
  VO_PURPOSE_LABELS,
} from "@/lib/constants";
import { formatDate, formatCurrency } from "@/lib/utils";

export default function CasesPage() {
  const router = useRouter();
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [purposeFilter, setPurposeFilter] = useState<string>("");
  const [locationFilter, setLocationFilter] = useState<string | null>(null);
  const [searchInput, setSearchInput] = useState("");
  const [viewMode, setViewMode] = useState<"table" | "kanban">("table");

  const { data: cases, pagination, loading } = useCases({
    page,
    search,
    status: statusFilter || undefined,
    purpose: purposeFilter || undefined,
    location_id: locationFilter || undefined,
    limit: viewMode === "kanban" ? 100 : 25,
  });

  const handleSearch = () => {
    setSearch(searchInput);
    setPage(1);
  };

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Cases</h1>
          <p className="text-sm text-muted-foreground">
            {pagination.total} total cases
          </p>
        </div>
        <div className="flex gap-2">
          <div className="flex border rounded-md">
            <Button
              variant={viewMode === "table" ? "secondary" : "ghost"}
              size="sm"
              onClick={() => setViewMode("table")}
              className="rounded-r-none"
            >
              <List className="h-4 w-4" />
            </Button>
            <Button
              variant={viewMode === "kanban" ? "secondary" : "ghost"}
              size="sm"
              onClick={() => setViewMode("kanban")}
              className="rounded-l-none"
            >
              <LayoutGrid className="h-4 w-4" />
            </Button>
          </div>
          <Button onClick={() => router.push("/cases/new")}>
            <Plus className="mr-2 h-4 w-4" />
            Create Case
          </Button>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="flex flex-1 gap-2">
          <Input
            placeholder="Search cases..."
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSearch()}
            className="max-w-sm"
          />
          <Button variant="outline" size="icon" onClick={handleSearch}>
            <Search className="h-4 w-4" />
          </Button>
        </div>
        <div className="flex gap-2 flex-wrap">
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
              {CASE_STATUSES.map((s) => (
                <SelectItem key={s} value={s}>
                  {CASE_STATUS_LABELS[s]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={purposeFilter}
            onValueChange={(val) => {
              setPurposeFilter(val === "all" ? "" : val);
              setPage(1);
            }}
          >
            <SelectTrigger className="w-[160px]">
              <SelectValue placeholder="All Purposes" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Purposes</SelectItem>
              {VO_PURPOSES.map((p) => (
                <SelectItem key={p} value={p}>
                  {VO_PURPOSE_LABELS[p]}
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
        </div>
      </div>

      {/* Content */}
      {loading ? (
        <TableSkeleton rows={8} />
      ) : cases.length === 0 ? (
        <EmptyState
          icon={Briefcase}
          title="No cases found"
          description="Create your first case or adjust your filters."
          actionLabel="Create Case"
          onAction={() => router.push("/cases/new")}
        />
      ) : viewMode === "kanban" ? (
        <CaseKanbanBoard cases={cases} />
      ) : (
        <div className="rounded-md border overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/50">
                <th className="px-4 py-3 text-left font-medium">Case #</th>
                <th className="px-4 py-3 text-left font-medium">Client</th>
                <th className="px-4 py-3 text-left font-medium hidden md:table-cell">Aggregator</th>
                <th className="px-4 py-3 text-left font-medium hidden md:table-cell">Purpose</th>
                <th className="px-4 py-3 text-left font-medium">Status</th>
                <th className="px-4 py-3 text-left font-medium hidden lg:table-cell">Rate</th>
                <th className="px-4 py-3 text-left font-medium hidden xl:table-cell">Created</th>
              </tr>
            </thead>
            <tbody>
              {cases.map((c) => (
                <tr
                  key={c.id}
                  className="border-b hover:bg-muted/30 cursor-pointer transition-colors"
                  onClick={() => router.push(`/cases/${c.id}`)}
                >
                  <td className="px-4 py-3">
                    <span className="font-mono text-xs">{c.case_number}</span>
                  </td>
                  <td className="px-4 py-3">
                    <Link
                      href={`/cases/${c.id}`}
                      className="font-medium text-primary hover:underline"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {c.client_name}
                    </Link>
                    {c.client_company_name && (
                      <p className="text-xs text-muted-foreground">{c.client_company_name}</p>
                    )}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground hidden md:table-cell">
                    {c.aggregator ? (c.aggregator as { name: string }).name : "-"}
                  </td>
                  <td className="px-4 py-3 hidden md:table-cell">
                    <StatusBadge type="vo_purpose" value={c.purpose} />
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge type="case_status" value={c.status} />
                  </td>
                  <td className="px-4 py-3 hidden lg:table-cell">
                    {c.rate ? formatCurrency(c.rate) : "-"}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground hidden xl:table-cell">
                    {formatDate(c.created_at)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Pagination (table view only) */}
      {viewMode === "table" && pagination.totalPages > 1 && (
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
