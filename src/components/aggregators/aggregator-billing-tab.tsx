"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
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
import { Plus, Loader2, AlertTriangle, FileCheck, Zap } from "lucide-react";
import { toast } from "sonner";
import {
  AGG_INVOICE_STATUS_LABELS,
  AGG_INVOICE_STATUS_COLORS,
} from "@/lib/constants";
import { formatCurrency } from "@/lib/utils";
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
  billingMode?: "proforma_first" | "gst_direct" | null;
}

export function AggregatorBillingTab({ aggregatorId, creditLimit, primaryEmail, billingMode }: AggregatorBillingTabProps) {
  const [invoices, setInvoices] = useState<AggregatorInvoice[]>([]);
  const [eligibleCaseCount, setEligibleCaseCount] = useState(0);
  const [eligibleCasesSum, setEligibleCasesSum] = useState(0);
  const [loading, setLoading] = useState(true);

  // Proforma-vs-GST-Direct billing mode — same toggle pattern as
  // src/components/contracts/contract-invoices-section.tsx. Takes effect
  // from the next invoice only, never retroactive.
  const [currentMode, setCurrentMode] = useState<"proforma_first" | "gst_direct">(billingMode || "gst_direct");
  const [savingMode, setSavingMode] = useState(false);

  useEffect(() => {
    setCurrentMode(billingMode || "gst_direct");
  }, [billingMode]);

  const handleModeChange = async (newMode: "proforma_first" | "gst_direct") => {
    if (newMode === currentMode) return;
    setSavingMode(true);
    try {
      const res = await fetch(`/api/aggregators/${aggregatorId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ billing_mode: newMode }),
      });
      if (res.ok) {
        setCurrentMode(newMode);
        toast.success(newMode === "gst_direct" ? "GST Direct billing enabled from next invoice" : "Proforma First billing enabled from next invoice");
      } else {
        const err = await res.json().catch(() => null);
        toast.error(err?.error || "Failed to update billing mode");
      }
    } catch {
      toast.error("Failed to update billing mode");
    } finally {
      setSavingMode(false);
    }
  };

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
        const eligible = ((json.data || []) as VoCase[]).filter((c) =>
          BILLABLE_CASE_STATUSES.includes(c.status)
        );
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

  const handleGenerate = async () => {
    setGenerating(true);
    try {
      const res = await fetch("/api/aggregator-invoices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          aggregator_id: aggregatorId,
          period_month: parseInt(genMonth),
          period_year: parseInt(genYear),
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
      {/* Billing mode toggle */}
      <div className="rounded-md border p-4">
        <p className="text-xs text-muted-foreground mb-2 font-medium">Invoice Type (from next invoice)</p>
        <div className="flex gap-2">
          <button
            onClick={() => handleModeChange("proforma_first")}
            disabled={savingMode}
            className={`flex-1 flex items-center justify-center gap-1.5 rounded-md border px-3 py-2 text-xs font-medium transition-colors ${
              currentMode === "proforma_first"
                ? "bg-[#015E65] text-white border-[#015E65]"
                : "bg-background text-muted-foreground border-border hover:bg-muted/30"
            }`}
          >
            <FileCheck className="h-3.5 w-3.5 shrink-0" />
            Proforma First
          </button>
          <button
            onClick={() => handleModeChange("gst_direct")}
            disabled={savingMode}
            className={`flex-1 flex items-center justify-center gap-1.5 rounded-md border px-3 py-2 text-xs font-medium transition-colors ${
              currentMode === "gst_direct"
                ? "bg-violet-700 text-white border-violet-700"
                : "bg-background text-muted-foreground border-border hover:bg-muted/30"
            }`}
          >
            <Zap className="h-3.5 w-3.5 shrink-0" />
            GST Direct
          </button>
        </div>
        {currentMode === "gst_direct" && (
          <p className="text-[10px] text-violet-700 mt-1.5">
            Tax invoice issued directly · Accountant creates it in Tally, then the customer is billed · No proforma
          </p>
        )}
        {currentMode === "proforma_first" && (
          <p className="text-[10px] text-[#015E65] mt-1.5">
            Proforma invoice sent immediately with a payment link · Real GST invoice issued once paid
          </p>
        )}
      </div>

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

      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-muted-foreground">{invoices.length} invoice(s)</h3>
        <Button size="sm" onClick={() => setGenerateOpen(true)}>
          <Plus className="mr-2 h-4 w-4" />
          Generate Invoice
        </Button>
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
                    <Badge className={AGG_INVOICE_STATUS_COLORS[inv.status]}>
                      {AGG_INVOICE_STATUS_LABELS[inv.status]}
                    </Badge>
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
            Pulls every active/renewal-due/invoiced/executed case for this aggregator and consolidates them into one invoice for the selected month.
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
