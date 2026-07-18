"use client";

/**
 * Accounts Receivable — collections workspace.
 *
 * Shows every finalized billing statement that isn't fully paid, aged by
 * due_date. The page is the day-to-day surface for the accounts team to:
 *   • see who owes what, ordered by how overdue they are
 *   • record an offline payment without leaving the page
 *   • resend the proforma (re-uses the existing send-proforma endpoint)
 *   • copy the customer contact (email / phone) for follow-up calls
 *
 * Data comes from /api/accounting/receivables in a single call; all filter
 * tabs are client-side so flipping between them is instant.
 *
 * Reminder send + escalation ladder land in PR B (cron). For now this page is
 * read-and-record only.
 */

import { useState, useEffect, useMemo, useCallback } from "react";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { Loader2, IndianRupee, Mail, Phone, ExternalLink, Send, FileDown, Search, Bell, History, Download, LayoutList, BarChart2, Eye, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { formatCurrency, formatDate } from "@/lib/utils";
import { BillingLifecycleStatus } from "@/components/billing/billing-lifecycle-status";
import { RecordPaymentDialog } from "@/components/billing/record-payment-dialog";

interface Lead {
  id: string;
  first_name?: string;
  last_name?: string;
  company?: string;
  email?: string;
  phone?: string;
  mobile?: string;
  billing_emails?: string[];
}

interface Contract {
  id: string;
  contract_number: string;
  title?: string;
  billing_mode?: "proforma_first" | "gst_direct" | null;
  lead?: Lead;
}

interface ProposalRef {
  id: string;
  proposal_number: string;
  lead?: Lead;
}

interface InvoiceRef {
  id: string;
  invoice_number: string;
  lead?: Lead;
}

/** Normalizes a row's owner (contract, proposal PI, or ad-hoc lead invoice) into
 *  one shape so the UI doesn't need a branch per site. */
interface Party {
  id: string;
  number: string;
  lead?: Lead;
  href: string;
  isProposal: boolean;
  kind: "contract" | "proposal" | "invoice" | "unknown";
}

function partyOf(row: { contract: Contract | null; proposal?: ProposalRef | null; invoice?: InvoiceRef | null }): Party {
  if (row.contract) {
    return { id: row.contract.id, number: row.contract.contract_number, lead: row.contract.lead, href: `/contracts/${row.contract.id}`, isProposal: false, kind: "contract" };
  }
  if (row.proposal) {
    return { id: row.proposal.id, number: row.proposal.proposal_number, lead: row.proposal.lead, href: `/proposals/${row.proposal.id}`, isProposal: true, kind: "proposal" };
  }
  if (row.invoice) {
    return { id: row.invoice.id, number: row.invoice.invoice_number, lead: row.invoice.lead, href: `/leads/${row.invoice.lead?.id ?? ""}`, isProposal: false, kind: "invoice" };
  }
  return { id: "", number: "—", lead: undefined, href: "#", isProposal: false, kind: "unknown" };
}

interface ReceivableRow {
  id: string;
  statement_number: string;
  statement_type: "rent" | "usage" | "combined";
  period_start: string;
  period_end: string;
  due_date: string | null;
  total_amount: number;
  amount_paid: number;
  balance_due: number;
  payment_status: "unpaid" | "partially_paid";
  proforma_sent_at: string | null;
  proforma_viewed_at?: string | null;
  gst_invoice_viewed_at?: string | null;
  razorpay_payment_link_url: string | null;
  last_reminder_sent_at: string | null;
  reminder_count: number;
  days_overdue: number | null;
  status: string;
  gst_invoice_number: string | null;
  pi_cancelled_at: string | null;
  accounted: boolean;
  contract: Contract | null;
  proposal?: ProposalRef | null;
  invoice?: InvoiceRef | null;
}

interface Summary {
  total_outstanding: number;
  count: number;
  due_soon: number;
  overdue: number;
  overdue_30: number;
  oldest_days: number;
}

type FilterKey = "all" | "due_soon" | "overdue" | "overdue_30" | "partial";
type ViewMode = "detail" | "ageing";

/** One row in the Ageing view — aggregates all statements for a contract. */
interface AgingRow {
  contractId: string;
  contractNumber: string;
  customerName: string;
  lead?: Lead;
  href: string;
  notDue: number;     // days_overdue < 0
  d1_15: number;      // 0 – 15
  d16_30: number;     // 16 – 30
  d31_45: number;     // 31 – 45
  d45plus: number;    // > 45
  total: number;
}

const FILTERS: { key: FilterKey; label: string; hint: string }[] = [
  { key: "all",        label: "All open",       hint: "Every unpaid / partial statement" },
  { key: "due_soon",   label: "Due ≤ 7 days",   hint: "Due date within the next week" },
  { key: "overdue",    label: "Overdue",        hint: "Due date is in the past" },
  { key: "overdue_30", label: "Overdue 30+",    hint: "More than a month past due" },
  { key: "partial",    label: "Partially paid", hint: "Some money in, balance pending" },
];

function customerName(lead?: Lead): string {
  if (!lead) return "—";
  if (lead.company) return lead.company;
  return `${lead.first_name || ""} ${lead.last_name || ""}`.trim() || "—";
}

/** gst_direct contracts never have a proforma stage — the invoice route is
 *  the contract's billing_mode, not just whether a GST invoice number has
 *  been generated yet (which can lag behind for a brand-new statement). */
function isGstRoute(row: Pick<ReceivableRow, "gst_invoice_number" | "contract">): boolean {
  return row.contract?.billing_mode === "gst_direct" || !!row.gst_invoice_number;
}

/** Primary contact email + lead billing_emails, deduped, primary first. */
function candidateRecipients(lead?: Lead): string[] {
  if (!lead) return [];
  return Array.from(new Set([lead.email, ...(lead.billing_emails || [])].filter(Boolean))) as string[];
}

function daysOverdueBadge(days: number | null) {
  if (days === null) return <Badge variant="outline" className="text-muted-foreground">No due date</Badge>;
  if (days < 0) return <Badge variant="outline" className="bg-emerald-50 text-emerald-700 border-emerald-200">Due in {Math.abs(days)}d</Badge>;
  if (days === 0) return <Badge className="bg-amber-100 text-amber-800 border-amber-300">Due today</Badge>;
  if (days < 7)  return <Badge className="bg-amber-100 text-amber-800 border-amber-300">{days}d overdue</Badge>;
  if (days < 30) return <Badge className="bg-orange-100 text-orange-800 border-orange-300">{days}d overdue</Badge>;
  return <Badge className="bg-red-100 text-red-800 border-red-300">{days}d overdue</Badge>;
}

export default function AccountsReceivablePage() {
  const [rows, setRows] = useState<ReceivableRow[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  // Deposits, top-ups and ad-hoc PIs — tracked separately from statements
  // because they carry a different shape (no GST, no proforma lifecycle).
  const [otherRows, setOtherRows] = useState<OtherReceivableRow[]>([]);
  const [otherSummary, setOtherSummary] = useState<OtherSummary | null>(null);
  const [avgDays, setAvgDays] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<FilterKey>("all");
  const [search, setSearch] = useState("");
  const [viewMode, setViewMode] = useState<ViewMode>("detail");
  const [canRecordPayment, setCanRecordPayment] = useState(false);

  // Record-payment dialog state (form lives in RecordPaymentDialog)
  const [payRow, setPayRow] = useState<ReceivableRow | null>(null);
  const [resending, setResending] = useState<string | null>(null);
  const [remindingId, setRemindingId] = useState<string | null>(null);

  // Resend dialog state
  const [resendRow, setResendRow] = useState<ReceivableRow | null>(null);
  const [resendCc, setResendCc] = useState("");
  const [resendSubmitting, setResendSubmitting] = useState(false);
  const [resendNewLink, setResendNewLink] = useState(false);
  // All addresses on file (primary contact email + lead billing_emails) default
  // checked; user can uncheck one-off for a specific send.
  const [resendRecipients, setResendRecipients] = useState<Set<string>>(new Set());

  // History drawer state
  const [historyRow, setHistoryRow] = useState<ReceivableRow | null>(null);
  const [historyItems, setHistoryItems] = useState<Array<{
    id: string;
    stage_index: number;
    stage_label: string;
    channel: string;
    recipient: string;
    status: string;
    error: string | null;
    triggered_by: string;
    sent_at: string;
    triggered_by_user?: { full_name: string } | null;
  }>>([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/accounting/receivables");
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to load");
      setRows(json.rows || []);
      setSummary(json.summary || null);
      setOtherRows(json.other_rows || []);
      setOtherSummary(json.other_summary || null);
      setAvgDays(json.avgDays || {});
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to load receivables");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    fetch("/api/me")
      .then((res) => res.json())
      .then((me) => setCanRecordPayment(["admin", "manager", "accounts"].includes(me.role)))
      .catch(() => setCanRecordPayment(false));
  }, []);

  const filtered = useMemo(() => {
    let r = rows;
    if (filter === "due_soon")   r = r.filter((x) => x.days_overdue !== null && x.days_overdue >= -7 && x.days_overdue < 0);
    if (filter === "overdue")    r = r.filter((x) => x.days_overdue !== null && x.days_overdue >= 0);
    if (filter === "overdue_30") r = r.filter((x) => x.days_overdue !== null && x.days_overdue >= 30);
    if (filter === "partial")    r = r.filter((x) => x.payment_status === "partially_paid");

    if (search.trim()) {
      const q = search.toLowerCase();
      r = r.filter((x) => {
        const party = partyOf(x);
        return (
          party.number?.toLowerCase().includes(q) ||
          x.statement_number?.toLowerCase().includes(q) ||
          customerName(party.lead).toLowerCase().includes(q)
        );
      });
    }
    return r;
  }, [rows, filter, search]);

  // ── Ageing view: group filtered statements by contract (or proposal) ─────
  const agingRows = useMemo((): AgingRow[] => {
    const byContract = new Map<string, AgingRow>();
    for (const r of filtered) {
      const party = partyOf(r);
      const key = party.id;
      if (!byContract.has(key)) {
        byContract.set(key, {
          contractId: party.id,
          contractNumber: party.number,
          customerName: customerName(party.lead),
          lead: party.lead,
          href: party.href,
          notDue: 0, d1_15: 0, d16_30: 0, d31_45: 0, d45plus: 0, total: 0,
        });
      }
      const row = byContract.get(key)!;
      const d = r.days_overdue ?? -1;
      if (d < 0)        row.notDue  += r.balance_due;
      else if (d <= 15) row.d1_15   += r.balance_due;
      else if (d <= 30) row.d16_30  += r.balance_due;
      else if (d <= 45) row.d31_45  += r.balance_due;
      else              row.d45plus += r.balance_due;
      row.total += r.balance_due;
    }
    // Sort: worst bucket first (>45d), then 31-45, etc.
    return Array.from(byContract.values()).sort((a, b) => {
      if (b.d45plus !== a.d45plus) return b.d45plus - a.d45plus;
      if (b.d31_45 !== a.d31_45)  return b.d31_45 - a.d31_45;
      return b.total - a.total;
    });
  }, [filtered]);

  const openPayDialog = (row: ReceivableRow) => setPayRow(row);

  const sendReminder = async (row: ReceivableRow) => {
    setRemindingId(row.id);
    try {
      const res = await fetch(`/api/billing-statements/${row.id}/send-reminder`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed");
      const channels = [json.emailSent && "email", json.whatsAppSent && "WhatsApp"].filter(Boolean).join(" + ");
      toast.success(`${json.toneLabel} sent via ${channels || "no channel"}`);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to send reminder");
    } finally {
      setRemindingId(null);
    }
  };

  const openHistory = async (row: ReceivableRow) => {
    setHistoryRow(row);
    setHistoryItems([]);
    setHistoryLoading(true);
    try {
      const res = await fetch(`/api/billing-statements/${row.id}/send-reminder`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed");
      setHistoryItems(json.history || []);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to load history");
    } finally {
      setHistoryLoading(false);
    }
  };

  const exportCsv = () => {
    window.location.href = "/api/accounting/receivables/export";
  };

  const openResendDialog = (row: ReceivableRow) => {
    setResendRow(row);
    setResendCc("");
    setResendNewLink(false);
    setResendRecipients(new Set(candidateRecipients(partyOf(row).lead)));
  };

  const toggleResendRecipient = (email: string) => {
    setResendRecipients((prev) => {
      const next = new Set(prev);
      if (next.has(email)) next.delete(email); else next.add(email);
      return next;
    });
  };

  const submitResend = async () => {
    if (!resendRow) return;
    if (resendRecipients.size === 0) { toast.error("Select at least one recipient"); return; }
    setResendSubmitting(true);
    const ccList = resendCc.split(/[,;\s]+/).map(s => s.trim()).filter(Boolean);
    const toList = Array.from(resendRecipients);
    const hasGst = !!resendRow.gst_invoice_number;

    // New-link path: cancel old link, create fresh one, resend invoice
    if (!hasGst && resendNewLink) {
      try {
        const res = await fetch(`/api/billing-statements/${resendRow.id}/reissue-payment-link`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ to: toList, cc: ccList.length > 0 ? ccList : undefined }),
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || "Failed");
        const sentTo = json.emailedTo || "";
        toast.success(`Fresh payment link created and resent${sentTo ? ` to ${sentTo}` : ""}${ccList.length > 0 ? ` (CC: ${ccList.join(", ")})` : ""}`);
        setResendRow(null);
        await load();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Failed to re-issue payment link");
      } finally {
        setResendSubmitting(false);
      }
      return;
    }

    const endpoint = hasGst
      ? `/api/billing-statements/${resendRow.id}/resend-gst-invoice`
      : `/api/billing-statements/${resendRow.id}/send-proforma`;
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to: toList, cc: ccList.length > 0 ? ccList : undefined }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed");
      const sentTo = json.emailedTo || json.emailed_to || "";
      toast.success(`${isGstRoute(resendRow) ? "GST invoice" : "Proforma"} resent${sentTo ? ` to ${sentTo}` : ""}${ccList.length > 0 ? ` (CC: ${ccList.join(", ")})` : ""}`);
      setResendRow(null);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to resend");
    } finally {
      setResendSubmitting(false);
    }
  };

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Accounts Receivable</h1>
        <p className="text-muted-foreground">Track outstanding payments, record offline receipts, and follow up on overdue invoices.</p>
      </div>

      {summary && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-sm font-medium text-muted-foreground">Total outstanding</CardTitle></CardHeader>
            <CardContent><div className="text-2xl font-bold text-teal-700">{formatCurrency(summary.total_outstanding)}</div></CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-sm font-medium text-muted-foreground">Open statements</CardTitle></CardHeader>
            <CardContent><div className="text-2xl font-bold">{summary.count}</div></CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-sm font-medium text-muted-foreground">Due ≤ 7 days</CardTitle></CardHeader>
            <CardContent><div className="text-2xl font-bold text-amber-700">{summary.due_soon}</div></CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-sm font-medium text-muted-foreground">Overdue</CardTitle></CardHeader>
            <CardContent><div className="text-2xl font-bold text-orange-700">{summary.overdue}</div></CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-sm font-medium text-muted-foreground">Overdue 30+</CardTitle></CardHeader>
            <CardContent><div className="text-2xl font-bold text-red-700">{summary.overdue_30}</div></CardContent>
          </Card>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            onClick={() => setFilter(f.key)}
            className={`px-3 py-1.5 rounded-full text-sm border transition ${
              filter === f.key
                ? "bg-teal-700 text-white border-teal-700"
                : "bg-white text-gray-700 border-gray-300 hover:border-teal-500"
            }`}
            title={f.hint}
          >
            {f.label}
          </button>
        ))}
        <div className="ml-auto flex items-center gap-2">
          <div className="relative">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search contract, statement #, customer"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-8 w-72"
            />
          </div>
          <div className="flex items-center border rounded-md overflow-hidden">
            <button
              onClick={() => setViewMode("detail")}
              title="Detailed statement view"
              className={`px-2.5 py-1.5 text-xs flex items-center gap-1 transition ${viewMode === "detail" ? "bg-teal-700 text-white" : "bg-white text-gray-600 hover:bg-gray-50"}`}
            >
              <LayoutList className="h-3.5 w-3.5" /> Detail
            </button>
            <button
              onClick={() => setViewMode("ageing")}
              title="Ageing bucket view — grouped by contract"
              className={`px-2.5 py-1.5 text-xs flex items-center gap-1 border-l transition ${viewMode === "ageing" ? "bg-teal-700 text-white" : "bg-white text-gray-600 hover:bg-gray-50"}`}
            >
              <BarChart2 className="h-3.5 w-3.5" /> Ageing
            </button>
          </div>
          <Button variant="outline" size="sm" onClick={exportCsv} title="Download AR aging report as CSV">
            <Download className="h-4 w-4 mr-1" /> Export CSV
          </Button>
        </div>
      </div>

      <Card>
        <CardContent className="p-0">
          {loading ? (
            <div className="p-8 text-center text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin inline mr-2" /> Loading…</div>
          ) : filtered.length === 0 ? (
            <div className="p-12 text-center text-muted-foreground">
              {rows.length === 0
                ? "No outstanding receivables — every finalized statement is paid in full. 🎉"
                : "No statements match this filter."}
            </div>
          ) : viewMode === "ageing" ? (
            /* ── Ageing view ── */
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-xs uppercase text-gray-600 border-b">
                  <tr>
                    <th className="px-4 py-3 text-left">Customer</th>
                    <th className="px-4 py-3 text-right text-emerald-700">Not due</th>
                    <th className="px-4 py-3 text-right text-yellow-700">1–15 days</th>
                    <th className="px-4 py-3 text-right text-orange-700">16–30 days</th>
                    <th className="px-4 py-3 text-right text-red-700">31–45 days</th>
                    <th className="px-4 py-3 text-right text-red-900">45+ days</th>
                    <th className="px-4 py-3 text-right font-semibold">Total</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {agingRows.map((r) => {
                    const avg = avgDays[r.contractId];
                    return (
                      <tr key={r.contractId} className="hover:bg-gray-50">
                        <td className="px-4 py-3">
                          <div className="font-medium">
                            <Link href={r.href} className="text-teal-700 hover:underline">
                              {r.contractNumber}
                            </Link>
                          </div>
                          <div className="text-xs text-muted-foreground">{r.customerName}</div>
                          {avg !== undefined && (
                            <div className={`text-[10px] mt-0.5 font-medium ${avg > 0 ? "text-red-600" : "text-emerald-600"}`}>
                              avg {avg > 0 ? `${avg}d late` : `${Math.abs(avg)}d early`}
                            </div>
                          )}
                        </td>
                        <td className="px-4 py-3 text-right whitespace-nowrap text-emerald-700">{r.notDue > 0 ? formatCurrency(r.notDue) : <span className="text-gray-300">—</span>}</td>
                        <td className="px-4 py-3 text-right whitespace-nowrap">
                          {r.d1_15 > 0 ? <span className="font-medium text-yellow-700">{formatCurrency(r.d1_15)}</span> : <span className="text-gray-300">—</span>}
                        </td>
                        <td className="px-4 py-3 text-right whitespace-nowrap">
                          {r.d16_30 > 0 ? <span className="font-medium text-orange-700">{formatCurrency(r.d16_30)}</span> : <span className="text-gray-300">—</span>}
                        </td>
                        <td className="px-4 py-3 text-right whitespace-nowrap">
                          {r.d31_45 > 0 ? <span className="font-medium text-red-700">{formatCurrency(r.d31_45)}</span> : <span className="text-gray-300">—</span>}
                        </td>
                        <td className="px-4 py-3 text-right whitespace-nowrap">
                          {r.d45plus > 0 ? <span className="font-bold text-red-900">{formatCurrency(r.d45plus)}</span> : <span className="text-gray-300">—</span>}
                        </td>
                        <td className="px-4 py-3 text-right whitespace-nowrap font-semibold text-teal-700">{formatCurrency(r.total)}</td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot className="bg-gray-50 border-t font-semibold text-xs">
                  <tr>
                    <td className="px-4 py-2 text-muted-foreground">Totals ({agingRows.length} contracts)</td>
                    {(["notDue","d1_15","d16_30","d31_45","d45plus","total"] as const).map((k) => (
                      <td key={k} className="px-4 py-2 text-right">
                        {formatCurrency(agingRows.reduce((s, r) => s + r[k], 0))}
                      </td>
                    ))}
                  </tr>
                </tfoot>
              </table>
            </div>
          ) : (
            /* ── Detail view ── */
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-xs uppercase text-gray-600 border-b">
                  <tr>
                    <th className="px-4 py-3 text-left">Contract / Customer</th>
                    <th className="px-4 py-3 text-left">Statement</th>
                    <th className="px-4 py-3 text-left">Period</th>
                    <th className="px-4 py-3 text-left">Due</th>
                    <th className="px-4 py-3 text-left">Lifecycle</th>
                    <th className="px-4 py-3 text-right">Total</th>
                    <th className="px-4 py-3 text-right">Paid</th>
                    <th className="px-4 py-3 text-right">Balance</th>
                    <th className="px-4 py-3 text-left">Last sent</th>
                    <th className="px-4 py-3"></th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {filtered.map((r) => {
                    const party = partyOf(r);
                    const avg = avgDays[party.id];
                    return (
                      <tr key={r.id} className="hover:bg-gray-50">
                        <td className="px-4 py-3">
                          <div className="font-medium">
                            <Link href={party.href} className="text-teal-700 hover:underline">
                              {party.number}
                            </Link>
                            {party.kind === "proposal" && (
                              <Badge variant="outline" className="ml-1.5 text-[10px]">Proposal PI</Badge>
                            )}
                            {party.kind === "invoice" && (
                              <Badge variant="outline" className="ml-1.5 text-[10px]">Ad-hoc Invoice</Badge>
                            )}
                          </div>
                          <div className="text-xs text-muted-foreground">{customerName(party.lead)}</div>
                          {avg !== undefined && (
                            <div className={`text-[10px] mt-0.5 font-medium ${avg > 0 ? "text-red-600" : "text-emerald-600"}`}>
                              avg {avg > 0 ? `${avg}d late` : `${Math.abs(avg)}d early`}
                            </div>
                          )}
                          <div className="flex gap-2 mt-1">
                            {party.lead?.email && (
                              <a href={`mailto:${party.lead.email}`} title={party.lead.email} className="text-muted-foreground hover:text-teal-700">
                                <Mail className="h-3.5 w-3.5" />
                              </a>
                            )}
                            {(party.lead?.mobile || party.lead?.phone) && (
                              <a href={`tel:${party.lead.mobile || party.lead.phone}`} title={party.lead.mobile || party.lead.phone} className="text-muted-foreground hover:text-teal-700">
                                <Phone className="h-3.5 w-3.5" />
                              </a>
                            )}
                          </div>
                        </td>
                        <td className="px-4 py-3">
                          {/* A GST invoice number can be present regardless of billing_mode —
                              gst_direct issues it directly, but proforma_first contracts get
                              one too once accounts uploads it via the Tally Inbox handoff. The
                              invoice number, once it exists, always wins over the proforma link. */}
                          {r.gst_invoice_number ? (
                            <Link href={`/api/billing-statements/${r.id}/gst-invoice-pdf`} target="_blank" className="text-teal-700 hover:underline font-mono text-xs flex items-center gap-1">
                              {r.gst_invoice_number}
                              <FileDown className="h-3 w-3" />
                            </Link>
                          ) : r.contract?.billing_mode === "gst_direct" ? (
                            <span className="font-mono text-xs text-muted-foreground">GST Pending</span>
                          ) : (
                            <Link href={`/api/billing-statements/${r.id}/proforma-pdf`} target="_blank" className="text-teal-700 hover:underline font-mono text-xs flex items-center gap-1">
                              {r.statement_number}
                              <FileDown className="h-3 w-3" />
                            </Link>
                          )}
                          <Badge variant="outline" className="text-[10px] mt-1 capitalize">{r.statement_type}</Badge>
                        </td>
                        <td className="px-4 py-3 text-xs whitespace-nowrap">
                          {formatDate(r.period_start)}<br />
                          <span className="text-muted-foreground">→ {formatDate(r.period_end)}</span>
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap">
                          <div>{r.due_date ? formatDate(r.due_date) : "—"}</div>
                          <div className="mt-1">{daysOverdueBadge(r.days_overdue)}</div>
                        </td>
                        <td className="px-4 py-3">
                          <BillingLifecycleStatus
                            status={r.status}
                            payment_status={r.payment_status}
                            proforma_sent_at={r.proforma_sent_at}
                            proforma_viewed_at={r.proforma_viewed_at}
                            gst_invoice_viewed_at={r.gst_invoice_viewed_at}
                            gst_invoice_number={r.gst_invoice_number}
                            pi_cancelled_at={r.pi_cancelled_at}
                            accounted={r.accounted}
                          />
                        </td>
                        <td className="px-4 py-3 text-right whitespace-nowrap">{formatCurrency(r.total_amount)}</td>
                        <td className="px-4 py-3 text-right whitespace-nowrap text-emerald-700">
                          {r.amount_paid > 0 ? formatCurrency(r.amount_paid) : "—"}
                        </td>
                        <td className="px-4 py-3 text-right whitespace-nowrap font-semibold text-teal-700">{formatCurrency(r.balance_due)}</td>
                        <td className="px-4 py-3 text-xs text-muted-foreground whitespace-nowrap">
                          {r.proforma_sent_at ? formatDate(r.proforma_sent_at) : "Never"}
                          {r.reminder_count > 0 && (
                            <div className="text-[10px] text-amber-700">+{r.reminder_count} reminder{r.reminder_count > 1 ? "s" : ""}</div>
                          )}
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap">
                          <div className="flex items-center gap-1 justify-end">
                            {canRecordPayment && (
                              <Button size="sm" variant="outline" onClick={() => openPayDialog(r)} title="Record offline payment">
                                <IndianRupee className="h-3.5 w-3.5 mr-1" /> Record
                              </Button>
                            )}
                            <Button size="sm" variant="ghost" onClick={() => sendReminder(r)} disabled={remindingId === r.id} title="Send next reminder now (bypasses 48h throttle)">
                              {remindingId === r.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Bell className="h-3.5 w-3.5" />}
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => openHistory(r)} title="View send history (reminders, proforma, GST invoice)">
                              <History className="h-3.5 w-3.5" />
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => openResendDialog(r)} title={isGstRoute(r) ? "Resend GST invoice" : "Resend proforma email"}>
                              <Send className="h-3.5 w-3.5" />
                            </Button>
                            {r.razorpay_payment_link_url && (
                              <a href={r.razorpay_payment_link_url} target="_blank" rel="noreferrer" className="p-1 text-muted-foreground hover:text-teal-700" title="Open Razorpay link">
                                <ExternalLink className="h-3.5 w-3.5" />
                              </a>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <OtherReceivablesCard
        rows={otherRows}
        summary={otherSummary}
        canRecordPayment={canRecordPayment}
        onRecorded={load}
      />

      <Dialog open={!!historyRow} onOpenChange={(o) => !o && setHistoryRow(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Send history — {historyRow?.statement_number}</DialogTitle>
          </DialogHeader>
          {historyLoading ? (
            <div className="p-6 text-center text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin inline mr-2" /> Loading…</div>
          ) : historyItems.length === 0 ? (
            <div className="p-6 text-center text-muted-foreground">Nothing sent yet for this statement.</div>
          ) : (
            <div className="max-h-[400px] overflow-y-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-xs uppercase text-gray-600 border-b sticky top-0">
                  <tr>
                    <th className="px-3 py-2 text-left">Sent</th>
                    <th className="px-3 py-2 text-left">Stage</th>
                    <th className="px-3 py-2 text-left">Channel</th>
                    <th className="px-3 py-2 text-left">Recipient</th>
                    <th className="px-3 py-2 text-left">Status</th>
                    <th className="px-3 py-2 text-left">By</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {historyItems.map((h) => (
                    <tr key={h.id}>
                      <td className="px-3 py-2 whitespace-nowrap text-xs">{new Date(h.sent_at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" })}</td>
                      <td className="px-3 py-2 text-xs">{h.stage_label}</td>
                      <td className="px-3 py-2 text-xs uppercase">{h.channel}</td>
                      <td className="px-3 py-2 text-xs">{h.recipient}</td>
                      <td className="px-3 py-2">
                        {h.status === "opened" ? (
                          <Badge className="bg-teal-100 text-teal-800 border-teal-300 text-[10px] flex items-center gap-1 w-fit">
                            <Eye className="h-2.5 w-2.5" /> OPENED
                          </Badge>
                        ) : h.status === "sent" ? (
                          <Badge className="bg-emerald-100 text-emerald-800 border-emerald-300 text-[10px]">SENT</Badge>
                        ) : (
                          <Badge className="bg-red-100 text-red-800 border-red-300 text-[10px]" title={h.error || ""}>FAILED</Badge>
                        )}
                      </td>
                      <td className="px-3 py-2 text-xs text-muted-foreground">
                        {h.triggered_by === "cron" ? "Cron" : (h.triggered_by_user?.full_name || "Manual")}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setHistoryRow(null)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!resendRow} onOpenChange={(o) => !o && setResendRow(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Resend {resendRow && isGstRoute(resendRow) ? "GST Invoice" : "Proforma"} — {resendRow?.statement_number}
            </DialogTitle>
          </DialogHeader>
          {resendRow && (
            <div className="space-y-3">
              <div className="text-sm text-muted-foreground">
                {partyOf(resendRow).number} · {customerName(partyOf(resendRow).lead)}<br />
                Amount: <strong className="text-teal-700">{formatCurrency(resendRow.total_amount)}</strong>
                {resendRow.gst_invoice_number && (
                  <><br />GST Invoice: <strong>{resendRow.gst_invoice_number}</strong></>
                )}
              </div>
              <div className="rounded-md bg-gray-50 p-3 space-y-1.5">
                <p className="text-xs font-medium text-muted-foreground">To</p>
                {candidateRecipients(partyOf(resendRow).lead).length === 0 ? (
                  <p className="text-sm text-red-600">No email on file for this contact</p>
                ) : (
                  candidateRecipients(partyOf(resendRow).lead).map((email) => (
                    <label key={email} className="flex items-center gap-2 cursor-pointer text-sm">
                      <input
                        type="checkbox"
                        checked={resendRecipients.has(email)}
                        onChange={() => toggleResendRecipient(email)}
                      />
                      <span className="font-medium">{email}</span>
                      {email === partyOf(resendRow).lead?.email && (
                        <Badge variant="outline" className="text-[10px]">Primary</Badge>
                      )}
                    </label>
                  ))
                )}
              </div>
              {/* Payment link renewal option — only for proforma statements with an existing link, and only for roles allowed to reissue payment links */}
              {canRecordPayment && !resendRow.gst_invoice_number && !!resendRow.razorpay_payment_link_url && (
                <div className="rounded-md border border-blue-200 bg-blue-50 p-3 space-y-2">
                  <p className="text-xs font-medium text-blue-800">Payment link</p>
                  <div className="flex flex-col gap-1.5">
                    <label className="flex items-start gap-2 cursor-pointer">
                      <input
                        type="radio"
                        className="mt-0.5"
                        checked={!resendNewLink}
                        onChange={() => setResendNewLink(false)}
                      />
                      <span className="text-sm text-blue-900">
                        <span className="font-medium">Keep existing link</span>
                        <span className="text-blue-600 text-xs block">Resend the same payment link already sent</span>
                      </span>
                    </label>
                    <label className="flex items-start gap-2 cursor-pointer">
                      <input
                        type="radio"
                        className="mt-0.5"
                        checked={resendNewLink}
                        onChange={() => setResendNewLink(true)}
                      />
                      <span className="text-sm text-blue-900">
                        <span className="font-medium">Generate fresh payment link</span>
                        <span className="text-blue-600 text-xs block">Cancel the old link · create a new 15-day link · resend invoice with new QR code</span>
                      </span>
                    </label>
                  </div>
                </div>
              )}
              <div>
                <Label>CC (optional)</Label>
                <Input
                  value={resendCc}
                  onChange={(e) => setResendCc(e.target.value)}
                  placeholder="e.g. accounts@company.com, manager@company.com"
                />
                <p className="text-xs text-muted-foreground mt-1">Separate multiple addresses with commas</p>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setResendRow(null)} disabled={resendSubmitting}>Cancel</Button>
            <Button onClick={submitResend} disabled={resendSubmitting || resendRecipients.size === 0}>
              {resendSubmitting
                ? <><Loader2 className="h-4 w-4 animate-spin mr-2" />Sending…</>
                : resendNewLink && !resendRow?.gst_invoice_number
                  ? <><RotateCcw className="h-4 w-4 mr-2" />Resend with New Link</>
                  : <><Send className="h-4 w-4 mr-2" />Send</>
              }
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <RecordPaymentDialog
        open={!!payRow}
        onOpenChange={(o) => !o && setPayRow(null)}
        statementId={payRow?.id ?? null}
        statementNumber={payRow?.statement_number}
        partyLabel={payRow ? `${partyOf(payRow).number} · ${customerName(partyOf(payRow).lead)}` : null}
        balanceDue={payRow?.balance_due ?? null}
        onSuccess={load}
      />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Other receivables — deposits, top-ups, ad-hoc PIs
// ─────────────────────────────────────────────────────────────────────────

interface OtherReceivableRow {
  id: string;
  kind: "deposit" | "topup" | "adhoc_invoice";
  reference: string;
  party_name: string;
  total_amount: number;
  balance_due: number;
  due_date: string | null;
  days_overdue: number | null;
  payment_link_url: string | null;
  is_stale: boolean;
  followup_enabled: boolean;
  reminder_count: number;
  href: string | null;
  parent_id?: string | null;
}

interface OtherSummary {
  total_outstanding: number;
  count: number;
  overdue: number;
  stale: number;
}

const OTHER_KIND_STYLE: Record<OtherReceivableRow["kind"], { label: string; cls: string }> = {
  deposit: { label: "Security deposit", cls: "border-violet-300 bg-violet-50 text-violet-700" },
  topup: { label: "Deposit top-up", cls: "border-purple-300 bg-purple-50 text-purple-700" },
  adhoc_invoice: { label: "Ad-hoc invoice", cls: "border-sky-300 bg-sky-50 text-sky-700" },
};

/**
 * Receivables that live outside billing_statements. Kept in their own card
 * rather than merged into the statement table — they have no GST invoice,
 * no proforma lifecycle and no partial payments, so most statement columns
 * would be empty for them.
 */
function OtherReceivablesCard({ rows, summary, canRecordPayment, onRecorded }: {
  rows: OtherReceivableRow[];
  summary: OtherSummary | null;
  canRecordPayment: boolean;
  onRecorded: () => void;
}) {
  const [payRow, setPayRow] = useState<OtherReceivableRow | null>(null);
  if (!summary || rows.length === 0) return null;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <CardTitle className="text-base">Deposits & ad-hoc invoices</CardTitle>
            <p className="text-xs text-muted-foreground mt-1">
              Security deposits, top-ups and ad-hoc invoices awaiting payment.
            </p>
          </div>
          <div className="flex items-center gap-4 text-sm">
            <div className="text-right">
              <p className="text-xs text-muted-foreground">Outstanding</p>
              <p className="font-bold text-teal-700">{formatCurrency(summary.total_outstanding)}</p>
            </div>
            <div className="text-right">
              <p className="text-xs text-muted-foreground">Overdue</p>
              <p className="font-bold text-orange-700">{summary.overdue}</p>
            </div>
            {summary.stale > 0 && (
              <div className="text-right">
                <p className="text-xs text-muted-foreground">Stale</p>
                <p className="font-bold text-red-700">{summary.stale}</p>
              </div>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-xs uppercase text-gray-600 border-b">
              <tr>
                <th className="px-4 py-2 text-left">Reference</th>
                <th className="px-4 py-2 text-left">Customer</th>
                <th className="px-4 py-2 text-left">Due</th>
                <th className="px-4 py-2 text-right">Amount</th>
                <th className="px-4 py-2 text-left">Follow-up</th>
                <th className="px-4 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const style = OTHER_KIND_STYLE[r.kind];
                return (
                  <tr key={`${r.kind}-${r.id}`} className="border-b last:border-0 hover:bg-gray-50">
                    <td className="px-4 py-3 whitespace-nowrap">
                      <div className="flex items-center gap-2">
                        {r.href
                          ? <Link href={r.href} className="font-medium text-teal-700 hover:underline">{r.reference}</Link>
                          : <span className="font-medium">{r.reference}</span>}
                        {r.is_stale && (
                          <Badge className="bg-red-100 text-red-800 border-red-300" title="Overdue more than 90 days — review or cancel">
                            Stale
                          </Badge>
                        )}
                      </div>
                      <Badge variant="outline" className={`text-[10px] mt-1 ${style.cls}`}>{style.label}</Badge>
                    </td>
                    <td className="px-4 py-3">{r.party_name}</td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      <div>{r.due_date ? formatDate(r.due_date) : "—"}</div>
                      <div className="mt-1">{daysOverdueBadge(r.days_overdue)}</div>
                    </td>
                    <td className="px-4 py-3 text-right whitespace-nowrap font-semibold text-teal-700">
                      {formatCurrency(r.balance_due)}
                    </td>
                    <td className="px-4 py-3 text-xs whitespace-nowrap">
                      {!r.followup_enabled ? (
                        <span className="text-muted-foreground" title="Predates automated follow-up — chase manually">
                          Manual only
                        </span>
                      ) : r.reminder_count > 0 ? (
                        <span className="text-amber-700">{r.reminder_count} sent</span>
                      ) : (
                        <span className="text-muted-foreground">Not started</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right whitespace-nowrap">
                      <div className="flex items-center gap-1 justify-end">
                        {canRecordPayment && (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => setPayRow(r)}
                            title="Record a payment received offline"
                          >
                            <IndianRupee className="h-3.5 w-3.5 mr-1" /> Record
                          </Button>
                        )}
                        {r.payment_link_url && (
                          <a
                            href={r.payment_link_url}
                            target="_blank"
                            rel="noreferrer"
                            className="p-1 text-muted-foreground hover:text-teal-700 inline-block"
                            title="Open payment link"
                          >
                            <ExternalLink className="h-3.5 w-3.5" />
                          </a>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </CardContent>

      {payRow && (
        <RecordOtherPaymentDialog
          row={payRow}
          onClose={() => setPayRow(null)}
          onDone={() => { setPayRow(null); onRecorded(); }}
        />
      )}
    </Card>
  );
}

const PAYMENT_MODES = ["bank_transfer", "upi", "cheque", "cash", "card", "other"];

/**
 * Records an offline payment against a deposit, top-up or ad-hoc invoice.
 * Each kind already has its own settle endpoint with its own side effects
 * (deposit gates contract activation; a shortfall-linked top-up decrements
 * contracts.deposit_shortfall; a paid PI spawns a billing statement), so
 * this dispatches to those rather than writing any status directly.
 */
function RecordOtherPaymentDialog({ row, onClose, onDone }: {
  row: OtherReceivableRow;
  onClose: () => void;
  onDone: () => void;
}) {
  const [amount, setAmount] = useState(String(row.balance_due));
  const [mode, setMode] = useState("bank_transfer");
  const [reference, setReference] = useState("");
  const [notes, setNotes] = useState("");
  const [proof, setProof] = useState<File | null>(null);
  const [shortfallApproved, setShortfallApproved] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const kindLabel = OTHER_KIND_STYLE[row.kind].label;
  // A deposit recorded below the required amount needs explicit sign-off
  // (and the server rejects anything more than 10% short outright).
  const shortfall = row.balance_due - (parseFloat(amount) || 0);
  const needsShortfallApproval = row.kind === "deposit" && shortfall > 0;
  // The top-up settle endpoint closes out a fixed pending amount, so the
  // figure isn't the operator's to change there.
  const amountEditable = row.kind !== "topup";

  async function submit() {
    const amt = parseFloat(amount);
    if (amountEditable && (!amt || amt <= 0)) {
      toast.error("Enter a valid amount");
      return;
    }
    setSubmitting(true);
    try {
      let res: Response;
      if (row.kind === "deposit") {
        const fd = new FormData();
        fd.append("amount", String(amt));
        fd.append("payment_medium", mode);
        if (reference) fd.append("reference", reference);
        if (notes) fd.append("notes", notes);
        if (proof) fd.append("payment_proof", proof);
        if (shortfallApproved) fd.append("shortfall_approved", "true");
        res = await fetch(`/api/proposals/${row.id}/deposit-payment`, { method: "POST", body: fd });
      } else if (row.kind === "topup") {
        if (!row.parent_id) throw new Error("Top-up is missing its contract reference");
        const fd = new FormData();
        fd.append("payment_mode", mode);
        if (reference) fd.append("payment_reference", reference);
        if (proof) fd.append("proof", proof);
        res = await fetch(
          `/api/contracts/${row.parent_id}/deposit-topup/${row.id}/record-payment`,
          { method: "POST", body: fd },
        );
      } else {
        res = await fetch(`/api/invoices/${row.id}/payment`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ amount: amt, reference, notes }),
        });
      }

      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Could not record the payment");
      toast.success("Payment recorded");
      onDone();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not record the payment");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Record payment — {row.reference}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            {kindLabel} · {row.party_name} · outstanding {formatCurrency(row.balance_due)}
          </p>

          <div>
            <Label>Amount received</Label>
            <Input
              type="number"
              value={amount}
              disabled={!amountEditable}
              onChange={(e) => setAmount(e.target.value)}
            />
            {!amountEditable && (
              <p className="text-xs text-muted-foreground mt-1">
                A top-up settles for its full pending amount.
              </p>
            )}
          </div>

          <div>
            <Label>Payment mode</Label>
            <select
              value={mode}
              onChange={(e) => setMode(e.target.value)}
              className="w-full border rounded-md h-9 px-2 text-sm"
            >
              {PAYMENT_MODES.map((m) => (
                <option key={m} value={m}>{m.replace(/_/g, " ")}</option>
              ))}
            </select>
          </div>

          <div>
            <Label>Reference / UTR</Label>
            <Input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="optional" />
          </div>

          {row.kind !== "topup" && (
            <div>
              <Label>Notes</Label>
              <Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="optional" />
            </div>
          )}

          {needsShortfallApproval && (
            <label className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-2.5 text-xs text-amber-900">
              <input
                type="checkbox"
                checked={shortfallApproved}
                onChange={(e) => setShortfallApproved(e.target.checked)}
                className="mt-0.5"
              />
              <span>
                Approve a shortfall of {formatCurrency(shortfall)} against the required deposit.
                Admin or manager only; anything more than 10% short is rejected.
              </span>
            </label>
          )}

          {row.kind !== "adhoc_invoice" && (
            <div>
              <Label>Payment proof (optional)</Label>
              <input
                type="file"
                accept="application/pdf,image/*"
                onChange={(e) => setProof(e.target.files?.[0] || null)}
                className="block w-full text-sm border rounded-md p-2"
              />
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={submitting}>Cancel</Button>
          <Button onClick={submit} disabled={submitting}>
            {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : "Record Payment"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
