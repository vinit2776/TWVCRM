"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ChevronLeft, ChevronRight, FileText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { EmptyState } from "@/components/shared/empty-state";
import { TableSkeleton } from "@/components/shared/loading-skeleton";
import { PROPOSAL_STATUSES, PROPOSAL_STATUS_LABELS, PROPOSAL_STATUS_COLORS } from "@/lib/constants";
import { formatDate, formatCurrency } from "@/lib/utils";
import { HANDOFF_STATE_LABELS, bucketFor, type HandoffState } from "@/lib/tally-handoff";
import type { Proposal } from "@/types";
import { PageBreadcrumb } from "@/components/page-breadcrumb";
import { pushTrailEntry } from "@/lib/nav-trail";

type LatestBillingStatement = { handoff_state: HandoffState | null; payment_status: string } | null;

/** Colors mirror the bucket a handoff_state belongs to on the Tally Inbox page —
 *  same visual vocabulary, so a sales rep who's seen the inbox recognizes it. */
function flowBadgeClass(state: HandoffState | null | undefined): string {
  const bucket = bucketFor(state);
  switch (bucket) {
    case "gst_to_issue": return "bg-blue-100 text-blue-700 border-blue-200";
    case "payment_to_record": return "bg-green-100 text-green-700 border-green-200";
    case "complete": return "bg-emerald-100 text-emerald-700 border-emerald-200";
    case "in_flight": return "bg-amber-100 text-amber-700 border-amber-200";
    default: return "bg-gray-100 text-gray-600 border-gray-200";
  }
}

export default function ProposalsPage() {
  const router = useRouter();
  const [proposals, setProposals] = useState<(Proposal & { lead?: { id: string; first_name: string; last_name: string; company?: string | null }; latest_billing_statement?: LatestBillingStatement })[]>([]);
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
      <PageBreadcrumb resetTo={{ label: "Proposals" }} />
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
              <th className="px-4 py-3 text-left font-medium hidden md:table-cell">Company</th>
              <th className="px-4 py-3 text-left font-medium">Status</th>
              <th className="px-4 py-3 text-left font-medium hidden lg:table-cell">Location</th>
              <th className="px-4 py-3 text-right font-medium hidden md:table-cell">Amount</th>
              <th className="px-4 py-3 text-left font-medium hidden lg:table-cell">Created</th>
            </tr></thead>
            <tbody>{proposals.map((p) => (
              <tr
                key={p.id}
                className="border-b hover:bg-muted/30 transition-colors cursor-pointer"
                onClick={() => {
                  pushTrailEntry({ href: `/proposals/${p.id}`, label: p.proposal_number });
                  router.push(`/proposals/${p.id}`);
                }}
              >
                <td className="px-4 py-3 font-mono text-xs">{p.proposal_number}</td>
                <td className="px-4 py-3 font-medium">{p.title}</td>
                <td className="px-4 py-3 hidden md:table-cell" onClick={(e) => e.stopPropagation()}>{p.lead ? <Link href={`/leads/${p.lead.id}`} className="text-primary hover:underline">{p.lead.first_name} {p.lead.last_name}</Link> : "-"}</td>
                <td className="px-4 py-3 text-muted-foreground hidden md:table-cell">{p.lead?.company || "—"}</td>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <Badge variant="secondary" className={PROPOSAL_STATUS_COLORS[p.status]}>{PROPOSAL_STATUS_LABELS[p.status]}</Badge>
                    {/* Deposit status badge — shown when deposit is required but not yet collected */}
                    {Number(p.security_deposit_months || 0) > 0 && p.deposit_payment_status === "pending" && ["sent", "viewed", "accepted"].includes(p.status) && (
                      <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full border ${
                        !p.deposit_razorpay_link_id
                          ? "bg-red-100 text-red-700 border-red-200"
                          : "bg-amber-100 text-amber-700 border-amber-200"
                      }`}>
                        {!p.deposit_razorpay_link_id ? "Deposit Not Sent" : "Deposit Pending"}
                      </span>
                    )}
                    {/* Escalating "needs activation" badge — shown when both payments are in */}
                    {p.status === "accepted" && p.payment_status === "paid" && (p.deposit_payment_status === "paid" || p.deposit_payment_status === "not_required" || !p.security_deposit_months) && (() => {
                      const daysAgo = p.accepted_at ? Math.floor((Date.now() - new Date(p.accepted_at).getTime()) / 86400000) : 0;
                      if (daysAgo < 1) return null;
                      const color = daysAgo >= 21
                        ? "bg-red-100 text-red-700 border-red-200"
                        : daysAgo >= 8
                        ? "bg-orange-100 text-orange-700 border-orange-200"
                        : "bg-amber-100 text-amber-700 border-amber-200";
                      return <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full border ${color}`}>Activate Contract</span>;
                    })()}
                    {/* PI flow-status badge — where the proposal's first-month invoice
                        stands in Accounts Receivable / Tally Inbox. */}
                    <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full border ${flowBadgeClass(p.latest_billing_statement?.handoff_state)}`}>
                      {p.latest_billing_statement?.handoff_state
                        ? HANDOFF_STATE_LABELS[p.latest_billing_statement.handoff_state]
                        : "No PI Sent"}
                    </span>
                  </div>
                </td>
                <td className="px-4 py-3 text-muted-foreground hidden lg:table-cell">{p.location?.name || "—"}</td>
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
