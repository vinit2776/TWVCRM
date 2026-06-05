"use client";

export const dynamic = "force-dynamic";

import { useState, useEffect, useCallback } from "react";
import { useCurrentUser } from "@/providers/current-user-provider";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ClipboardList, Plus, ChevronLeft, ChevronRight, Search, X, PieChart } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { EmptyState } from "@/components/shared/empty-state";
import { TableSkeleton } from "@/components/shared/loading-skeleton";
import {
  PR_STATUSES, PR_STATUS_LABELS, PR_STATUS_COLORS,
  PROCUREMENT_DEPARTMENTS, PROCUREMENT_DEPARTMENT_LABELS, PROCUREMENT_DEPARTMENT_COLORS,
} from "@/lib/constants";
import { formatDate, formatCurrency } from "@/lib/utils";
import type { PurchaseRequest } from "@/types";

export default function PurchaseRequestsPage() {
  const router = useRouter();
  const urlParams = useSearchParams();
  const { user } = useCurrentUser();
  const userRole = user?.role ?? "";
  const canSeePrices = ["admin", "manager"].includes(userRole);
  const [requests, setRequests] = useState<PurchaseRequest[]>([]);
  const [pagination, setPagination] = useState({ page: 1, limit: 25, total: 0, totalPages: 0 });
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState(() => urlParams?.get("status") ?? "");
  const [deptFilter, setDeptFilter] = useState(() => urlParams?.get("department") ?? "");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  // Hidden filters set from URL (budget drill-through)
  const [fromDate] = useState(() => urlParams?.get("from_date") ?? "");
  const [toDate] = useState(() => urlParams?.get("to_date") ?? "");
  const [expenditureType] = useState(() => urlParams?.get("expenditure_type") ?? "");
  const isBudgetView = urlParams?.get("budget_view") === "1";

  // Debounce search: wait 600 ms and require ≥3 chars before querying
  useEffect(() => {
    const trimmed = searchInput.trim();
    if (trimmed.length === 0) {
      setSearch("");
      setPage(1);
      return;
    }
    if (trimmed.length < 3) return; // wait for more input — no query yet
    const t = setTimeout(() => { setSearch(trimmed); setPage(1); }, 600);
    return () => clearTimeout(t);
  }, [searchInput]);

  const fetchRequests = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams({ page: String(page), limit: "25" });
    if (statusFilter) params.set("status", statusFilter);
    if (deptFilter) params.set("department", deptFilter);
    if (search) params.set("search", search);
    if (fromDate) params.set("from_date", fromDate);
    if (toDate) params.set("to_date", toDate);
    if (expenditureType) params.set("expenditure_type", expenditureType);
    const res = await fetch(`/api/procurement/requests?${params}`);
    if (res.ok) {
      const json = await res.json();
      setRequests(json.data || []);
      setPagination(json.pagination);
    }
    setLoading(false);
  }, [page, statusFilter, deptFilter, search, fromDate, toDate, expenditureType]);

  useEffect(() => { fetchRequests(); }, [fetchRequests]);

  // Format month label from from_date for the budget banner
  const budgetMonthLabel = fromDate
    ? new Date(fromDate + "T00:00:00").toLocaleString("en-IN", { month: "long", year: "numeric" })
    : "";

  return (
    <div className="space-y-4">
      {isBudgetView && (
        <div className="flex items-center gap-2 rounded-lg border border-blue-200 bg-blue-50 px-4 py-2.5 text-sm text-blue-800">
          <PieChart className="h-4 w-4 shrink-0 text-blue-600" />
          <span>
            Budget drill-through — showing active {deptFilter ? PROCUREMENT_DEPARTMENT_LABELS[deptFilter] : ""} MRs
            {budgetMonthLabel ? ` for ${budgetMonthLabel}` : ""}. These are the requests counted in the budget spend.
          </span>
          <button
            className="ml-auto text-blue-600 hover:text-blue-900 underline text-xs shrink-0"
            onClick={() => router.push("/procurement/requests")}
          >
            Clear filters
          </button>
        </div>
      )}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Material Requests</h1>
          <p className="text-sm text-muted-foreground">{pagination.total} total requests</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {/* Search */}
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
            <Input
              placeholder="Search MR # or item..."
              className="pl-8 w-[200px]"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
            />
            {searchInput && (
              <button
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                onClick={() => { setSearchInput(""); setSearch(""); }}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
          {searchInput.trim().length > 0 && searchInput.trim().length < 3 && (
            <p className="text-xs text-muted-foreground mt-1">Type at least 3 characters…</p>
          )}
          <Select
            value={deptFilter}
            onValueChange={(val) => { setDeptFilter(val === "all" ? "" : val); setPage(1); }}
          >
            <SelectTrigger className="w-[160px]">
              <SelectValue placeholder="All Departments" />
            </SelectTrigger>
            <SelectContent position="popper">
              <SelectItem value="all">All Departments</SelectItem>
              {PROCUREMENT_DEPARTMENTS.map((d) => (
                <SelectItem key={d} value={d}>{PROCUREMENT_DEPARTMENT_LABELS[d]}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={statusFilter}
            onValueChange={(val) => { setStatusFilter(val === "all" ? "" : val); setPage(1); }}
          >
            <SelectTrigger className="w-[150px]">
              <SelectValue placeholder="All Statuses" />
            </SelectTrigger>
            <SelectContent position="popper">
              <SelectItem value="all">All Statuses</SelectItem>
              <SelectItem value="active">Active (excl. cancelled)</SelectItem>
              {PR_STATUSES.map((s) => (
                <SelectItem key={s} value={s}>{PR_STATUS_LABELS[s]}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button onClick={() => router.push("/procurement/requests/new")}>
            <Plus className="h-4 w-4 mr-1" /> New Request
          </Button>
        </div>
      </div>

      {loading ? (
        <TableSkeleton rows={8} />
      ) : requests.length === 0 ? (
        <EmptyState
          icon={ClipboardList}
          title="No material requests"
          description="Create your first material request to get started."
          actionLabel="New Request"
          onAction={() => router.push("/procurement/requests/new")}
        />
      ) : (
        <div className="rounded-md border overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/50">
                <th className="px-4 py-3 text-left font-medium">PR #</th>
                <th className="px-4 py-3 text-left font-medium">Department</th>
                <th className="px-4 py-3 text-left font-medium hidden md:table-cell">Location</th>
                <th className="px-4 py-3 text-left font-medium">Status</th>
                {canSeePrices && <th className="px-4 py-3 text-right font-medium hidden md:table-cell">Est. Amount</th>}
                <th className="px-4 py-3 text-left font-medium hidden lg:table-cell">Requested By</th>
                <th className="px-4 py-3 text-left font-medium hidden lg:table-cell">Date</th>
              </tr>
            </thead>
            <tbody>
              {requests.map((pr) => (
                <tr
                  key={pr.id}
                  className="border-b hover:bg-muted/30 transition-colors cursor-pointer"
                  onClick={() => router.push(`/procurement/requests/${pr.id}`)}
                >
                  <td className="px-4 py-3 font-mono text-xs font-medium">
                    <Link
                      href={`/procurement/requests/${pr.id}`}
                      className="text-primary hover:underline"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {pr.pr_number}
                    </Link>
                  </td>
                  <td className="px-4 py-3">
                    <Badge variant="secondary" className={PROCUREMENT_DEPARTMENT_COLORS[pr.department]}>
                      {PROCUREMENT_DEPARTMENT_LABELS[pr.department]}
                    </Badge>
                  </td>
                  <td className="px-4 py-3 hidden md:table-cell text-muted-foreground">
                    {pr.locations?.name ?? "—"}
                  </td>
                  <td className="px-4 py-3">
                    <Badge variant="secondary" className={PR_STATUS_COLORS[pr.status]}>
                      {PR_STATUS_LABELS[pr.status]}
                    </Badge>
                  </td>
                  {canSeePrices && (
                    <td className="px-4 py-3 text-right hidden md:table-cell font-medium">
                      {pr.total_estimated_amount > 0 ? formatCurrency(pr.total_estimated_amount) : "—"}
                    </td>
                  )}
                  <td className="px-4 py-3 hidden lg:table-cell text-muted-foreground">
                    {pr.requester?.full_name ?? pr.requester?.email ?? "—"}
                  </td>
                  <td className="px-4 py-3 hidden lg:table-cell text-muted-foreground">
                    {formatDate(pr.created_at)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

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
