"use client";

/**
 * "Paid" tab on the Accounts Receivable page. Server-paginated (20 rows at a
 * time via /api/accounting/receivables/paid) rather than fetched in full —
 * unlike open AR, the paid history only grows over time.
 */

import { useState, useEffect, useCallback, useRef } from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Loader2, FileDown, History, CheckCircle2 } from "lucide-react";
import { toast } from "sonner";
import { formatCurrency, formatDate } from "@/lib/utils";
import { BillingLifecycleStatus } from "@/components/billing/billing-lifecycle-status";
import { PaymentDetailDialog, formatPaymentMode, type PaymentDetail } from "@/components/billing/payment-detail-dialog";

interface Lead {
  id: string;
  first_name?: string;
  last_name?: string;
  company?: string;
}

interface AggregatorRef {
  id: string;
  name: string;
  primary_email?: string | null;
  primary_phone?: string | null;
}

interface CaseRef {
  id: string;
  case_number: string;
  client_name: string;
  client_company_name?: string | null;
  client_email?: string | null;
  client_phone?: string | null;
  bill_to?: "aggregator" | "client" | null;
  aggregator?: AggregatorRef | null;
}

interface PaidRow {
  id: string;
  statement_number: string;
  statement_type: "rent" | "usage" | "combined" | "vo_case" | "vo_aggregator_consolidated" | "vo_renewal" | "electricity" | "reimbursement";
  period_start: string;
  period_end: string;
  total_amount: number;
  gst_invoice_number: string | null;
  paid_on: string | null;
  payment_mode: string | null;
  status: string;
  payment_status: string | null;
  accounted: boolean | null;
  proforma_sent_at: string | null;
  pi_cancelled_at: string | null;
  proforma_viewed_at: string | null;
  gst_invoice_viewed_at: string | null;
  payments: PaymentDetail[];
  contract: { id: string; contract_number: string; lead?: Lead } | null;
  proposal?: { id: string; proposal_number: string; lead?: Lead } | null;
  invoice?: { id: string; invoice_number: string; lead?: Lead } | null;
  case?: CaseRef | null;
  aggregator?: AggregatorRef | null;
}

interface Party {
  number: string;
  lead?: Lead;
  href: string;
  kind: "contract" | "proposal" | "invoice" | "case" | "aggregator" | "unknown";
}

/** Synthesizes a Lead-shaped object from a Virtual Office case or aggregator —
 *  mirrors the same helper on the main Accounts Receivable page. */
function leadFromCase(c: CaseRef): Lead {
  const billTo = c.bill_to === "aggregator" ? c.aggregator : null;
  return {
    id: c.id,
    company: billTo?.name ?? c.client_company_name ?? c.client_name,
  };
}

function leadFromAggregator(a: AggregatorRef): Lead {
  return { id: a.id, company: a.name };
}

function partyOf(row: PaidRow): Party {
  if (row.contract) return { number: row.contract.contract_number, lead: row.contract.lead, href: `/contracts/${row.contract.id}`, kind: "contract" };
  if (row.proposal) return { number: row.proposal.proposal_number, lead: row.proposal.lead, href: `/proposals/${row.proposal.id}`, kind: "proposal" };
  if (row.invoice) return { number: row.invoice.invoice_number, lead: row.invoice.lead, href: `/leads/${row.invoice.lead?.id ?? ""}`, kind: "invoice" };
  if (row.case) return { number: row.case.case_number, lead: leadFromCase(row.case), href: `/cases/${row.case.id}`, kind: "case" };
  if (row.aggregator) return { number: row.aggregator.name, lead: leadFromAggregator(row.aggregator), href: `/aggregators/${row.aggregator.id}`, kind: "aggregator" };
  return { number: "—", lead: undefined, href: "#", kind: "unknown" };
}

function customerName(lead?: Lead): string {
  if (!lead) return "—";
  if (lead.company) return lead.company;
  return `${lead.first_name || ""} ${lead.last_name || ""}`.trim() || "—";
}

const PAGE_SIZE = 20;

