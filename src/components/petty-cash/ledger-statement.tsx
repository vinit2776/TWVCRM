"use client";

import { CheckCircle2, AlertTriangle } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useFetch } from "@/hooks/use-fetch";
import { formatCurrency } from "@/lib/utils";
import { PC_ISSUANCE_METHOD_LABELS } from "@/lib/constants";
import { LEDGER_KIND_HELP, LEDGER_KIND_LABELS, type LedgerKind, type Reconciliation } from "@/lib/petty-cash-ledger";

interface Row {
  id: string; kind: LedgerKind; amount: number; balance_after: number; note: string | null; created_at: string; by: string | null;
  entry_number: string | null; bill_count: number | null;
  request_number: string | null; issuance_method: string | null; issuance_reference: string | null;
}
interface Statement {
  book: { id: string; owner: string | null; balance: number } | null;
  data: Row[];
  truncated: boolean;
  reconciliation: Reconciliation | null;
}

/** Every rupee in or out of one petty cash book, with the running balance. Rows are never edited. */
export function LedgerStatement({ bookId, title = "Statement" }: { bookId?: string; title?: string }) {
  const { data: s, loading } = useFetch<Statement | null>("/api/petty-cash/ledger", {
    params: { book_id: bookId },
    initialData: null,
    select: (j) => j as unknown as Statement,
  });

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">{title}</CardTitle>
        <p className="text-xs text-muted-foreground mt-1">
          Every rupee that came into or went out of this book, newest first. Rows cannot be edited or deleted — if something was wrong, a new correcting row is added.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        {loading && !s ? (
          <div className="h-24 animate-pulse rounded bg-muted" />
        ) : !s?.book ? (
          <p className="text-sm text-muted-foreground py-4 text-center">No statement yet.</p>
        ) : (
          <>
            {s.reconciliation && (
              s.reconciliation.matches ? (
                <p className="flex items-center gap-2 rounded-md bg-green-50 text-green-800 text-sm px-3 py-2">
                  <CheckCircle2 className="h-4 w-4 shrink-0" />Balance check: these rows add up to {formatCurrency(s.book.balance)}, which matches the book.
                </p>
              ) : (
                <p className="flex items-start gap-2 rounded-md bg-amber-50 text-amber-800 text-sm px-3 py-2">
                  <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
                  <span>Balance check failed: the rows add up to {formatCurrency(s.reconciliation.ledgerTotal)} but the book says {formatCurrency(s.book.balance)} (difference {formatCurrency(s.reconciliation.difference)}). Tell Accounts — do not change anything yourself.</span>
                </p>
              )
            )}
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    <th className="pb-2 font-medium">Date</th>
                    <th className="pb-2 font-medium">What happened</th>
                    <th className="pb-2 font-medium text-right">Money in</th>
                    <th className="pb-2 font-medium text-right">Money out</th>
                    <th className="pb-2 font-medium text-right">Balance after</th>
                  </tr>
                </thead>
                <tbody>
                  {s.data.map((r) => (
                    <tr key={r.id} className="border-b last:border-0 align-top">
                      <td className="py-2 whitespace-nowrap">{new Date(r.created_at).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}</td>
                      <td className="py-2">
                        <span title={LEDGER_KIND_HELP[r.kind]}><Badge variant="secondary" className="text-xs">{LEDGER_KIND_LABELS[r.kind]}</Badge></span>
                        {r.note && <p className="text-xs text-muted-foreground mt-0.5">{r.note}</p>}
                        {r.kind === "issue" && (r.issuance_method || r.issuance_reference) && (
                          <p className="text-xs text-muted-foreground">Paid by {r.issuance_method ? (PC_ISSUANCE_METHOD_LABELS[r.issuance_method] ?? r.issuance_method) : "—"}{r.issuance_reference ? ` · reference ${r.issuance_reference}` : ""}</p>
                        )}
                        {r.kind === "spend" && r.bill_count === 0 && <p className="text-xs text-amber-700">No bill attached</p>}
                        {r.by && <p className="text-xs text-muted-foreground">by {r.by}</p>}
                      </td>
                      <td className="py-2 text-right text-green-700">{r.amount > 0 ? formatCurrency(r.amount) : ""}</td>
                      <td className="py-2 text-right text-red-600">{r.amount < 0 ? formatCurrency(-r.amount) : ""}</td>
                      <td className="py-2 text-right font-medium">{formatCurrency(r.balance_after)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {s.truncated && <p className="text-xs text-muted-foreground">Showing the latest 100 rows. The balance check above covers the whole statement.</p>}
          </>
        )}
      </CardContent>
    </Card>
  );
}
