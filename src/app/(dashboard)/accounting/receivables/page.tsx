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
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Loader2, IndianRupee, Mail, Phone, ExternalLink, Send, FileDown, Search, Bell, History, Download, LayoutList, BarChart2, Eye, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { formatCurrency, formatDate } from "@/lib/utils";
import { BillingLifecycleStatus } from "@/components/billing/billing-lifecycle-status";

interface Lead {
  id: string;
  first_name?: string;
  last_name?: string;
  company?: string;
  email?: string;
  phone?: string;
  mobile?: string;
}

interface Contract {
  id: string;
  contract_number: string;
  title?: string;
  lead?: Lead;
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
  contract: Contract;
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
  const [avgDays, setAvgDays] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<FilterKey>("all");
  const [search, setSearch] = useState("");
  const [viewMode, setViewMode] = useState<ViewMode>("detail");

  // Record-payment dialog state
  const [payRow, setPayRow] = useState<ReceivableRow | null>(null);
  const [payAmount, setPayAmount] = useState("");
  const [payDate, setPayDate] = useState(new Date().toISOString().slice(0, 10));
  const [payMode, setPayMode] = useState("bank_transfer");
  const [payRef, setPayRef] = useState("");
  const [payNotes, setPayNotes] = useState("");
  const [paySubmitting, setPaySubmitting] = useState(false);
  const [resending, setResending] = useState<string | null>(null);
  const [remindingId, setRemindingId] = useState<string | null>(null);

  // Resend dialog state
  const [resendRow, setResendRow] = useState<ReceivableRow | null>(null);
  const [resendCc, setResendCc] = useState("");
  const [resendSubmitting, setResendSubmitting] = useState(false);
  const [resendNewLink, setResendNewLink] = useState(false);

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
      setAvgDays(json.avgDays || {});
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to load receivables");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const filtered = useMemo(() => {
    let r = rows;
    if (filter === "due_soon")   r = r.filter((x) => x.days_overdue !== null && x.days_overdue >= -7 && x.days_overdue < 0);
    if (filter === "overdue")    r = r.filter((x) => x.days_overdue !== null && x.days_overdue >= 0);
    if (filter === "overdue_30") r = r.filter((x) => x.days_overdue !== null && x.days_overdue >= 30);
    if (filter === "partial")    r = r.filter((x) => x.payment_status === "partially_paid");

