"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Loader2, ExternalLink, FileText, Receipt, FileCheck, Zap } from "lucide-react";
import { formatCurrency, formatDate } from "@/lib/utils";
import { toast } from "sonner";

interface Statement {
  id: string;
  statement_number: string;
  period_start: string;
  period_end: string;
  total_amount: number;
  status: string;
  payment_status: string | null;
  gst_invoice_number: string | null;
  gst_invoice_path: string | null;
  razorpay_payment_link_url: string | null;
  finalized_at: string | null;
}

const STATEMENT_STATUS_LABELS: Record<string, string> = {
  draft: "Draft",
  finalized: "Finalized",
  exported: "Exported",
  voided: "Voided",
};

const STATEMENT_STATUS_COLORS: Record<string, string> = {
  draft: "bg-gray-100 text-gray-700 border-gray-200",
  finalized: "bg-blue-50 text-blue-700 border-blue-200",
  exported: "bg-purple-50 text-purple-700 border-purple-200",
  voided: "bg-red-50 text-red-600 border-red-200",
};

const PAYMENT_STATUS_LABELS: Record<string, string> = {
  unpaid: "Unpaid",
  partially_paid: "Partial",
  paid: "Paid",
};

const PAYMENT_STATUS_COLORS: Record<string, string> = {
  unpaid: "bg-red-50 text-red-700 border-red-200",
  partially_paid: "bg-amber-50 text-amber-700 border-amber-200",
  paid: "bg-green-50 text-green-700 border-green-200",
};

function periodLabel(start: string, end: string) {
  const s = new Date(start + "T00:00:00Z");
  const e = new Date(end + "T00:00:00Z");
  const month = s.toLocaleString("en-IN", { month: "short", timeZone: "UTC" });
  const year = s.getUTCFullYear();
  // If period spans a single calendar month, show "Jun 2025"; otherwise show date range
  if (s.getUTCMonth() === e.getUTCMonth() && s.getUTCFullYear() === e.getUTCFullYear()) {
    return `${month} ${year}`;
  }
  return `${formatDate(start)} – ${formatDate(end)}`;
}

interface ContractInvoicesSectionProps {
  contractId: string;
  billingMode?: 'proforma_first' | 'gst_direct' | null;
  contractStatus?: string;
}

