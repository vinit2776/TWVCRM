"use client";

import { Fragment, Suspense, useState, useEffect, useCallback, useMemo } from "react";
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
import { MonthPicker } from "@/components/accounting/month-picker";
import { EmptyState } from "@/components/shared/empty-state";
import { TableSkeleton } from "@/components/shared/loading-skeleton";
import {
  PR_STATUSES, PR_STATUS_LABELS, PR_STATUS_COLORS,
  PROCUREMENT_DEPARTMENTS, PROCUREMENT_DEPARTMENT_LABELS, PROCUREMENT_DEPARTMENT_COLORS,
} from "@/lib/constants";
import { formatDate, formatCurrency, getMonthDateRange } from "@/lib/utils";
import type { PurchaseRequest } from "@/types";

interface LocationGroup {
  locationName: string;
  requests: PurchaseRequest[];
  count: number;
  totalAmount: number;
}

interface ComparisonRow {
  locationName: string;
  countA: number;
  amountA: number;
  countB: number;
  amountB: number;
  deltaAmount: number;
  deltaPct: number | null; // null = new spend this period (no baseline)
}

function groupByLocation(items: PurchaseRequest[]): LocationGroup[] {
  const map = new Map<string, LocationGroup>();
  for (const pr of items) {
    const key = pr.locations?.name ?? "Unspecified Location";
    let group = map.get(key);
    if (!group) {
      group = { locationName: key, requests: [], count: 0, totalAmount: 0 };
      map.set(key, group);
    }
    group.requests.push(pr);
    group.count += 1;
    group.totalAmount += pr.total_estimated_amount || 0;
  }
  return Array.from(map.values()).sort((a, b) => b.totalAmount - a.totalAmount);
}

function buildComparisonRows(groupsA: LocationGroup[], groupsB: LocationGroup[]): ComparisonRow[] {
  const names = new Set<string>([
    ...groupsA.map((g) => g.locationName),
    ...groupsB.map((g) => g.locationName),
  ]);
  return Array.from(names)
    .map((locationName) => {
      const a = groupsA.find((g) => g.locationName === locationName);
      const b = groupsB.find((g) => g.locationName === locationName);
      const countA = a?.count ?? 0;
      const amountA = a?.totalAmount ?? 0;
      const countB = b?.count ?? 0;
      const amountB = b?.totalAmount ?? 0;
      // Delta reads as "month A vs month B" (A is the primary/left-hand picker) — positive means
      // A spent more than B, matching the "June vs May" framing shown in the toolbar.
      const deltaAmount = amountA - amountB;
      const deltaPct = amountB > 0 ? (deltaAmount / amountB) * 100 : amountA > 0 ? null : 0;
      return { locationName, countA, amountA, countB, amountB, deltaAmount, deltaPct };
    })
    .sort((x, y) => y.amountA + y.amountB - (x.amountA + x.amountB));
}

function getPreviousMonth(year: number, month: number) {
  return month === 1 ? { year: year - 1, month: 12 } : { year, month: month - 1 };
}

function monthLabel(year: number, month: number) {
  return new Date(year, month - 1, 1).toLocaleString("en-IN", { month: "short", year: "numeric" });
}