    if (search.trim()) {
      const q = search.toLowerCase();
      r = r.filter((x) =>
        x.contract.contract_number?.toLowerCase().includes(q) ||
        x.statement_number?.toLowerCase().includes(q) ||
        customerName(x.contract.lead).toLowerCase().includes(q),
      );
    }
    return r;
  }, [rows, filter, search]);

  // ── Ageing view: group filtered statements by contract ───────────────────
  const agingRows = useMemo((): AgingRow[] => {
    const byContract = new Map<string, AgingRow>();
    for (const r of filtered) {
      const key = r.contract.id;
      if (!byContract.has(key)) {
        byContract.set(key, {
          contractId: r.contract.id,
          contractNumber: r.contract.contract_number,
          customerName: customerName(r.contract.lead),
          lead: r.contract.lead,
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

  const openPayDialog = (row: ReceivableRow) => {
    setPayRow(row);
    setPayAmount(String(row.balance_due));
    setPayDate(new Date().toISOString().slice(0, 10));
    setPayMode("bank_transfer");
    setPayRef("");
    setPayNotes("");
  };

  const submitPayment = async () => {
    if (!payRow) return;
    const amt = parseFloat(payAmount);
    if (!amt || amt <= 0) { toast.error("Enter a valid amount"); return; }
    setPaySubmitting(true);
    try {
      const res = await fetch(`/api/billing-statements/${payRow.id}/payment`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          amount: amt,
          payment_date: payDate,
          payment_mode: payMode,
          payment_reference: payRef || null,
          notes: payNotes || null,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed");
      toast.success(`Payment recorded — ${json.payment_status === "paid" ? "fully paid" : `balance ₹${json.balance_due}`}`);
      setPayRow(null);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to record payment");
    } finally {
      setPaySubmitting(false);
    }
  };

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
  };

  const submitResend = async () => {
    if (!resendRow) return;
    setResendSubmitting(true);
    const ccList = resendCc.split(/[,;\s]+/).map(s => s.trim()).filter(Boolean);
    const hasGst = !!resendRow.gst_invoice_number;

    // New-link path: cancel old link, create fresh one, resend invoice
    if (!hasGst && resendNewLink) {
      try {
        const res = await fetch(`/api/billing-statements/${resendRow.id}/reissue-payment-link`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cc: ccList.length > 0 ? ccList : undefined }),
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
        body: JSON.stringify({ cc: ccList.length > 0 ? ccList : undefined }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed");
      const sentTo = json.emailedTo || json.emailed_to || "";
      toast.success(`${hasGst ? "GST invoice" : "Proforma"} resent${sentTo ? ` to ${sentTo}` : ""}${ccList.length > 0 ? ` (CC: ${ccList.join(", ")})` : ""}`);
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
                            <Link href={`/contracts/${r.contractId}`} className="text-teal-700 hover:underline">
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
                    const avg = avgDays[r.contract.id];
                    return (
                      <tr key={r.id} className="hover:bg-gray-50">
                        <td className="px-4 py-3">
                          <div className="font-medium">
                            <Link href={`/contracts/${r.contract.id}`} className="text-teal-700 hover:underline">
                              {r.contract.contract_number}
                            </Link>
                          </div>
                          <div className="text-xs text-muted-foreground">{customerName(r.contract.lead)}</div>
                          {avg !== undefined && (
                            <div className={`text-[10px] mt-0.5 font-medium ${avg > 0 ? "text-red-600" : "text-emerald-600"}`}>
                              avg {avg > 0 ? `${avg}d late` : `${Math.abs(avg)}d early`}
                            </div>
                          )}
                          <div className="flex gap-2 mt-1">
                            {r.contract.lead?.email && (
                              <a href={`mailto:${r.contract.lead.email}`} title={r.contract.lead.email} className="text-muted-foreground hover:text-teal-700">
                                <Mail className="h-3.5 w-3.5" />
                              </a>
                            )}
                            {(r.contract.lead?.mobile || r.contract.lead?.phone) && (
                              <a href={`tel:${r.contract.lead.mobile || r.contract.lead.phone}`} title={r.contract.lead.mobile || r.contract.lead.phone} className="text-muted-foreground hover:text-teal-700">
                                <Phone className="h-3.5 w-3.5" />
                              </a>
                            )}
                          </div>
                        </td>
                        <td className="px-4 py-3">
                          <Link href={`/api/billing-statements/${r.id}/proforma-pdf`} target="_blank" className="text-teal-700 hover:underline font-mono text-xs flex items-center gap-1">
                            {r.statement_number}
                            <FileDown className="h-3 w-3" />
                          </Link>
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
                            <Button size="sm" variant="outline" onClick={() => openPayDialog(r)} title="Record offline payment">
                              <IndianRupee className="h-3.5 w-3.5 mr-1" /> Record
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => sendReminder(r)} disabled={remindingId === r.id} title="Send next reminder now (bypasses 48h throttle)">
                              {remindingId === r.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Bell className="h-3.5 w-3.5" />}
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => openHistory(r)} title="View reminder history">
                              <History className="h-3.5 w-3.5" />
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => openResendDialog(r)} title={r.gst_invoice_number ? "Resend GST invoice" : "Resend proforma email"}>
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

      <Dialog open={!!historyRow} onOpenChange={(o) => !o && setHistoryRow(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Reminder history — {historyRow?.statement_number}</DialogTitle>
          </DialogHeader>
          {historyLoading ? (
            <div className="p-6 text-center text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin inline mr-2" /> Loading…</div>
          ) : historyItems.length === 0 ? (
            <div className="p-6 text-center text-muted-foreground">No reminders sent yet for this statement.</div>
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
              Resend {resendRow?.gst_invoice_number ? "GST Invoice" : "Proforma"} — {resendRow?.statement_number}
            </DialogTitle>
          </DialogHeader>
          {resendRow && (
            <div className="space-y-3">
              <div className="text-sm text-muted-foreground">
                {resendRow.contract.contract_number} · {customerName(resendRow.contract.lead)}<br />
                Amount: <strong className="text-teal-700">{formatCurrency(resendRow.total_amount)}</strong>
                {resendRow.gst_invoice_number && (
                  <><br />GST Invoice: <strong>{resendRow.gst_invoice_number}</strong></>
                )}
              </div>
              <div className="rounded-md bg-gray-50 p-3 text-sm">
                <span className="text-muted-foreground">To: </span>
                <span className="font-medium">{resendRow.contract.lead?.email || "No email on file"}</span>
              </div>
              {/* Payment link renewal option — only for proforma statements with an existing link */}
              {!resendRow.gst_invoice_number && !!resendRow.razorpay_payment_link_url && (
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
            <Button onClick={submitResend} disabled={resendSubmitting || !resendRow?.contract.lead?.email}>
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

      <Dialog open={!!payRow} onOpenChange={(o) => !o && setPayRow(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>Record Payment — {payRow?.statement_number}</DialogTitle></DialogHeader>
          {payRow && (
            <div className="space-y-3">
              <div className="text-sm text-muted-foreground">
                {payRow.contract.contract_number} · {customerName(payRow.contract.lead)}<br />
                Balance due: <strong className="text-teal-700">{formatCurrency(payRow.balance_due)}</strong>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>Amount (₹)</Label>
                  <Input type="number" value={payAmount} onChange={(e) => setPayAmount(e.target.value)} />
                </div>
                <div>
                  <Label>Payment date</Label>
                  <Input type="date" value={payDate} onChange={(e) => setPayDate(e.target.value)} />
                </div>
              </div>
              <div>
                <Label>Payment mode</Label>
                <Select value={payMode} onValueChange={setPayMode}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="bank_transfer">Bank transfer / NEFT / RTGS</SelectItem>
                    <SelectItem value="upi">UPI</SelectItem>
                    <SelectItem value="cheque">Cheque</SelectItem>
                    <SelectItem value="cash">Cash</SelectItem>
                    <SelectItem value="razorpay">Razorpay (manually reconciled)</SelectItem>
                    <SelectItem value="other">Other</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Reference (UTR / cheque # / txn id)</Label>
                <Input value={payRef} onChange={(e) => setPayRef(e.target.value)} placeholder="optional" />
              </div>
              <div>
                <Label>Notes</Label>
                <Input value={payNotes} onChange={(e) => setPayNotes(e.target.value)} placeholder="optional" />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setPayRow(null)} disabled={paySubmitting}>Cancel</Button>
            <Button onClick={submitPayment} disabled={paySubmitting}>
              {paySubmitting ? <><Loader2 className="h-4 w-4 animate-spin mr-2" />Recording…</> : "Record payment"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
