"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Wallet, ArrowUpCircle, ArrowDownCircle } from "lucide-react";
import { InfoTooltip } from "@/components/ui/info-tooltip";
import { usePettyCashBooks, usePettyCashRequests, usePettyCashEntries } from "@/hooks/use-petty-cash";
import { PC_REQUEST_STATUS_LABELS, PC_REQUEST_STATUS_COLORS, PC_ENTRY_STATUS_LABELS, PC_ENTRY_STATUS_COLORS } from "@/lib/constants";

export function MyBookTab() {
  const { data: books, loading: booksLoading } = usePettyCashBooks();
  const { data: requests, loading: reqLoading } = usePettyCashRequests({ my: true, limit: 10 });
  const { data: entries, loading: entLoading } = usePettyCashEntries({ my: true, limit: 10 });

  const [ensured, setEnsured] = useState(false);

  // Auto-create book if doesn't exist
  if (!booksLoading && books.length === 0 && !ensured) {
    setEnsured(true);
    fetch("/api/petty-cash/books", { method: "POST" })
      .then(() => window.location.reload())
      .catch(() => {});
  }

  const book = books[0];
  const loading = booksLoading || reqLoading || entLoading;

  if (loading) {
    return <div className="animate-pulse space-y-4"><div className="h-32 rounded-lg bg-muted" /><div className="h-64 rounded-lg bg-muted" /></div>;
  }

  return (
    <div className="space-y-6">
      {/* Balance Card */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Wallet className="h-4 w-4" />My Petty Cash Book <InfoTooltip text="Your personal petty cash account. Request funds and log expenses here." side="right" />
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-3xl font-bold">
            ₹{book ? Number(book.current_balance).toLocaleString("en-IN") : "0"}
          </div>
          <p className="text-sm text-muted-foreground mt-1 flex items-center gap-1">Current Balance <InfoTooltip text="Cash available in your book. Increases when funds are issued, decreases when expenses are approved." /></p>
        </CardContent>
      </Card>

      <div className="grid gap-6 md:grid-cols-2">
        {/* Recent Requests */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <ArrowUpCircle className="h-4 w-4 text-green-600" />Recent Requests <InfoTooltip text="Fund requests you've submitted. Approved requests go to Accounting for payment." side="right" />
            </CardTitle>
          </CardHeader>
          <CardContent>
            {requests.length === 0 ? (
              <p className="text-sm text-muted-foreground">No requests yet</p>
            ) : (
              <div className="space-y-3">
                {requests.map((r) => (
                  <div key={r.id} className="flex items-center justify-between text-sm border-b pb-2 last:border-0">
                    <div>
                      <p className="font-medium">{r.request_number}</p>
                      <p className="text-muted-foreground text-xs truncate max-w-[200px]">{r.purpose}</p>
                    </div>
                    <div className="text-right">
                      <p className="font-medium">₹{Number(r.amount_requested).toLocaleString("en-IN")}</p>
                      <Badge variant="secondary" className={`text-xs ${PC_REQUEST_STATUS_COLORS[r.status] || ""}`}>
                        {PC_REQUEST_STATUS_LABELS[r.status] || r.status}
                      </Badge>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Recent Expenses */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <ArrowDownCircle className="h-4 w-4 text-red-600" />Recent Expenses
            </CardTitle>
          </CardHeader>
          <CardContent>
            {entries.length === 0 ? (
              <p className="text-sm text-muted-foreground">No expenses yet</p>
            ) : (
              <div className="space-y-3">
                {entries.map((e) => (
                  <div key={e.id} className="flex items-center justify-between text-sm border-b pb-2 last:border-0">
                    <div>
                      <p className="font-medium">{e.entry_number}</p>
                      <p className="text-muted-foreground text-xs truncate max-w-[200px]">{e.description}</p>
                    </div>
                    <div className="text-right">
                      <p className="font-medium">₹{Number(e.amount).toLocaleString("en-IN")}</p>
                      <Badge variant="secondary" className={`text-xs ${PC_ENTRY_STATUS_COLORS[e.status] || ""}`}>
                        {PC_ENTRY_STATUS_LABELS[e.status] || e.status}
                      </Badge>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
