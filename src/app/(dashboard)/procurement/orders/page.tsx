"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Package, Plus, ChevronLeft, ChevronRight, Search, X } from "lucide-react";
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
} from "@/lib/constants";
import { formatDate, formatCurrency } from "@/lib/utils";
import type { PurchaseOrder } from "@/types";

export default function PurchaseOrdersPage() {
  const router = useRouter();
  const [orders, setOrders] = useState<PurchaseOrder[]>([]);
  const [pagination, setPagination] = useState({ page: 1, limit: 25, total: 0, totalPages: 0 });
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState("");
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
    if (trimmed.length < 3) return; // wait for more input — no query yet
    const t = setTimeout(() => { setSearch(trimmed); setPage(1); }, 600);
    return () => clearTimeout(t);
  }, [searchInput]);

  const fetchOrders = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams({ page: String(page), limit: "25" });
    if (statusFilter) params.set("status", statusFilter);
    if (search) params.set("search", search);
    const res = await fetch(`/api/procurement/orders?${params}`);
    if (res.ok) {
      const json = await res.json();
      setOrders(json.data || []);
      setPagination(json.pagination);
    }
    setLoading(false);
  }, [page, statusFilter, search]);

  useEffect(() => { fetchOrders(); }, [fetchOrders]);

  return (
    <div className="space-y-4">
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
              className="pl-8 w-[210px]"
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
            value={statusFilter}
            onValueChange={(val) => { setStatusFilter(val === "all" ? "" : val); setPage(1); }}
          >
            <SelectTrigger className="w-[175px]">
              <SelectValue placeholder="All Statuses" />
            </SelectTrigger>
            <SelectContent position="popper">
              <SelectItem value="all">All Statuses</SelectItem>
              {PO_STATUSES.map((s) => (
                <SelectItem key={s} value={s}>{PO_STATUS_LABELS[s]}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button variant="outline" onClick={() => router.push("/procurement/orders/new-service")}>
            <Plus className="h-4 w-4 mr-1" /> New Service PO
          </Button>
          <Button onClick={() => router.push("/procurement/requests?status=approved")}>
            <Plus className="h-4 w-4 mr-1" /> New Goods PO
          </Button>
        </div>
      </div>

      {loading ? (
        <TableSkeleton rows={8} />
      ) : orders.length === 0 ? (
        <EmptyState
          icon={Package}
          title="No purchase orders"
          description="Create your first purchase order to get started."
          actionLabel="New Order"
          onAction={() => router.push("/procurement/requests?status=approved")}
        />
      ) : (
        <div className="rounded-md border overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/50">
                <th className="px-4 py-3 text-left font-medium">PO #</th>
                <th className="px-4 py-3 text-left font-medium">Vendor</th>
                <th className="px-4 py-3 text-left font-medium hidden md:table-cell">Location</th>
                <th className="px-4 py-3 text-left font-medium">Status</th>
                <th className="px-4 py-3 text-right font-medium hidden md:table-cell">Total Amount</th>
                <th className="px-4 py-3 text-left font-medium hidden lg:table-cell">Expected Delivery</th>
                <th className="px-4 py-3 text-left font-medium hidden lg:table-cell">Created</th>
              </tr>
            </thead>
            <tbody>
              {orders.map((po) => (
                <tr
                  key={po.id}
                  className="border-b hover:bg-muted/30 transition-colors cursor-pointer"
                  onClick={() => router.push(`/procurement/orders/${po.id}`)}
                >
                  <td className="px-4 py-3 font-mono text-xs font-medium">
                    <Link
                      href={`/procurement/orders/${po.id}`}
                      className="text-primary hover:underline"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {po.po_number}
                    </Link>
                  </td>
                  <td className="px-4 py-3 font-medium">
                    {po.procurement_vendors?.name ?? "—"}
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
