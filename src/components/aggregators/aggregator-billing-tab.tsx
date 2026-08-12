"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Plus, Loader2, AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import {
  CASE_STATUS_LABELS,
  CASE_STATUS_COLORS,
  VO_PURPOSE_LABELS,
} from "@/lib/constants";
import { formatCurrency, formatDate } from "@/lib/utils";
import Link from "next/link";
import { AggInvoiceLifecyclePill } from "@/components/aggregators/agg-invoice-lifecycle-pill";
import type { AggregatorInvoice, VoCase } from "@/types";

const MONTH_LABELS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const BILLABLE_CASE_STATUSES = ["active", "renewal_due", "invoiced", "executed"];
const UNPAID_INVOICE_STATUSES = ["draft", "sent", "overdue"];

interface AggregatorBillingTabProps {
  aggregatorId: string;
  creditLimit?: number;
  primaryEmail?: string;
}

export function AggregatorBillingTab({ aggregatorId, creditLimit, primaryEmail }: AggregatorBillingTabProps) {
  const [invoices, setInvoices] = useState<AggregatorInvoice[]>([]);
  const [cases, setCases] = useState<VoCase[]>([]);
  const [eligibleCaseCount, setEligibleCaseCount] = useState(0);
  const [eligibleCasesSum, setEligibleCasesSum] = useState(0);
  const [loading, setLoading] = useState(true);

  const now = new Date();
  const currentMonth = now.getMonth() + 1;
  const currentYear = now.getFullYear();

  const [generateOpen, setGenerateOpen] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [genMonth, setGenMonth] = useState(String(currentMonth));
  const [genYear, setGenYear] = useState(String(currentYear));

  const [sendFor, setSendFor] = useState<AggregatorInvoice | null>(null);
  const [sendEmail, setSendEmail] = useState("");
  const [payFor, setPayFor] = useState<AggregatorInvoice | null>(null);
  const [payReference, setPayReference] = useState("");
  const [actioning, setActioning] = useState(false);

  // Billable-and-unbilled cases are selected for the next invoice by
  // default ("bill all") — unchecking one carves it out as an exception.
  const [selectedCaseIds, setSelectedCaseIds] = useState<Set<string>>(new Set());

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const [invRes, caseRes] = await Promise.all([
        fetch(`/api/aggregator-invoices?aggregator_id=${aggregatorId}&limit=50`),
        fetch(`/api/cases?aggregator_id=${aggregatorId}&limit=100`),
      ]);

      if (invRes.ok) {
        const json = await invRes.json();
        setInvoices(json.data || []);
      }

      if (caseRes.ok) {
        const json = await caseRes.json();
        const allCases = (json.data || []) as VoCase[];
        setCases(allCases);
        const eligible = allCases.filter((c) => BILLABLE_CASE_STATUSES.includes(c.status));
        setEligibleCaseCount(eligible.length);
        setEligibleCasesSum(eligible.reduce((sum, c) => sum + (c.rate || 0), 0));
      }
    } finally {
      setLoading(false);
    }
  }, [aggregatorId]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const currentPeriodInvoice = invoices.find(
    (i) => i.period_month === currentMonth && i.period_year === currentYear && i.status !== "cancelled"
  );

  const outstanding = useMemo(() => {
    const unpaidTotal = invoices
      .filter((i) => UNPAID_INVOICE_STATUSES.includes(i.status))
      .reduce((sum, i) => sum + i.total_amount, 0);
    return unpaidTotal + (currentPeriodInvoice ? 0 : eligibleCasesSum);
  }, [invoices, currentPeriodInvoice, eligibleCasesSum]);

  const overLimit = creditLimit != null && creditLimit > 0 && outstanding >= creditLimit;

  // A case is "billed" once it appears in a non-cancelled invoice's line
  // items — cancelling an invoice puts its cases back into the unbilled pool.
  const billedByCase = useMemo(() => {
    const map = new Map<string, { invoice: AggregatorInvoice; amount: number }>();
    for (const inv of invoices) {
      if (inv.status === "cancelled") continue;
      for (const item of inv.items) {
        map.set(item.case_id, { invoice: inv, amount: item.amount });
      }
    }
    return map;
  }, [invoices]);

  const { billedCases, unbilledBillableCases, unbilledNotYetBillableCases } = useMemo(() => {
    const billed: { case: VoCase; invoice: AggregatorInvoice; amount: number }[] = [];
    const unbilledBillable: VoCase[] = [];
    const unbilledNotYetBillable: VoCase[] = [];
    for (const c of cases) {
      const entry = billedByCase.get(c.id);
      if (entry) {
        billed.push({ case: c, invoice: entry.invoice, amount: entry.amount });
      } else if (BILLABLE_CASE_STATUSES.includes(c.status)) {
        unbilledBillable.push(c);
      } else {
        unbilledNotYetBillable.push(c);
      }
    }
    return { billedCases: billed, unbilledBillableCases: unbilledBillable, unbilledNotYetBillableCases: unbilledNotYetBillable };
  }, [cases, billedByCase]);

  // Default selection = "bill all": every billable-and-unbilled case starts
  // checked. Re-syncs whenever the underlying set changes (fetch, invoice
  // generated/cancelled) — a user's in-progress exclusions on THIS set are
  // preserved across renders that don't change the set itself.
  useEffect(() => {
    setSelectedCaseIds(new Set(unbilledBillableCases.map((c) => c.id)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unbilledBillableCases.map((c) => c.id).join(",")]);

  const toggleCase = (caseId: string, checked: boolean) => {
    setSelectedCaseIds((prev) => {
      const next = new Set(prev);
      if (checked) next.add(caseId);
      else next.delete(caseId);
      return next;
    });
  };

  const toggleAll = (checked: boolean) => {
    setSelectedCaseIds(checked ? new Set(unbilledBillableCases.map((c) => c.id)) : new Set());
  };

  const allSelected = unbilledBillableCases.length > 0 && selectedCaseIds.size === unbilledBillableCases.length;
  const selectedSum = unbilledBillableCases
    .filter((c) => selectedCaseIds.has(c.id))
    .reduce((sum, c) => sum + (c.rate || 0), 0);

  const handleGenerate = async () => {
    if (selectedCaseIds.size === 0) {
      toast.error("Select at least one case to invoice.");
      return;
    }
    setGenerating(true);
    try {
      const res = await fetch("/api/aggregator-invoices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          aggregator_id: aggregatorId,
          period_month: parseInt(genMonth),
          period_year: parseInt(genYear),
          case_ids: Array.from(selectedCaseIds),
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to generate invoice");
      }
      toast.success("Invoice generated");
      setGenerateOpen(false);
      fetchData();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to generate invoice");
    } finally {
      setGenerating(false);
    }
  };

  const runAction = async (invoiceId: string, body: Record<string, unknown>, successMessage: string) => {
    setActioning(true);
    try {
      const res = await fetch(`/api/aggregator-invoices/${invoiceId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Action failed");
      }
      toast.success(successMessage);
      setSendFor(null);
      setPayFor(null);
      fetchData();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Action failed");
    } finally {
      setActioning(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="rounded-md border p-4">
          <p className="text-xs text-muted-foreground">Outstanding (unpaid + this month&apos;s estimate)</p>
          <p className="text-2xl font-semibold mt-1">{formatCurrency(outstanding)}</p>
          {overLimit && (
            <div className="flex items-center gap-1.5 text-xs text-amber-700 mt-2">
              <AlertTriangle className="h-3.5 w-3.5" />
              Over credit limit ({formatCurrency(creditLimit!)})
            </div>
          )}
        </div>
        <div className="rounded-md border p-4">
          <p className="text-xs text-muted-foreground">
            {MONTH_LABELS[currentMonth - 1]} {currentYear}
          </p>
          {currentPeriodInvoice ? (
            <p className="text-sm mt-1">
              Invoiced: <span className="font-medium">{currentPeriodInvoice.invoice_number}</span>
            </p>
          ) : (
            <p className="text-sm mt-1 text-muted-foreground">
              {eligibleCaseCount} billable case(s), not yet invoiced this month
            </p>
          )}
        </div>
      </div>

      {/* Unbilled referrals */}
      <div className="space-y-2">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <h3 className="text-sm font-medium">
            Unbilled Referrals ({unbilledBillableCases.length + unbilledNotYetBillableCases.length})
          </h3>
          <Button size="sm" onClick={() => setGenerateOpen(true)} disabled={selectedCaseIds.size === 0}>
            <Plus className="mr-2 h-4 w-4" />
            Generate Invoice ({selectedCaseIds.size} selected)
          </Button>
        </div>

        {loading ? (
          <div className="text-center py-6 text-muted-foreground text-sm">Loading...</div>
        ) : unbilledBillableCases.length === 0 && unbilledNotYetBillableCases.length === 0 ? (
          <div className="text-center py-6 text-muted-foreground text-sm rounded-md border">
            No unbilled referrals — everything billable has been invoiced.
          </div>
        ) : (
          <div className="rounded-md border overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/50">
                  <th className="px-4 py-3 text-left w-10">
                    {unbilledBillableCases.length > 0 && (
                      <Checkbox checked={allSelected} onCheckedChange={(c) => toggleAll(!!c)} aria-label="Select all billable cases" />
                    )}
                  </th>
                  <th className="px-4 py-3 text-left font-medium">Case #</th>
                  <th className="px-4 py-3 text-left font-medium">Client</th>
                  <th className="px-4 py-3 text-left font-medium">Purpose</th>
                  <th className="px-4 py-3 text-left font-medium">Status</th>
                  <th className="px-4 py-3 text-right font-medium">Rate</th>
                </tr>
              </thead>
              <tbody>
                {unbilledBillableCases.map((c) => (
                  <tr key={c.id} className="border-b">
                    <td className="px-4 py-3">
                      <Checkbox
                        checked={selectedCaseIds.has(c.id)}
                        onCheckedChange={(checked) => toggleCase(c.id, !!checked)}
                        aria-label={`Include ${c.case_number}`}
                      />
                    </td>
                    <td className="px-4 py-3">
                      <Link href={`/cases/${c.id}`} className="text-primary hover:underline">{c.case_number}</Link>
                    </td>
                    <td className="px-4 py-3">{c.client_company_name || c.client_name}</td>
                    <td className="px-4 py-3 text-muted-foreground">{VO_PURPOSE_LABELS[c.purpose] || c.purpose}</td>
                    <td className="px-4 py-3">
                      <Badge className={CASE_STATUS_COLORS[c.status]}>{CASE_STATUS_LABELS[c.status] || c.status}</Badge>
                    </td>
                    <td className="px-4 py-3 text-right">{formatCurrency(c.rate || 0)}</td>
                  </tr>
                ))}
                {unbilledNotYetBillableCases.map((c) => (
                  <tr key={c.id} className="border-b text-muted-foreground">
                    <td className="px-4 py-3" />
                    <td className="px-4 py-3">
                      <Link href={`/cases/${c.id}`} className="hover:underline">{c.case_number}</Link>
                    </td>
                    <td className="px-4 py-3">{c.client_company_name || c.client_name}</td>
                    <td className="px-4 py-3">{VO_PURPOSE_LABELS[c.purpose] || c.purpose}</td>
                    <td className="px-4 py-3">
                      <Badge variant="outline" title="Not yet in a billable status">{CASE_STATUS_LABELS[c.status] || c.status}</Badge>
                    </td>
                    <td className="px-4 py-3 text-right">{c.rate ? formatCurrency(c.rate) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {selectedCaseIds.size > 0 && (
          <p className="text-xs text-muted-foreground text-right">Selected total: {formatCurrency(selectedSum)}</p>
        )}
      </div>

      {/* Billed referrals */}
      <div className="space-y-2">
        <h3 className="text-sm font-medium">Billed Referrals ({billedCases.length})</h3>
        {billedCases.length === 0 ? (
          <div className="text-center py-6 text-muted-foreground text-sm rounded-md border">No referrals billed yet.</div>
        ) : (
          <div className="rounded-md border overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/50">
                  <th className="px-4 py-3 text-left font-medium">Case #</th>
                  <th className="px-4 py-3 text-left font-medium">Client</th>
                  <th className="px-4 py-3 text-left font-medium">Purpose</th>
                  <th className="px-4 py-3 text-right font-medium">Amount</th>
                  <th className="px-4 py-3 text-left font-medium">Invoice #</th>
                  <th className="px-4 py-3 text-left font-medium">Lifecycle</th>
                  <th className="px-4 py-3 text-left font-medium">Paid</th>
                </tr>
              </thead>
              <tbody>
                {billedCases.map(({ case: c, invoice, amount }) => (
                  <tr key={c.id} className="border-b">
                    <td className="px-4 py-3">
                      <Link href={`/cases/${c.id}`} className="text-primary hover:underline">{c.case_number}</Link>
                    </td>
                    <td className="px-4 py-3">{c.client_company_name || c.client_name}</td>
                    <td className="px-4 py-3 text-muted-foreground">{VO_PURPOSE_LABELS[c.purpose] || c.purpose}</td>
                    <td className="px-4 py-3 text-right">{formatCurrency(amount)}</td>
                    <td className="px-4 py-3 font-medium">{invoice.invoice_number}</td>
                    <td className="px-4 py-3">
                      <AggInvoiceLifecyclePill status={invoice.status} />
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">{invoice.paid_at ? formatDate(invoice.paid_at) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-muted-foreground">{invoices.length} invoice(s) — invoice history</h3>
      </div>

      {loading ? (
        <div className="text-center py-8 text-muted-foreground text-sm">Loading...</div>
      ) : invoices.length === 0 ? (
        <div className="text-center py-8 text-muted-foreground text-sm">No invoices generated yet.</div>
      ) : (
        <div className="rounded-md border overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/50">
                <th className="px-4 py-3 text-left font-medium">Invoice #</th>
                <th className="px-4 py-3 text-left font-medium">Period</th>
                <th className="px-4 py-3 text-left font-medium">Status</th>
                <th className="px-4 py-3 text-left font-medium">Total</th>
                <th className="px-4 py-3 text-left font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {invoices.map((inv) => (
                <tr key={inv.id} className="border-b">
                  <td className="px-4 py-3 font-medium">{inv.invoice_number}</td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {MONTH_LABELS[inv.period_month - 1]} {inv.period_year}
                  </td>
                  <td className="px-4 py-3">
                    <AggInvoiceLifecyclePill status={inv.status} />
                  </td>
                  <td className="px-4 py-3 font-medium">{formatCurrency(inv.total_amount)}</td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-2">
                      {inv.status === "draft" && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            setSendFor(inv);
                            setSendEmail(inv.sent_to || primaryEmail || "");
                          }}
                        >
                          Send
                        </Button>
                      )}
                      {(inv.status === "sent" || inv.status === "overdue") && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            setPayFor(inv);
                            setPayReference(inv.payment_reference || "");
                          }}
                        >
                          Mark Paid
                        </Button>
                      )}
                      {inv.status === "sent" && (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={actioning}
                          onClick={() => runAction(inv.id, { action: "mark_overdue" }, "Marked overdue")}
                        >
                          Mark Overdue
                        </Button>
                      )}
                      {inv.status !== "paid" && inv.status !== "cancelled" && (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={actioning}
                          onClick={() => runAction(inv.id, { action: "cancel" }, "Invoice cancelled")}
                        >
                          Cancel
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Generate Invoice Dialog */}
      <Dialog open={generateOpen} onOpenChange={setGenerateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Generate Invoice</DialogTitle>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Month</Label>
              <Select value={genMonth} onValueChange={setGenMonth}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {MONTH_LABELS.map((label, idx) => (
                    <SelectItem key={label} value={String(idx + 1)}>{label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Year</Label>
              <Input
                type="number"
                value={genYear}
                onChange={(e) => setGenYear(e.target.value)}
              />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            Consolidates the {selectedCaseIds.size} selected case{selectedCaseIds.size === 1 ? "" : "s"} from Unbilled Referrals ({formatCurrency(selectedSum)}) into one invoice for the selected month. Uncheck any case there first to carve it out as an exception.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setGenerateOpen(false)}>Cancel</Button>
            <Button onClick={handleGenerate} disabled={generating}>
              {generating && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Generate
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Send Dialog */}
      <Dialog open={!!sendFor} onOpenChange={(open) => !open && setSendFor(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Send {sendFor?.invoice_number}</DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            <Label>Send to email</Label>
            <Input type="email" value={sendEmail} onChange={(e) => setSendEmail(e.target.value)} />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSendFor(null)}>Cancel</Button>
            <Button
              disabled={actioning}
              onClick={() => sendFor && runAction(sendFor.id, { action: "send", email: sendEmail }, "Invoice marked sent")}
            >
              {actioning && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Send
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Mark Paid Dialog */}
      <Dialog open={!!payFor} onOpenChange={(open) => !open && setPayFor(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Mark {payFor?.invoice_number} Paid</DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            <Label>Payment Reference (optional)</Label>
            <Input value={payReference} onChange={(e) => setPayReference(e.target.value)} placeholder="e.g. UTR / cheque no." />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPayFor(null)}>Cancel</Button>
            <Button
              disabled={actioning}
              onClick={() => payFor && runAction(payFor.id, { action: "mark_paid", payment_reference: payReference || undefined }, "Invoice marked paid")}
            >
              {actioning && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Mark Paid
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
