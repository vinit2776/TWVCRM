"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronLeft, ChevronRight, ScrollText, Search, X, CalendarX, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { EmptyState } from "@/components/shared/empty-state";
import { TableSkeleton } from "@/components/shared/loading-skeleton";
import {
  CONTRACT_STATUSES,
  CONTRACT_STATUS_LABELS,
  CONTRACT_STATUS_COLORS,
  BILLING_CYCLE_LABELS,
} from "@/lib/constants";
import { formatDate, formatCurrency } from "@/lib/utils";
import type { Contract } from "@/types";

export default function ContractsPage() {
  const router = useRouter();
  const [contracts, setContracts] = useState<(Contract & { lead?: { id: string; first_name: string; last_name: string; company?: string } })[]>([]);
  const [pagination, setPagination] = useState({ page: 1, limit: 25, total: 0, totalPages: 0 });
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState("");
  const [search, setSearch] = useState("");
  const [expiringSoon, setExpiringSoon] = useState("");

  const fetchContracts = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams({ page: String(page) });
    if (statusFilter) params.set("status", statusFilter);
    if (search.trim()) params.set("search", search.trim());
    if (expiringSoon) params.set("expiring_soon", expiringSoon);
    const res = await fetch(`/api/contracts?${params}`);
    if (res.ok) {
      const json = await res.json();
      setContracts(json.data || []);
      setPagination(json.pagination);
    }
    setLoading(false);
  }, [page, statusFilter, search, expiringSoon]);

  useEffect(() => { fetchContracts(); }, [fetchContracts]);

  const clearFilters = () => {
    setSearch("");
    setStatusFilter("");
    setExpiringSoon("");
    setPage(1);
  };

  const hasFilters = search || statusFilter || expiringSoon;

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Contracts</h1>
          <p className="text-sm text-muted-foreground">{pagination.total} total contracts</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search contracts..."
              value={search}
              onChange={(e) => { setSearch(e.target.value); setPage(1); }}
              className="pl-9 w-[200px]"
            />
          </div>
          <Select value={statusFilter} onValueChange={(val) => { setStatusFilter(val === "all" ? "" : val); setPage(1); }}>
            <SelectTrigger className="w-[160px]"><SelectValue placeholder="All Statuses" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Statuses</SelectItem>
              {CONTRACT_STATUSES.map((s) => <SelectItem key={s} value={s}>{CONTRACT_STATUS_LABELS[s]}</SelectItem>)}
            </SelectContent>
          </Select>
          <Button
            variant={expiringSoon === "60" ? "default" : "outline"}
            size="sm"
            onClick={() => {
              setExpiringSoon(expiringSoon === "60" ? "" : "60");
              setStatusFilter("");
              setPage(1);
            }}
          >
            <CalendarX className="mr-1 h-4 w-4" />
            Renewals Due
          </Button>
          {hasFilters && (
            <Button variant="ghost" size="sm" onClick={clearFilters}>
              <X className="mr-1 h-4 w-4" />
              Clear
            </Button>
          )}
        </div>
      </div>

      {loading ? <TableSkeleton rows={6} /> : contracts.length === 0 ? (
        <EmptyState icon={ScrollText} title="No contracts found" description="Create contracts from lead detail pages." />
      ) : (
        <div className="rounded-md border overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="border-b bg-muted/50">
              <th className="px-4 py-3 text-left font-medium">Contract #</th>
              <th className="px-4 py-3 text-left font-medium hidden md:table-cell">Lead</th>
              <th className="px-4 py-3 text-right font-medium">Amount</th>
              <th className="px-4 py-3 text-left font-medium hidden lg:table-cell">Billing Cycle</th>
              <th className="px-4 py-3 text-left font-medium hidden md:table-cell">Start Date</th>
              <th className="px-4 py-3 text-left font-medium hidden lg:table-cell">End Date</th>
              <th className="px-4 py-3 text-left font-medium hidden lg:table-cell">Location</th>
              <th className="px-4 py-3 text-left font-medium">Status</th>
            </tr></thead>
            <tbody>{contracts.map((c) => (
              <tr
                key={c.id}
                className="border-b hover:bg-muted/30 transition-colors cursor-pointer"
                onClick={() => router.push(`/contracts/${c.id}`)}
              >
                <td className="px-4 py-3 font-mono text-xs">{c.contract_number}</td>
                <td className="px-4 py-3 hidden md:table-cell">
                  {c.lead ? (
                    <Link
                      href={`/leads/${c.lead.id}`}
                      className="text-primary hover:underline"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {c.lead.company || `${c.lead.first_name} ${c.lead.last_name}`}
                    </Link>
                  ) : "-"}
                </td>
                <td className="px-4 py-3 text-right font-medium">{formatCurrency(c.total_amount)}</td>
                <td className="px-4 py-3 hidden lg:table-cell">{BILLING_CYCLE_LABELS[c.billing_cycle]}</td>
                <td className="px-4 py-3 text-muted-foreground hidden md:table-cell">{formatDate(c.start_date)}</td>
                <td className="px-4 py-3 text-muted-foreground hidden lg:table-cell">{formatDate(c.end_date)}</td>
                <td className="px-4 py-3 text-muted-foreground hidden lg:table-cell">{c.location?.name || "—"}</td>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-1.5">
                    <Badge variant="secondary" className={CONTRACT_STATUS_COLORS[c.status]}>
                      {CONTRACT_STATUS_LABELS[c.status]}
                    </Badge>
                    {c.is_renewal && (
                      <span title={`Renewal V${c.renewal_sequence || 2}`}>
                        <RefreshCw className="h-3 w-3 text-blue-500" />
                      </span>
                    )}
                    {c.renewal_declined && (
                      <span className="text-[9px] text-red-600 font-medium" title="Renewal declined">✕ Declined</span>
                    )}
                  </div>
                </td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}

      {pagination.totalPages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">Page {pagination.page} of {pagination.totalPages}</p>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}><ChevronLeft className="h-4 w-4" /></Button>
            <Button variant="outline" size="sm" disabled={page >= pagination.totalPages} onClick={() => setPage(page + 1)}><ChevronRight className="h-4 w-4" /></Button>
          </div>
        </div>
      )}
    </div>
  );
}
