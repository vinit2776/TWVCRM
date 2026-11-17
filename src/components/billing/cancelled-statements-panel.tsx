"use client";

/**
 * "Cancelled" tab on Accounts Receivable. Cancelled invoices leave the open
 * list, so this is where the reason for each cancellation stays on the line.
 */

import { useState, useEffect, useCallback, useRef } from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Loader2, History, Ban } from "lucide-react";
import { toast } from "sonner";
import { formatCurrency, formatDate } from "@/lib/utils";

interface Lead { id: string; first_name?: string; last_name?: string; company?: string }

interface CancelledRow {
  id: string;
  statement_number: string;
  statement_type: string;
  total_amount: number;
  gst_invoice_number: string | null;
  voided_at: string | null;
  void_reason: string | null;
  tally_credit_note_number: string | null;
  voided_by_user: { full_name: string } | null;
  contract: { id: string; contract_number: string; lead?: Lead } | null;
  invoice: { id: string; invoice_number: string; lead?: Lead } | null;
}

function customerName(lead?: Lead): string {
  if (!lead) return "—";
  return lead.company || `${lead.first_name || ""} ${lead.last_name || ""}`.trim() || "—";
}

const PAGE_SIZE = 20;

export function CancelledStatementsPanel({
  search,
  onOpenHistory,
}: {
  search: string;
  onOpenHistory: (row: { id: string; statement_number: string }) => void;
}) {
  const [rows, setRows] = useState<CancelledRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const requestIdRef = useRef(0);

  const fetchPage = useCallback(async (pageNum: number, replace: boolean, term: string) => {
    const requestId = ++requestIdRef.current;
    if (replace) setLoading(true); else setLoadingMore(true);
    try {
      const params = new URLSearchParams({ page: String(pageNum), limit: String(PAGE_SIZE) });
      if (term.trim()) params.set("search", term.trim());
      const res = await fetch(`/api/accounting/receivables/cancelled?${params}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to load cancelled invoices");
      if (requestId !== requestIdRef.current) return;
      setRows((prev) => (replace ? json.rows : [...prev, ...json.rows]));
      setTotal(json.total || 0);
      setPage(pageNum);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to load cancelled invoices");
    } finally {
      if (requestId === requestIdRef.current) { setLoading(false); setLoadingMore(false); }
    }
  }, []);

  useEffect(() => {
    const t = setTimeout(() => fetchPage(1, true, search), 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  if (loading) {
    return <div className="p-8 text-center text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin inline mr-2" /> Loading…</div>;
  }
  if (rows.length === 0) {
    return <div className="p-12 text-center text-muted-foreground">{search ? "No cancelled invoices match this search." : "No invoices have been cancelled."}</div>;
  }

  return (
    <div>
      <div className="px-4 py-3 border-b bg-gray-50">
        <div className="text-sm font-semibold">Cancelled</div>
        <div className="text-xs text-muted-foreground">{total} invoice{total === 1 ? "" : "s"} · most recent first</div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-xs uppercase text-gray-600 border-b">
            <tr>
              <th className="px-4 py-3 text-left">Contract / Customer</th>
              <th className="px-4 py-3 text-left">Invoice</th>
              <th className="px-4 py-3 text-left">Reason for cancelling</th>
              <th className="px-4 py-3 text-left">Cancelled</th>
              <th className="px-4 py-3 text-right">Amount</th>
              <th className="px-4 py-3"></th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {rows.map((r) => {
              const ref = r.contract
                ? { label: r.contract.contract_number, href: `/contracts/${r.contract.id}`, lead: r.contract.lead }
                : r.invoice
                  ? { label: r.invoice.invoice_number, href: `/leads/${r.invoice.lead?.id ?? ""}`, lead: r.invoice.lead }
                  : { label: "—", href: "#", lead: undefined };
              return (
                <tr key={r.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3">
                    <Link href={ref.href} className="font-medium text-teal-700 hover:underline">{ref.label}</Link>
                    <div className="text-xs text-muted-foreground">{customerName(ref.lead)}</div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="font-mono text-xs">{r.gst_invoice_number ?? r.statement_number}</div>
                    <Badge variant="outline" className="text-[10px] mt-1 capitalize">{r.statement_type}</Badge>
                  </td>
                  <td className="px-4 py-3 text-xs max-w-xs">{r.void_reason || "—"}</td>
                  <td className="px-4 py-3 whitespace-nowrap">
                    <Badge className="bg-red-100 text-red-800 border-red-300 flex items-center gap-1 w-fit">
                      <Ban className="h-3 w-3" /> Cancelled
                    </Badge>
                    <div className="text-xs text-muted-foreground mt-1">
                      {r.voided_at ? formatDate(r.voided_at) : "—"}
                      {r.voided_by_user?.full_name ? ` · ${r.voided_by_user.full_name}` : ""}
                    </div>
                    {r.tally_credit_note_number && (
                      <div className="text-xs font-mono text-red-700">CN {r.tally_credit_note_number}</div>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right whitespace-nowrap font-semibold">{formatCurrency(r.total_amount)}</td>
                  <td className="px-4 py-3 whitespace-nowrap text-right">
                    <Button size="sm" variant="ghost" onClick={() => onOpenHistory(r)} title="View history">
                      <History className="h-3.5 w-3.5" />
                    </Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="flex flex-col items-center gap-2 py-5">
        {rows.length < total ? (
          <Button variant="outline" onClick={() => fetchPage(page + 1, false, search)} disabled={loadingMore}>
            {loadingMore ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null} Load 20 more
          </Button>
        ) : (
          <span className="text-xs text-muted-foreground">All {total} cancelled invoice{total === 1 ? "" : "s"} loaded.</span>
        )}
      </div>
    </div>
  );
}
