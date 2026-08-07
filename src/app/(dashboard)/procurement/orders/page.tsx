"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Package, Plus, ChevronLeft, ChevronRight, Search, X, IndianRupee } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { EmptyState } from "@/components/shared/empty-state";
import { TableSkeleton } from "@/components/shared/loading-skeleton";
import {
  PO_STATUSES, PO_STATUS_LABELS, PO_STATUS_COLORS,
  PROCUREMENT_DEPARTMENTS, PROCUREMENT_DEPARTMENT_LABELS,
} from "@/lib/constants";
import { formatDate, formatCurrency } from "@/lib/utils";
import type { PurchaseOrder } from "@/types";
import { PageBreadcrumb } from "@/components/page-breadcrumb";
import { pushTrailEntry } from "@/lib/nav-trail";

// ── Month helpers ──────────────────────────────────────────────────────────────

function buildMonthOptions(): { value: string; label: string }[] {
  const options: { value: string; label: string }[] = [];
  const now = new Date();
  for (let i = 0; i < 18; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    const label = d.toLocaleString("en-IN", { month: "long", year: "numeric" });
    options.push({ value, label });
  }
  return options;
}

const MONTH_OPTIONS = buildMonthOptions();

// ── Page ──────────────────────────────────────────────────────────────────────

type Totals = {
  totalExGst: number;
  totalInclGst: number;
  poCount: number;
  budget: number | null;
  budgetBalance: number | null;
};

