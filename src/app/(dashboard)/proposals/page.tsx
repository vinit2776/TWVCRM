"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { ChevronLeft, ChevronRight, FileText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { EmptyState } from "@/components/shared/empty-state";
import { TableSkeleton } from "@/components/shared/loading-skeleton";
import { PROPOSAL_STATUSES, PROPOSAL_STATUS_LABELS } from "@/lib/constants";
import { formatDate, formatCurrency } from "@/lib/utils";
import type { Proposal } from "@/types";

const STATUS_COLORS: Record<string, string> = {
  draft: "bg-gray-100 text-gray-800", sent: "bg-blue-100 text-blue-800",
  viewed: "bg-purple-100 text-purple-800", accepted: "bg-green-100 text-green-800",
  rejected: "bg-red-100 text-red-800", expired: "bg-orange-100 text-orange-800",
};

export default function ProposalsPage() {
  const [proposals, setProposals] = useState<(Proposal & { lead?: { id: string; first_name: string; last_name: string } })[]>([]);
  const [pagination, setPagination] = useState({ page: 1, limit: 25, total: 0, totalPages: 0 });
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState("");

  const fetchProposals = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams({ page: String(page) });
    if (statusFilter) params.set("status", statusFilter);
    const res = await fetch(`/api/proposals?${params}`);
    if (res.ok) { const json = await res.json(); setProposals(json.data || []); setPagination(json.pagination); }
    setLoading(false);
  }, [page, statusFilter]);

  useEffect(() => { fetchProposals(); }, [fetchProposals]);

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Proposals</h1>
          <p className="text-sm text-muted-foreground">{pagination.total} total proposals</p>
        </div>
        <Select value={statusFilter} onValueChange={(val) => { setStatusFilter(val === "all" ? "" : val); setPage(1); }}>
          <SelectTrigger className="w-[160px]"><SelectValue placeholder="All Statuses" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Statuses</SelectItem>
            {PROPOSAL_STATUSES.map((s) => <SelectItem key={s} value={s}>{PROPOSAL_STATUS_LABELS[s]}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      {loading ? <TableSkeleton rows={6} /> : proposals.length === 0 ? (
        <EmptyState icon={FileText} title="No proposals found" description="Create proposals from lead detail pages." />
      ) : (
        <div className="rounded-md border overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="border-b bg-muted/50">
              <th className="px-4 py-3 text-left font-medium">Proposal #</th>
              <th className="px-4 py-3 text-left font-medium">Title</th>
              <th className="px-4 py-3 text-left font-medium hidden md:table-cell">Lead</th>
              <th className="px-4 py-3 text-left font-medium">Status</th>
              <th className="px-4 py-3 text-right font-medium hidden md:table-cell">Amount</th>
              <th className="px-4 py-3 text-left font-medium hidden lg:table-cell">Created</th>
            </tr></thead>
            <tbody>{proposals.map((p) => (
              <tr key={p.id} className="border-b hover:bg-muted/30 transition-colors">
                <td className="px-4 py-3 font-mono text-xs">{p.proposal_number}</td>
                <td className="px-4 py-3 font-medium">{p.title}</td>
                <td className="px-4 py-3 hidden md:table-cell">{p.lead ? <Link href={`/leads/${p.lead.id}`} className="text-primary hover:underline">{p.lead.first_name} {p.lead.last_name}</Link> : "-"}</td>
                <td className="px-4 py-3"><Badge variant="secondary" className={STATUS_COLORS[p.status]}>{PROPOSAL_STATUS_LABELS[p.status]}</Badge></td>
                <td className="px-4 py-3 text-right hidden md:table-cell font-medium">{formatCurrency(p.total_amount)}</td>
                <td className="px-4 py-3 text-muted-foreground hidden lg:table-cell">{formatDate(p.created_at)}</td>
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