export function PaidStatementsPanel({
  search,
  onOpenHistory,
}: {
  search: string;
  onOpenHistory: (row: { id: string; statement_number: string }) => void;
}) {
  const [rows, setRows] = useState<PaidRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [detailRow, setDetailRow] = useState<PaidRow | null>(null);
  const requestIdRef = useRef(0);

  const fetchPage = useCallback(async (pageNum: number, replace: boolean, searchTerm: string) => {
    const requestId = ++requestIdRef.current;
    if (replace) setLoading(true); else setLoadingMore(true);
    try {
      const params = new URLSearchParams({ page: String(pageNum), limit: String(PAGE_SIZE) });
      if (searchTerm.trim()) params.set("search", searchTerm.trim());
      const res = await fetch(`/api/accounting/receivables/paid?${params}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to load paid statements");
      if (requestId !== requestIdRef.current) return; // stale response — a newer search/page superseded this one
      setRows((prev) => (replace ? json.rows : [...prev, ...json.rows]));
      setTotal(json.total || 0);
      setPage(pageNum);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to load paid statements");
    } finally {
      if (requestId === requestIdRef.current) { setLoading(false); setLoadingMore(false); }
    }
  }, []);

  // Debounced reload from page 1 whenever the shared search box changes.
  useEffect(() => {
    const t = setTimeout(() => fetchPage(1, true, search), 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  const hasMore = rows.length < total;

  if (loading) {
    return <div className="p-8 text-center text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin inline mr-2" /> Loading…</div>;
  }

  if (rows.length === 0) {
    return (
      <div className="p-12 text-center text-muted-foreground">
        {search ? "No paid statements match this search." : "No statements have been paid yet."}
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between px-4 py-3 border-b bg-gray-50">
        <div>
          <div className="text-sm font-semibold">Paid statements</div>
          <div className="text-xs text-muted-foreground">Finalized statements settled in full — sorted by most recently paid.</div>
        </div>
        <span className="text-xs text-muted-foreground bg-white border rounded-full px-2.5 py-1">
          Showing {rows.length} of {total}
        </span>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-xs uppercase text-gray-600 border-b">
            <tr>
              <th className="px-4 py-3 text-left">Contract / Customer</th>
              <th className="px-4 py-3 text-left">Statement</th>
              <th className="px-4 py-3 text-left">Period</th>
              <th className="px-4 py-3 text-left">Paid</th>
              <th className="px-4 py-3 text-right">Amount</th>
              <th className="px-4 py-3 text-left">Mode</th>
              <th className="px-4 py-3 text-left">Lifecycle</th>
              <th className="px-4 py-3"></th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {rows.map((r) => {
              const party = partyOf(r);
              return (
                <tr key={r.id} className="hover:bg-gray-50 cursor-pointer" onClick={() => setDetailRow(r)}>
                  <td className="px-4 py-3">
                    <div className="font-medium">
                      <Link href={party.href} className="text-teal-700 hover:underline" onClick={(e) => e.stopPropagation()}>{party.number}</Link>
                      {party.kind === "proposal" && <Badge variant="outline" className="ml-1.5 text-[10px]">Proposal PI</Badge>}
                      {party.kind === "invoice" && <Badge variant="outline" className="ml-1.5 text-[10px]">Ad-hoc Invoice</Badge>}
                    </div>
                    <div className="text-xs text-muted-foreground">{customerName(party.lead)}</div>
                  </td>
                  <td className="px-4 py-3">
                    {r.gst_invoice_number ? (
                      <Link href={`/api/billing-statements/${r.id}/gst-invoice-pdf`} target="_blank" className="text-teal-700 hover:underline font-mono text-xs flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                        {r.gst_invoice_number}<FileDown className="h-3 w-3" />
                      </Link>
                    ) : (
                      <Link href={`/api/billing-statements/${r.id}/proforma-pdf`} target="_blank" className="text-teal-700 hover:underline font-mono text-xs flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                        {r.statement_number}<FileDown className="h-3 w-3" />
                      </Link>
                    )}
                    <Badge variant="outline" className="text-[10px] mt-1 capitalize">{r.statement_type}</Badge>
                  </td>
                  <td className="px-4 py-3 text-xs whitespace-nowrap">
                    {formatDate(r.period_start)}<br />
                    <span className="text-muted-foreground">→ {formatDate(r.period_end)}</span>
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap">
                    <Badge className="bg-emerald-100 text-emerald-800 border-emerald-300 flex items-center gap-1 w-fit">
                      <CheckCircle2 className="h-3 w-3" /> Paid in full
                    </Badge>
                    <div className="text-xs text-muted-foreground mt-1">{r.paid_on ? formatDate(r.paid_on) : "—"}</div>
                  </td>
                  <td className="px-4 py-3 text-right whitespace-nowrap font-semibold text-teal-700">{formatCurrency(r.total_amount)}</td>
                  <td className="px-4 py-3 text-xs capitalize whitespace-nowrap">{formatPaymentMode(r.payment_mode)}</td>
                  <td className="px-4 py-3 whitespace-nowrap">
                    <BillingLifecycleStatus
                      status={r.status}
                      payment_status={r.payment_status}
                      accounted={r.accounted}
                      gst_invoice_number={r.gst_invoice_number}
                      proforma_sent_at={r.proforma_sent_at}
                      pi_cancelled_at={r.pi_cancelled_at}
                      proforma_viewed_at={r.proforma_viewed_at}
                      gst_invoice_viewed_at={r.gst_invoice_viewed_at}
                    />
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                    <div className="flex items-center gap-1 justify-end">
                      <Button size="sm" variant="ghost" onClick={() => onOpenHistory(r)} title="View send/payment history">
                        <History className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="flex flex-col items-center gap-2 py-5">
        {hasMore ? (
          <Button variant="outline" onClick={() => fetchPage(page + 1, false, search)} disabled={loadingMore}>
            {loadingMore ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
            Load 20 more
          </Button>
        ) : (
          <span className="text-xs text-muted-foreground">All {total} paid statement{total === 1 ? "" : "s"} loaded.</span>
        )}
      </div>

      <PaymentDetailDialog
        row={detailRow && {
          ...detailRow,
          partyNumber: partyOf(detailRow).number,
          partyCustomerName: customerName(partyOf(detailRow).lead),
        }}
        onClose={() => setDetailRow(null)}
        onOpenHistory={onOpenHistory}
      />
    </div>
  );
}
