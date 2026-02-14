"use client";

import { useState, useEffect, useCallback } from "react";
import { ChevronLeft, ChevronRight, Ticket, Upload, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { EmptyState } from "@/components/shared/empty-state";
import { TableSkeleton } from "@/components/shared/loading-skeleton";
import { UploadVouchersDialog } from "@/components/vouchers/upload-vouchers-dialog";
import {
  VOUCHER_STATUSES,
  VOUCHER_STATUS_LABELS,
  VOUCHER_STATUS_COLORS,
} from "@/lib/constants";
import { formatDate } from "@/lib/utils";

interface Voucher {
  id: string;
  voucher_code: string;
  status: string;
  metadata: Record<string, unknown>;
  uploaded_at: string;
  issued_at?: string;
  created_at: string;
}

interface VoucherStats {
  total: number;
  available: number;
  issued: number;
  expired: number;
}

export default function VouchersPage() {
  const [vouchers, setVouchers] = useState<Voucher[]>([]);
  const [pagination, setPagination] = useState({ page: 1, limit: 25, total: 0, totalPages: 0 });
  const [stats, setStats] = useState<VoucherStats>({ total: 0, available: 0, issued: 0, expired: 0 });
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState("");
  const [search, setSearch] = useState("");
  const [uploadOpen, setUploadOpen] = useState(false);

  const fetchVouchers = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams({ page: String(page), limit: "25" });
    if (statusFilter) params.set("status", statusFilter);
    if (search.trim()) params.set("search", search.trim());
    const res = await fetch(`/api/vouchers?${params}`);
    if (res.ok) {
      const json = await res.json();
      setVouchers(json.data || []);
      setPagination(json.pagination || { page: 1, limit: 25, total: 0, totalPages: 0 });
      if (json.stats) {
        setStats(json.stats);
      }
    }
    setLoading(false);
  }, [page, statusFilter, search]);

  useEffect(() => { fetchVouchers(); }, [fetchVouchers]);

  const clearFilters = () => {
    setSearch("");
    setStatusFilter("");
    setPage(1);
  };

  const hasFilters = search || statusFilter;

  const truncateJson = (obj: Record<string, unknown>, maxLen = 60): string => {
    const str = JSON.stringify(obj);
    if (str.length <= maxLen) return str;
    return str.slice(0, maxLen) + "...";
  };

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Voucher Repository</h1>
          <p className="text-sm text-muted-foreground">{pagination.total} total vouchers</p>
        </div>
        <Button onClick={() => setUploadOpen(true)}>
          <Upload className="mr-2 h-4 w-4" />
          Upload Vouchers
        </Button>
      </div>

      {/* Stats Bar */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="rounded-lg border bg-card p-4">
          <p className="text-sm text-muted-foreground">Total</p>
          <p className="text-2xl font-bold">{stats.total}</p>
        </div>
        <div className="rounded-lg border bg-card p-4">
          <p className="text-sm text-muted-foreground">Available</p>
          <p className="text-2xl font-bold text-green-600">{stats.available}</p>
        </div>
        <div className="rounded-lg border bg-card p-4">
          <p className="text-sm text-muted-foreground">Issued</p>
          <p className="text-2xl font-bold text-blue-600">{stats.issued}</p>
        </div>
        <div className="rounded-lg border bg-card p-4">
          <p className="text-sm text-muted-foreground">Expired</p>
          <p className="text-2xl font-bold text-orange-600">{stats.expired}</p>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search voucher codes..."
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(1); }}
            className="pl-9 w-[220px]"
          />
        </div>
        <Select value={statusFilter} onValueChange={(val) => { setStatusFilter(val === "all" ? "" : val); setPage(1); }}>
          <SelectTrigger className="w-[160px]"><SelectValue placeholder="All Statuses" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Statuses</SelectItem>
            {VOUCHER_STATUSES.map((s) => (
              <SelectItem key={s} value={s}>{VOUCHER_STATUS_LABELS[s]}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        {hasFilters && (
          <Button variant="ghost" size="sm" onClick={clearFilters}>
            <X className="mr-1 h-4 w-4" />
            Clear
          </Button>
        )}
      </div>

      {/* Table */}
      {loading ? <TableSkeleton rows={6} /> : vouchers.length === 0 ? (
        <EmptyState
          icon={Ticket}
          title="No vouchers found"
          description={hasFilters ? "Try adjusting your filters." : "Upload vouchers to get started."}
          actionLabel={!hasFilters ? "Upload Vouchers" : undefined}
          onAction={!hasFilters ? () => setUploadOpen(true) : undefined}
        />
      ) : (
        <div className="rounded-md border overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/50">
                <th className="px-4 py-3 text-left font-medium">Voucher Code</th>
                <th className="px-4 py-3 text-left font-medium">Status</th>
                <th className="px-4 py-3 text-left font-medium hidden md:table-cell">Metadata</th>
                <th className="px-4 py-3 text-left font-medium hidden lg:table-cell">Uploaded</th>
                <th className="px-4 py-3 text-left font-medium hidden lg:table-cell">Issued</th>
              </tr>
            </thead>
            <tbody>
              {vouchers.map((v) => (
                <tr key={v.id} className="border-b hover:bg-muted/30 transition-colors">
                  <td className="px-4 py-3 font-mono text-xs">{v.voucher_code}</td>
                  <td className="px-4 py-3">
                    <Badge variant="secondary" className={VOUCHER_STATUS_COLORS[v.status]}>
                      {VOUCHER_STATUS_LABELS[v.status] || v.status}
                    </Badge>
                  </td>
                  <td className="px-4 py-3 hidden md:table-cell">
                    {v.metadata && Object.keys(v.metadata).length > 0 ? (
                      <span className="text-xs text-muted-foreground font-mono">
                        {truncateJson(v.metadata)}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">-</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground hidden lg:table-cell">
                    {formatDate(v.uploaded_at || v.created_at)}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground hidden lg:table-cell">
                    {v.issued_at ? formatDate(v.issued_at) : "-"}
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
          <p className="text-sm text-muted-foreground">Page {pagination.page} of {pagination.totalPages}</p>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button variant="outline" size="sm" disabled={page >= pagination.totalPages} onClick={() => setPage(page + 1)}>
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}

      {/* Upload Dialog */}
      <UploadVouchersDialog
        open={uploadOpen}
        onOpenChange={setUploadOpen}
        onSuccess={fetchVouchers}
      />
    </div>
  );
}
