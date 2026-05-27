"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Loader2, ExternalLink, FileText, Receipt } from "lucide-react";
import { formatCurrency, formatDate } from "@/lib/utils";

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

export function ContractInvoicesSection({ contractId }: { contractId: string }) {
  const [statements, setStatements] = useState<Statement[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`/api/billing-statements?contract_id=${contractId}&limit=100`)
      .then((r) => r.json())
      .then((d) => setStatements((d.data || []) as Statement[]))
      .catch(() => setStatements([]))
      .finally(() => setLoading(false));
  }, [contractId]);

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