// Inner component — uses useSearchParams, must be inside <Suspense>
function PurchaseRequestsContent() {
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
  // Hidden filter set from URL (budget drill-through) — not exposed in the UI
  const [expenditureType] = useState(() => urlParams?.get("expenditure_type") ?? "");
  const isBudgetView = urlParams?.get("budget_view") === "1";

  // Month filter — defaults to the URL's from_date (budget drill-through) or the current month.
  const [viewMonth, setViewMonth] = useState(() => {
    const fd = urlParams?.get("from_date");
    if (fd) {
      const d = new Date(fd + "T00:00:00");
      return { year: d.getFullYear(), month: d.getMonth() + 1 };
    }
    const now = new Date();
    return { year: now.getFullYear(), month: now.getMonth() + 1 };
  });
  const [useAllTime, setUseAllTime] = useState(false);
  const [compareMode, setCompareMode] = useState(false);
  const [compareMonth, setCompareMonth] = useState(() => getPreviousMonth(viewMonth.year, viewMonth.month));

  const [locationGroups, setLocationGroups] = useState<LocationGroup[]>([]);
  const [compareRows, setCompareRows] = useState<ComparisonRow[]>([]);

  const { from: monthFrom, to: monthTo } = useMemo(
    () => getMonthDateRange(viewMonth.year, viewMonth.month),
    [viewMonth]
  );
  const flatFromDate = useAllTime ? "" : monthFrom;
  const flatToDate = useAllTime ? "" : monthTo;
  const showFlatList = Boolean(search) || useAllTime;

  // Push from_date/to_date into the URL only when the user explicitly picks a month
  // (shareable/bookmarkable, consistent with the existing budget-drill-through param
  // convention) — deliberately NOT a reactive effect on monthFrom/monthTo: Next.js can
  // remount this Suspense-bound component when searchParams change via router.replace,
  // which would re-run this same effect and cascade the month backward indefinitely.
  const handleMonthChange = useCallback((year: number, month: number) => {
    setViewMonth({ year, month });
    setUseAllTime(false);
    const { from, to } = getMonthDateRange(year, month);
    const params = new URLSearchParams(urlParams?.toString() ?? "");
    params.set("from_date", from);
    params.set("to_date", to);
    router.replace(`/procurement/requests?${params.toString()}`, { scroll: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
    if (flatFromDate) params.set("from_date", flatFromDate);
    if (flatToDate) params.set("to_date", flatToDate);
    if (expenditureType) params.set("expenditure_type", expenditureType);
    const res = await fetch(`/api/procurement/requests?${params}`);
    if (res.ok) {
      const json = await res.json();
      setRequests(json.data || []);
      setPagination(json.pagination);
    }
    setLoading(false);
  }, [page, statusFilter, deptFilter, search, flatFromDate, flatToDate, expenditureType]);

  const fetchAllForRange = useCallback(async (from: string, to: string): Promise<PurchaseRequest[]> => {
    const params = new URLSearchParams({ all: "1", from_date: from, to_date: to });
    if (statusFilter) params.set("status", statusFilter);
    if (deptFilter) params.set("department", deptFilter);
    if (expenditureType) params.set("expenditure_type", expenditureType);
    const res = await fetch(`/api/procurement/requests?${params}`);
    if (!res.ok) return [];
    const json = await res.json();
    return json.data || [];
  }, [statusFilter, deptFilter, expenditureType]);

  useEffect(() => {
    let cancelled = false;
    async function run() {
      if (showFlatList) {
        await fetchRequests();
        return;
      }
      setLoading(true);
      if (compareMode) {
        const rangeA = getMonthDateRange(viewMonth.year, viewMonth.month);
        const rangeB = getMonthDateRange(compareMonth.year, compareMonth.month);
        const [itemsA, itemsB] = await Promise.all([
          fetchAllForRange(rangeA.from, rangeA.to),
          fetchAllForRange(rangeB.from, rangeB.to),
        ]);
        if (cancelled) return;
        setCompareRows(buildComparisonRows(groupByLocation(itemsA), groupByLocation(itemsB)));
      } else {
        const items = await fetchAllForRange(monthFrom, monthTo);
        if (cancelled) return;
        setLocationGroups(groupByLocation(items));
      }
      if (!cancelled) setLoading(false);
    }
    run();
    return () => { cancelled = true; };
  }, [showFlatList, compareMode, viewMonth, compareMonth, monthFrom, monthTo, fetchRequests, fetchAllForRange]);

  const budgetMonthLabel = monthLabel(viewMonth.year, viewMonth.month);

  const totalRequestCount = useMemo(
    () => locationGroups.reduce((sum, g) => sum + g.count, 0),
    [locationGroups]
  );
  const totalAmount = useMemo(
    () => locationGroups.reduce((sum, g) => sum + g.totalAmount, 0),
    [locationGroups]
  );
  const compareTotals = useMemo(() => {
    return compareRows.reduce(
      (acc, r) => ({
        countA: acc.countA + r.countA,
        amountA: acc.amountA + r.amountA,
        countB: acc.countB + r.countB,
        amountB: acc.amountB + r.amountB,
      }),
      { countA: 0, amountA: 0, countB: 0, amountB: 0 }
    );
  }, [compareRows]);

  const headerCountLabel = showFlatList
    ? `${pagination.total} total requests`
    : compareMode
      ? `${compareTotals.countA + compareTotals.countB} requests across ${compareRows.length} locations`
      : `${totalRequestCount} requests across ${locationGroups.length} locations · ${budgetMonthLabel}`;

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
          <p className="text-sm text-muted-foreground">{headerCountLabel}</p>
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

      {/* Month filter / All time / Compare — hidden while searching, since search always uses the flat list */}
      {!search && (
        <div className="flex items-center gap-2 flex-wrap">
          <MonthPicker
            year={viewMonth.year}
            month={viewMonth.month}
            onChange={handleMonthChange}
          />
          <Button
            variant={useAllTime ? "default" : "outline"}
            size="sm"
            onClick={() => { setUseAllTime((v) => !v); setCompareMode(false); }}
          >
            All time
          </Button>
          {!useAllTime && (
            <Button
              variant={compareMode ? "default" : "outline"}
              size="sm"
              onClick={() => setCompareMode((v) => !v)}
            >
              Compare
            </Button>
          )}
          {!useAllTime && compareMode && (
            <>
              <span className="text-sm text-muted-foreground">vs</span>
              <MonthPicker
                year={compareMonth.year}
                month={compareMonth.month}
                onChange={(year, month) => setCompareMonth({ year, month })}
              />
            </>
          )}
        </div>
      )}

      {loading ? (
        <TableSkeleton rows={8} />
      ) : showFlatList ? (
        requests.length === 0 ? (
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
        )
      ) : compareMode ? (
        compareRows.length === 0 ? (
          <EmptyState
            icon={ClipboardList}
            title="No material requests"
            description="No requests found for either month with the current filters."
          />
        ) : (
          <div className="rounded-md border overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/50">
                  <th className="px-4 py-3 text-left font-medium">Location</th>
                  <th className="px-4 py-3 text-right font-medium">{monthLabel(viewMonth.year, viewMonth.month)} Count</th>
                  {canSeePrices && <th className="px-4 py-3 text-right font-medium">{monthLabel(viewMonth.year, viewMonth.month)} Amount</th>}
                  <th className="px-4 py-3 text-right font-medium">{monthLabel(compareMonth.year, compareMonth.month)} Count</th>
                  {canSeePrices && <th className="px-4 py-3 text-right font-medium">{monthLabel(compareMonth.year, compareMonth.month)} Amount</th>}
                  {canSeePrices && <th className="px-4 py-3 text-right font-medium">Δ Amount</th>}
                  {canSeePrices && <th className="px-4 py-3 text-right font-medium">Δ %</th>}
                </tr>
              </thead>
              <tbody>
                {compareRows.map((row) => (
                  <tr key={row.locationName} className="border-b hover:bg-muted/30">
                    <td className="px-4 py-3 font-medium">{row.locationName}</td>
                    <td className="px-4 py-3 text-right text-muted-foreground">{row.countA}</td>
                    {canSeePrices && <td className="px-4 py-3 text-right">{formatCurrency(row.amountA)}</td>}
                    <td className="px-4 py-3 text-right text-muted-foreground">{row.countB}</td>
                    {canSeePrices && <td className="px-4 py-3 text-right">{formatCurrency(row.amountB)}</td>}
                    {canSeePrices && (
                      <td className={`px-4 py-3 text-right font-medium ${row.deltaAmount > 0 ? "text-red-600" : row.deltaAmount < 0 ? "text-green-600" : ""}`}>
                        {row.deltaAmount > 0 ? "+" : ""}{formatCurrency(row.deltaAmount)}
                      </td>
                    )}
                    {canSeePrices && (
                      <td className={`px-4 py-3 text-right ${row.deltaAmount > 0 ? "text-red-600" : row.deltaAmount < 0 ? "text-green-600" : ""}`}>
                        {row.deltaPct === null ? "New" : `${row.deltaPct > 0 ? "+" : ""}${row.deltaPct.toFixed(1)}%`}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 bg-muted/60 font-semibold">
                  <td className="px-4 py-3">Total</td>
                  <td className="px-4 py-3 text-right">{compareTotals.countA}</td>
                  {canSeePrices && <td className="px-4 py-3 text-right">{formatCurrency(compareTotals.amountA)}</td>}
                  <td className="px-4 py-3 text-right">{compareTotals.countB}</td>
                  {canSeePrices && <td className="px-4 py-3 text-right">{formatCurrency(compareTotals.amountB)}</td>}
                  {canSeePrices && (
                    <td className="px-4 py-3 text-right">
                      {formatCurrency(compareTotals.amountA - compareTotals.amountB)}
                    </td>
                  )}
                  {canSeePrices && (
                    <td className="px-4 py-3 text-right">
                      {compareTotals.amountB > 0
                        ? `${(((compareTotals.amountA - compareTotals.amountB) / compareTotals.amountB) * 100).toFixed(1)}%`
                        : "—"}
                    </td>
                  )}
                </tr>
              </tfoot>
            </table>
          </div>
        )
      ) : locationGroups.length === 0 ? (
        <EmptyState
          icon={ClipboardList}
          title="No material requests"
          description={`No requests found for ${budgetMonthLabel} with the current filters.`}
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
                <th className="px-4 py-3 text-left font-medium">Status</th>
                {canSeePrices && <th className="px-4 py-3 text-right font-medium hidden md:table-cell">Est. Amount</th>}
                <th className="px-4 py-3 text-left font-medium hidden lg:table-cell">Requested By</th>
                <th className="px-4 py-3 text-left font-medium hidden lg:table-cell">Date</th>
              </tr>
            </thead>
            <tbody>
              {locationGroups.map((group) => (
                <Fragment key={group.locationName}>
                  <tr className="bg-muted/40 border-b">
                    <td colSpan={canSeePrices ? 6 : 5} className="px-4 py-2">
                      <div className="flex items-center justify-between font-semibold">
                        <span>
                          {group.locationName}{" "}
                          <span className="text-muted-foreground font-normal">({group.count})</span>
                        </span>
                        {canSeePrices && <span>{formatCurrency(group.totalAmount)}</span>}
                      </div>
                    </td>
                  </tr>
                  {group.requests.map((pr) => (
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
                </Fragment>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t-2 bg-muted/60 font-semibold">
                <td colSpan={3} className="px-4 py-3">Grand Total ({totalRequestCount} requests)</td>
                {canSeePrices && (
                  <td className="px-4 py-3 text-right hidden md:table-cell">{formatCurrency(totalAmount)}</td>
                )}
                <td className="hidden lg:table-cell" />
                <td className="hidden lg:table-cell" />
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      {showFlatList && pagination.totalPages > 1 && (
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

// Suspense boundary required by Next.js because PurchaseRequestsContent uses useSearchParams()
export default function PurchaseRequestsPage() {
  return (
    <Suspense fallback={<TableSkeleton rows={8} />}>
      <PurchaseRequestsContent />
    </Suspense>
  );
}
