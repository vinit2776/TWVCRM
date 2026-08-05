"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { ChevronLeft, ChevronRight, Receipt } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { EmptyState } from "@/components/shared/empty-state";
import { TableSkeleton } from "@/components/shared/loading-skeleton";
import {
  INVOICE_STATUSES, INVOICE_STATUS_LABELS,
  ACCOUNTING_HEAD_LABELS, ACCOUNTING_HEAD_COLORS, type AccountingHead,
} from "@/lib/constants";
import { formatDate, formatCurrency, isOverdue } from "@/lib/utils";
import { cn } from "@/lib/utils";
import type { ProformaInvoice } from "@/types";

const STATUS_COLORS: Record<string, string> = {
  draft: "bg-gray-100 text-gray-800", sent: "bg-blue-100 text-blue-800",
  paid: "bg-green-100 text-green-800", overdue: "bg-red-100 text-red-800",
  cancelled: "bg-gray-100 text-gray-500",
};

export default function InvoicesPage() {
  const [invoices, setInvoices] = useState<(ProformaInvoice & { lead?: { id: string; first_name: string; last_name: string } })[]>([]);
  const [pagination, setPagination] = useState({ page: 1, limit: 25, total: 0, totalPages: 0 });
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState("");

  const fetchInvoices = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams({ page: String(page) });
    if (statusFilter) params.set("status", statusFilter);
    const res = await fetch(`/api/invoices?${params}`);
    if (res.ok) { const json = await res.json(); setInvoices(json.data || []); setPagination(json.pagination); }
    setLoading(false);
  }, [page, statusFilter]);

  useEffect(() => { fetchInvoices(); }, [fetchInvoices]);

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Proforma Invoices</h1>
          <p className="text-sm text-muted-foreground">{pagination.total} total invoices</p>
        </div>
        <Select value={statusFilter} onValueChange={(val) => { setStatusFilter(val === "all" ? "" : val); setPage(1); }}>
          <SelectTrigger className="w-[160px]"><SelectValue placeholder="All Statuses" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Statuses</SelectItem>
            {INVOICE_STATUSES.map((s) => <SelectItem key={s} value={s}>{INVOICE_STATUS_LABELS[s]}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      {loading ? <TableSkeleton rows={6} /> : invoices.length === 0 ? (
        <EmptyState icon={Receipt} title="No invoices found" description="Create invoices from lead detail pages." />
      ) : (
        <div className="rounded-md border overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="border-b bg-muted/50">
              <th className="px-4 py-3 text-left font-medium">Invoice #</th>
              <th className="px-4 py-3 text-left font-medium">Title</th>
              <th className="px-4 py-3 text-left font-medium hidden md:table-cell">Lead</th>
              <th className="px-4 py-3 text-left font-medium hidden md:table-cell">Head</th>
              <th className="px-4 py-3 text-left font-medium">Status</th>
              <th className="px-4 py-3 text-right font-medium hidden md:table-cell">Amount</th>
              <th className="px-4 py-3 text-left font-medium hidden lg:table-cell">Due Date</th>
              <th className="px-4 py-3 text-left font-medium hidden lg:table-cell">Created</th>
            </tr></thead>
            <tbody>{invoices.map((inv) => (
              <tr key={inv.id} className="border-b hover:bg-muted/30 transition-colors">
                <td className="px-4 py-3 font-mono text-xs">{inv.invoice_number}</td>
                <td className="px-4 py-3 font-medium" title={inv.internal_notes ? `Internal note: ${inv.internal_notes}` : undefined}>{inv.title}</td>
                <td className="px-4 py-3 hidden md:table-cell">{inv.lead ? <Link href={`/leads/${inv.lead.id}`} className="text-primary hover:underline">{inv.lead.first_name} {inv.lead.last_name}</Link> : "-"}</td>
                <td className="px-4 py-3 hidden md:table-cell">
                  {inv.primary_head ? (
                    <Badge variant="outline" className={cn("text-xs", ACCOUNTING_HEAD_COLORS[inv.primary_head as AccountingHead])}>
                      {ACCOUNTING_HEAD_LABELS[inv.primary_head as AccountingHead] || inv.primary_head}
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="text-xs bg-amber-50 text-amber-800 border-amber-200">
                      Needs Review
                    </Badge>
                  )}
                </td>
                <td className="px-4 py-3"><Badge variant="secondary" className={STATUS_COLORS[inv.status]}>{INVOICE_STATUS_LABELS[inv.status]}</Badge></td>
                <td className="px-4 py-3 text-right hidden md:table-cell font-medium">{formatCurrency(inv.total_amount)}</td>
                <td className="px-4 py-3 hidden lg:table-cell">
                  {inv.due_date ? <span className={cn(inv.status !== "paid" && isOverdue(inv.due_date) && "text-red-600 font-medium")}>{formatDate(inv.due_date)}</span> : "-"}
                </td>
                <td className="px-4 py-3 text-muted-foreground hidden lg:table-cell">{formatDate(inv.created_at)}</td>
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