export function ContractInvoicesSection({ contractId, billingMode, contractStatus }: ContractInvoicesSectionProps) {
  const [statements, setStatements] = useState<Statement[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingMode, setSavingMode] = useState(false);
  const [currentMode, setCurrentMode] = useState<'proforma_first' | 'gst_direct'>(billingMode || 'proforma_first');

  useEffect(() => {
    setCurrentMode(billingMode || 'proforma_first');
  }, [billingMode]);

  useEffect(() => {
    fetch(`/api/billing-statements?contract_id=${contractId}&limit=100`)
      .then((r) => r.json())
      .then((d) => setStatements((d.data || []) as Statement[]))
      .catch(() => setStatements([]))
      .finally(() => setLoading(false));
  }, [contractId]);

  const handleModeChange = async (newMode: 'proforma_first' | 'gst_direct') => {
    if (newMode === currentMode) return;
    setSavingMode(true);
    try {
      const res = await fetch(`/api/contracts/${contractId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ billing_mode: newMode }),
      });
      if (res.ok) {
        setCurrentMode(newMode);
        toast.success(newMode === 'gst_direct' ? "GST Direct billing enabled from next cycle" : "Proforma First billing restored from next cycle");
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

  // Show toggle for active/live contracts — locked for terminated/expired/completed/renewed
  const canEditMode = !contractStatus || ["active", "renewal_in_progress", "draft", "sent", "accepted"].includes(contractStatus);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Receipt className="h-4 w-4 text-muted-foreground" />
          Monthly Invoices
        </CardTitle>
        <Link href={`/billing?contract_id=${contractId}`}>
          <Button variant="ghost" size="sm">
            <ExternalLink className="h-3.5 w-3.5 mr-1" />
            Billing
          </Button>
        </Link>
      </CardHeader>
      {/* Billing mode toggle */}
      {canEditMode && (
        <div className="px-6 pb-3">
          <p className="text-xs text-muted-foreground mb-2 font-medium">Invoice Type (from next billing cycle)</p>
          <div className="flex gap-2">
            <button
              onClick={() => handleModeChange('proforma_first')}
              disabled={savingMode}
              className={`flex-1 flex items-center justify-center gap-1.5 rounded-md border px-3 py-2 text-xs font-medium transition-colors ${
                currentMode === 'proforma_first'
                  ? 'bg-[#015E65] text-white border-[#015E65]'
                  : 'bg-background text-muted-foreground border-border hover:bg-muted/30'
              }`}
            >
              <FileCheck className="h-3.5 w-3.5 shrink-0" />
              Proforma First
            </button>
            <button
              onClick={() => handleModeChange('gst_direct')}
              disabled={savingMode}
              className={`flex-1 flex items-center justify-center gap-1.5 rounded-md border px-3 py-2 text-xs font-medium transition-colors ${
                currentMode === 'gst_direct'
                  ? 'bg-violet-700 text-white border-violet-700'
                  : 'bg-background text-muted-foreground border-border hover:bg-muted/30'
              }`}
            >
              <Zap className="h-3.5 w-3.5 shrink-0" />
              GST Direct
            </button>
          </div>
          {currentMode === 'gst_direct' && (
            <p className="text-[10px] text-violet-700 mt-1.5">
              Tax invoice issued directly each cycle · Due date = issue date + 7 days · No proforma
            </p>
          )}
        </div>
      )}

      <CardContent>
        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : statements.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4 text-center">
            No invoices generated yet. Statements are created automatically each month after contract activation.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-xs text-muted-foreground">
                  <th className="text-left font-medium pb-2 pr-4">Period</th>
                  <th className="text-left font-medium pb-2 pr-4">Proforma #</th>
                  <th className="text-right font-medium pb-2 pr-4">Amount</th>
                  <th className="text-left font-medium pb-2 pr-4">Status</th>
                  <th className="text-left font-medium pb-2 pr-4">Payment</th>
                  <th className="text-left font-medium pb-2">GST Invoice</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {statements.map((s) => (
                  <tr key={s.id} className="hover:bg-muted/30 transition-colors">
                    <td className="py-2.5 pr-4 whitespace-nowrap">
                      {periodLabel(s.period_start, s.period_end)}
                    </td>
                    <td className="py-2.5 pr-4">
                      <Link
                        href={`/billing/statements/${s.id}`}
                        className="font-mono text-xs text-primary hover:underline"
                      >
                        {s.statement_number}
                      </Link>
                    </td>
                    <td className="py-2.5 pr-4 text-right tabular-nums font-medium whitespace-nowrap">
                      {formatCurrency(s.total_amount)}
                    </td>
                    <td className="py-2.5 pr-4">
                      <Badge
                        variant="outline"
                        className={`text-[10px] ${STATEMENT_STATUS_COLORS[s.status] ?? ""}`}
                      >
                        {STATEMENT_STATUS_LABELS[s.status] ?? s.status}
                      </Badge>
                    </td>
                    <td className="py-2.5 pr-4">
                      {s.payment_status ? (
                        <Badge
                          variant="outline"
                          className={`text-[10px] ${PAYMENT_STATUS_COLORS[s.payment_status] ?? ""}`}
                        >
                          {PAYMENT_STATUS_LABELS[s.payment_status] ?? s.payment_status}
                        </Badge>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="py-2.5">
                      {s.gst_invoice_number ? (
                        <div className="flex items-center gap-1.5">
                          <span className="font-mono text-xs text-green-700">{s.gst_invoice_number}</span>
                          {s.gst_invoice_path && (
                            <Button variant="ghost" size="icon" className="h-5 w-5" asChild>
                              <a href={s.gst_invoice_path} target="_blank" rel="noopener noreferrer" title="Download GST Invoice">
                                <FileText className="h-3 w-3" />
                              </a>
                            </Button>
                          )}
                        </div>
                      ) : (
                        <span className="text-[10px] text-muted-foreground italic">
                          {s.payment_status === "paid" ? "Generating…" : "Issued on payment"}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
