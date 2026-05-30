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
import { Loader2, IndianRupee, Mail, Phone, ExternalLink, Send, FileDown, Search } from "lucide-react";
import { toast } from "sonner";
import { formatCurrency, formatDate } from "@/lib/utils";

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
  razorpay_payment_link_url: string | null;
  last_reminder_sent_at: string | null;
  reminder_count: number;
  days_overdue: number | null;
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
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<FilterKey>("all");
  const [search, setSearch] = useState("");

  // Record-payment dialog state
  const [payRow, setPayRow] = useState<ReceivableRow | null>(null);
  const [payAmount, setPayAmount] = useState("");
  const [payDate, setPayDate] = useState(new Date().toISOString().slice(0, 10));
  const [payMode, setPayMode] = useState("bank_transfer");
  const [payRef, setPayRef] = useState("");
  const [payNotes, setPayNotes] = useState("");
  const [paySubmitting, setPaySubmitting] = useState(false);
  const [resending, setResending] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/accounting/receivables");
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to load");
      setRows(json.rows || []);
      setSummary(json.summary || null);
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

  const resendProforma = async (row: ReceivableRow) => {
    setResending(row.id);
    try {
      const res = await fetch(`/api/billing-statements/${row.id}/send-proforma`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed");
      toast.success(`Proforma resent${json.emailedTo ? ` to ${json.emailedTo}` : ""}`);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to resend");
    } finally {
      setResending(null);
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
        <div className="ml-auto relative">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search contract, statement #, customer"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-8 w-72"
          />
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
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-xs uppercase text-gray-600 border-b">
                  <tr>
                    <th className="px-4 py-3 text-left">Contract / Customer</th>
                    <th className="px-4 py-3 text-left">Statement</th>
                    <th className="px-4 py-3 text-left">Period</th>
                    <th className="px-4 py-3 text-left">Due</th>
                    <th className="px-4 py-3 text-right">Total</th>
                    <th className="px-4 py-3 text-right">Paid</th>
                    <th className="px-4 py-3 text-right">Balance</th>
                    <th className="px-4 py-3 text-left">Last sent</th>
                    <th className="px-4 py-3"></th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {filtered.map((r) => (
                    <tr key={r.id} className="hover:bg-gray-50">
                      <td className="px-4 py-3">
                        <div className="font-medium">
                          <Link href={`/contracts/${r.contract.id}`} className="text-teal-700 hover:underline">
                            {r.contract.contract_number}
                          </Link>
                        </div>
                        <div className="text-xs text-muted-foreground">{customerName(r.contract.lead)}</div>
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
                          <Button size="sm" variant="ghost" onClick={() => resendProforma(r)} disabled={resending === r.id} title="Resend proforma email">
                            {resending === r.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
                          </Button>
                          {r.razorpay_payment_link_url && (
                            <a href={r.razorpay_payment_link_url} target="_blank" rel="noreferrer" className="p-1 text-muted-foreground hover:text-teal-700" title="Open Razorpay link">
                              <ExternalLink className="h-3.5 w-3.5" />
                            </a>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

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
