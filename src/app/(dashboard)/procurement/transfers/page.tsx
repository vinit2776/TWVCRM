"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRightLeft, Plus, ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/shared/empty-state";
import { TableSkeleton } from "@/components/shared/loading-skeleton";
import {
  TRANSFER_STATUS_LABELS,
  TRANSFER_STATUS_COLORS,
} from "@/lib/constants";
import { formatDate } from "@/lib/utils";
import type { StockTransfer } from "@/types";

const FILTER_TABS = [
  { key: "", label: "All" },
  { key: "pending_approval", label: "Pending Approval" },
  { key: "dispatched", label: "In Transit" },
  { key: "completed", label: "Completed" },
  { key: "issue_raised", label: "Issues" },
] as const;

export default function TransfersPage() {
  const router = useRouter();
  const [transfers, setTransfers] = useState<StockTransfer[]>([]);
  const [pagination, setPagination] = useState({ page: 1, limit: 25, total: 0, totalPages: 0 });
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState("");

  const fetchTransfers = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams({ page: String(page), limit: "25" });
    if (statusFilter) params.set("status", statusFilter);
    const res = await fetch(`/api/procurement/transfers?${params}`);
    if (res.ok) {
      const json = await res.json();
      setTransfers(json.data || []);
      setPagination(json.pagination);
    }
    setLoading(false);
  }, [page, statusFilter]);

  useEffect(() => { fetchTransfers(); }, [fetchTransfers]);

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Stock Transfers</h1>
          <p className="text-sm text-muted-foreground">{pagination.total} total transfers</p>
        </div>
        <Button onClick={() => router.push("/procurement/transfers/new")}>
          <Plus className="h-4 w-4 mr-1" /> New Transfer
        </Button>
      </div>

      {/* Status filter tabs */}
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

      {loading ? (
        <TableSkeleton rows={8} />
      ) : transfers.length === 0 ? (
        <EmptyState
          icon={ArrowRightLeft}
          title="No transfers found"
          description={
            statusFilter
              ? "No transfers match the selected filter."
              : "Create your first stock transfer to move inventory between locations."
          }
          actionLabel="New Transfer"
          onAction={() => router.push("/procurement/transfers/new")}
        />
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
                  onClick={() => router.push(`/procurement/transfers/${t.id}`)}
                >
                  <td className="px-4 py-3 font-mono text-xs font-medium">
                    <Link
                      href={`/procurement/transfers/${t.id}`}
                      className="text-primary hover:underline"
                      onClick={(e) => e.stopPropagation()}
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
