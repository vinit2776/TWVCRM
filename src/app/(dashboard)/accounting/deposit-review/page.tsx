"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ShieldAlert, Loader2, ChevronLeft } from "lucide-react";
import { toast } from "sonner";
import { formatCurrency, formatDate } from "@/lib/utils";
import { PageBreadcrumb } from "@/components/page-breadcrumb";
import { STATEMENT_PAYMENT_MODE_LABELS } from "@/lib/constants";

interface ReviewRow {
  payment_id: string;
  statement_id: string;
  statement_number: string | null;
  gst_invoice_number: string | null;
  contract_id: string;
  contract_number: string | null;
  amount: number;
  payment_date: string;
  payment_mode: string;
  payment_reference: string | null;
  notes: string | null;
  recorded_by: string | null;
  deposit_collected: number;
}

const WINDOWS = [30, 90, 365];

/**
 * Detective control for the deposit-adjustment gate. Lists payments recorded as
 * a plain mode that look like a deposit adjustment on a contract whose customer
 * holds deposit. Fix a real one by reversing it and re-recording it through
 * "Adjustment against deposit" (needs admin or manager approval).
 *
 * Roles: admin, accounts.
 */
export default function DepositReviewPage() {
  const [rows, setRows] = useState<ReviewRow[] | null>(null);
  const [days, setDays] = useState(90);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  const fetchData = useCallback(async (d: number) => {
    setLoading(true);
    setFailed(false);
    try {
      const res = await fetch(`/api/accounting/deposit-review?days=${d}`);
      if (!res.ok) throw new Error("Failed to load");
      const json = await res.json();
      setRows(json.rows);
    } catch {
      setFailed(true);
      toast.error("Failed to load deposit review");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchData(days); }, [days, fetchData]);

  return (
    <div className="space-y-4 max-w-6xl mx-auto">
      <PageBreadcrumb resetTo={{ label: "Deposit Review" }} />
      <div className="flex items-center gap-3">
        <Link href="/billing" className="text-muted-foreground hover:text-foreground">
          <ChevronLeft className="h-5 w-5" />
        </Link>
        <div className="flex-1">
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <ShieldAlert className="h-6 w-6 text-amber-600" />
            Payments to review against deposits
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Payments recorded as Other, or with deposit or adjustment wording, on contracts whose customer holds a deposit.
            If one was really a deposit adjustment, it never reduced the deposit balance.
          </p>
        </div>
        <div className="flex gap-1">
          {WINDOWS.map((w) => (
            <button
              key={w}
              onClick={() => setDays(w)}
              className={`px-2.5 py-1 text-xs rounded-md border ${days === w ? "bg-foreground text-background" : "hover:bg-muted"}`}
            >
              {w === 365 ? "1 year" : `${w} days`}
            </button>
          ))}
        </div>
      </div>

      <Card>
        <CardContent className="p-0 overflow-x-auto">
          {loading ? (
            <div className="flex justify-center py-12"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
          ) : failed ? (
            <p className="text-sm text-red-600 text-center py-12">Couldn&apos;t load the review. Reload to try again.</p>
          ) : !rows || rows.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-12">
              Nothing to review. No suspicious payments in the last {days} days.
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground">
                  <th className="px-4 py-2 font-medium">Invoice</th>
                  <th className="px-4 py-2 font-medium">Contract</th>
                  <th className="px-4 py-2 font-medium text-right">Amount</th>
                  <th className="px-4 py-2 font-medium">Mode</th>
                  <th className="px-4 py-2 font-medium">Reference / notes</th>
                  <th className="px-4 py-2 font-medium">Recorded</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {rows.map((r) => (
                  <tr key={r.payment_id} className="hover:bg-muted/30">
                    <td className="px-4 py-2.5">
                      <p className="font-medium">{r.gst_invoice_number || r.statement_number || "—"}</p>
                      {r.gst_invoice_number && r.statement_number && (
                        <p className="text-xs text-muted-foreground">{r.statement_number}</p>
                      )}
                    </td>
                    <td className="px-4 py-2.5">
                      <Link href={`/contracts/${r.contract_id}`} className="text-blue-600 hover:underline">
                        {r.contract_number ?? "—"}
                      </Link>
                      <p className="text-xs text-muted-foreground">{formatCurrency(r.deposit_collected)} deposit</p>
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums">{formatCurrency(r.amount)}</td>
                    <td className="px-4 py-2.5">
                      <Badge variant="outline" className="text-[10px]">
                        {STATEMENT_PAYMENT_MODE_LABELS[r.payment_mode] ?? r.payment_mode}
                      </Badge>
                    </td>
                    <td className="px-4 py-2.5 text-xs max-w-[300px]">
                      {r.payment_reference && <p className="truncate">{r.payment_reference}</p>}
                      {r.notes && <p className="text-muted-foreground truncate">{r.notes}</p>}
                    </td>
                    <td className="px-4 py-2.5 text-xs text-muted-foreground whitespace-nowrap">
                      {formatDate(r.payment_date)}
                      {r.recorded_by && <p>{r.recorded_by}</p>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