export default function PurchaseOrdersPage() {
  const router = useRouter();
  const [orders, setOrders] = useState<PurchaseOrder[]>([]);
  const [pagination, setPagination] = useState({ page: 1, limit: 25, total: 0, totalPages: 0 });
  const [totals, setTotals] = useState<Totals | null>(null);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState("");
  const [departmentFilter, setDepartmentFilter] = useState("");
  const [monthFilter, setMonthFilter] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");

  // Debounce search: wait 600 ms and require ≥3 chars before querying
  useEffect(() => {
    const trimmed = searchInput.trim();
    if (trimmed.length === 0) {
      setSearch("");
      setPage(1);
      return;
    }
    if (trimmed.length < 3) return;
    const t = setTimeout(() => { setSearch(trimmed); setPage(1); }, 600);
    return () => clearTimeout(t);
  }, [searchInput]);

  const fetchOrders = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams({ page: String(page), limit: "25", include_totals: "true" });
    if (statusFilter) params.set("status", statusFilter);
    if (departmentFilter) params.set("department", departmentFilter);
    if (monthFilter) params.set("month", monthFilter);
    if (search) params.set("search", search);
    const res = await fetch(`/api/procurement/orders?${params}`);
    if (res.ok) {
      const json = await res.json();
      setOrders(json.data || []);
      setPagination(json.pagination);
      setTotals(json.totals ?? null);
    }
    setLoading(false);
  }, [page, statusFilter, departmentFilter, monthFilter, search]);

  useEffect(() => { fetchOrders(); }, [fetchOrders]);

  const hasActiveFilters = !!(statusFilter || departmentFilter || monthFilter || search);

  return (
    <div className="space-y-4">
      <PageBreadcrumb resetTo={{ label: "Purchase Orders" }} />
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Purchase Orders</h1>
          <p className="text-sm text-muted-foreground">{pagination.total} total orders</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {/* Search */}
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
            <Input
              placeholder="Search PO # or vendor..."
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
            <p className="text-xs text-muted-foreground">Type at least 3 characters…</p>
          )}

          {/* Status filter */}
          <Select
            value={statusFilter}
            onValueChange={(val) => { setStatusFilter(val === "all" ? "" : val); setPage(1); }}
          >
            <SelectTrigger className="w-[155px]">
              <SelectValue placeholder="All Statuses" />
            </SelectTrigger>
            <SelectContent position="popper">
              <SelectItem value="all">All Statuses</SelectItem>
              {PO_STATUSES.map((s) => (
                <SelectItem key={s} value={s}>{PO_STATUS_LABELS[s]}</SelectItem>
              ))}
            </SelectContent>
          </Select>

          {/* Department filter */}
          <Select
            value={departmentFilter}
            onValueChange={(val) => { setDepartmentFilter(val === "all" ? "" : val); setPage(1); }}
          >
            <SelectTrigger className="w-[150px]">
              <SelectValue placeholder="All Depts" />
            </SelectTrigger>
            <SelectContent position="popper">
              <SelectItem value="all">All Departments</SelectItem>
              {PROCUREMENT_DEPARTMENTS.map((d) => (
                <SelectItem key={d} value={d}>{PROCUREMENT_DEPARTMENT_LABELS[d]}</SelectItem>
              ))}
            </SelectContent>
          </Select>

          {/* Month filter */}
          <Select
            value={monthFilter}
            onValueChange={(val) => { setMonthFilter(val === "all" ? "" : val); setPage(1); }}
          >
            <SelectTrigger className="w-[155px]">
              <SelectValue placeholder="All Months" />
            </SelectTrigger>
            <SelectContent position="popper">
              <SelectItem value="all">All Months</SelectItem>
              {MONTH_OPTIONS.map((m) => (
                <SelectItem key={m.value} value={m.value}>{m.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>

          {/* Clear all filters */}
          {hasActiveFilters && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setStatusFilter("");
                setDepartmentFilter("");
                setMonthFilter("");
                setSearchInput("");
                setSearch("");
                setPage(1);
              }}
              className="text-muted-foreground hover:text-foreground"
            >
              <X className="h-3.5 w-3.5 mr-1" /> Clear
            </Button>
          )}

          {/* "New Service PO" entry removed — AMC and service POs now flow through
              Material Requests (department=AMC). Direct /orders/new-service redirects
              there; the only path that still lands on it is "Create PO" on an
              approved AMC MR (with ?from_mr=<id>). */}
          <Button onClick={() => router.push("/procurement/requests?status=approved")}>
            <Plus className="h-4 w-4 mr-1" /> New PO from Request
          </Button>
        </div>
      </div>

      {/* ── Totals strip ──────────────────────────────────────────────────────── */}
      {!loading && totals && (
        <div className="rounded-lg border bg-muted/30 px-4 py-3 text-sm space-y-2">
          {/* Row 1: PO count + amounts */}
          <div className="flex flex-wrap items-center gap-3">
            <IndianRupee className="h-4 w-4 text-muted-foreground shrink-0" />
            <span className="text-muted-foreground">
              {hasActiveFilters ? "Filtered total —" : "All POs —"}
            </span>
            <span className="font-medium">
              {totals.poCount} {totals.poCount === 1 ? "PO" : "POs"}
            </span>
            <span className="text-muted-foreground">·</span>
            <span>
              <span className="text-muted-foreground">Ex-GST: </span>
              <span className="font-semibold text-foreground">{formatCurrency(totals.totalExGst)}</span>
            </span>
            <span className="text-muted-foreground">·</span>
            <span>
              <span className="text-muted-foreground">Incl. GST: </span>
              <span className="font-semibold text-foreground">{formatCurrency(totals.totalInclGst)}</span>
            </span>
            {hasActiveFilters && (
              <Badge variant="secondary" className="ml-auto text-[10px] bg-blue-50 text-blue-700 border-blue-200">
                Filtered
              </Badge>
            )}
          </div>

          {/* Row 2: Budget balance — only when dept + month both selected */}
          {departmentFilter && monthFilter && (
            <div className="flex flex-wrap items-center gap-3 pt-1 border-t border-border/50">
              <span className="text-muted-foreground">
                {PROCUREMENT_DEPARTMENT_LABELS[departmentFilter]} budget —
              </span>
              {totals.budget !== null ? (
                <>
                  <span>
                    <span className="text-muted-foreground">Monthly budget: </span>
                    <span className="font-semibold">{formatCurrency(totals.budget)}</span>
                  </span>
                  <span className="text-muted-foreground">·</span>
                  <span>
                    <span className="text-muted-foreground">PO commitments: </span>
                    <span className="font-semibold">{formatCurrency(totals.totalExGst)}</span>
                  </span>
                  <span className="text-muted-foreground">·</span>
                  <span>
                    <span className="text-muted-foreground">Balance: </span>
                    <span className={`font-semibold ${(totals.budgetBalance ?? 0) < 0 ? "text-red-600" : "text-green-600"}`}>
                      {formatCurrency(Math.abs(totals.budgetBalance ?? 0))}
                      {(totals.budgetBalance ?? 0) < 0 ? " over budget" : " remaining"}
                    </span>
                  </span>
                </>
              ) : (
                <span className="text-muted-foreground italic">No budget configured for this department</span>
              )}
            </div>
          )}
        </div>
      )}

      {loading ? (
        <TableSkeleton rows={8} />
      ) : orders.length === 0 ? (
        <EmptyState
          icon={Package}
          title="No purchase orders"
          description={hasActiveFilters ? "No orders match the selected filters." : "Create your first purchase order to get started."}
          actionLabel={hasActiveFilters ? "Clear Filters" : "New Order"}
          onAction={hasActiveFilters
            ? () => { setStatusFilter(""); setDepartmentFilter(""); setMonthFilter(""); setSearchInput(""); setSearch(""); setPage(1); }
            : () => router.push("/procurement/requests?status=approved")
          }
        />
      ) : (
        <div className="rounded-md border overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/50">
                <th className="px-4 py-3 text-left font-medium">PO #</th>
                <th className="px-4 py-3 text-left font-medium">Vendor</th>
                <th className="px-4 py-3 text-left font-medium hidden md:table-cell">Dept</th>
                <th className="px-4 py-3 text-left font-medium hidden md:table-cell">Location</th>
                <th className="px-4 py-3 text-left font-medium">Status</th>
                <th className="px-4 py-3 text-right font-medium hidden md:table-cell">Total (ex-GST)</th>
                <th className="px-4 py-3 text-left font-medium hidden lg:table-cell">Expected Delivery</th>
                <th className="px-4 py-3 text-left font-medium hidden lg:table-cell">Created</th>
              </tr>
            </thead>
            <tbody>
              {orders.map((po) => {
                const dept = (po as unknown as { purchase_requests?: { department?: string } }).purchase_requests?.department;
                return (
                  <tr
                    key={po.id}
                    className="border-b hover:bg-muted/30 transition-colors cursor-pointer"
                    onClick={() => {
                      pushTrailEntry({ href: `/procurement/orders/${po.id}`, label: po.po_number });
                      router.push(`/procurement/orders/${po.id}`);
                    }}
                  >
                    <td className="px-4 py-3 font-mono text-xs font-medium">
                      <Link
                        href={`/procurement/orders/${po.id}`}
                        className="text-primary hover:underline"
                        onClick={(e) => {
                          e.stopPropagation();
                          pushTrailEntry({ href: `/procurement/orders/${po.id}`, label: po.po_number });
                        }}
                      >
                        {po.po_number}
                      </Link>
                    </td>
                    <td className="px-4 py-3 font-medium">
                      {po.procurement_vendors?.name ?? "—"}
                    </td>
                    <td className="px-4 py-3 hidden md:table-cell text-muted-foreground text-xs">
                      {dept ? PROCUREMENT_DEPARTMENT_LABELS[dept] ?? dept : "—"}
                    </td>
                    <td className="px-4 py-3 hidden md:table-cell text-muted-foreground">
                      {po.locations?.name ?? "—"}
                    </td>
                    <td className="px-4 py-3">
                      <Badge variant="secondary" className={PO_STATUS_COLORS[po.status]}>
                        {PO_STATUS_LABELS[po.status]}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 text-right hidden md:table-cell font-medium">
                      {po.total_ordered_amount > 0 ? formatCurrency(po.total_ordered_amount) : "—"}
                    </td>
                    <td className="px-4 py-3 hidden lg:table-cell text-muted-foreground">
                      {po.expected_delivery_date ? formatDate(po.expected_delivery_date) : "—"}
                    </td>
                    <td className="px-4 py-3 hidden lg:table-cell text-muted-foreground">
                      {formatDate(po.created_at)}
                    </td>
                  </tr>
                );
              })}
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
