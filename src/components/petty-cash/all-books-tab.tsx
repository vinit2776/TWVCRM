"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ArrowLeft, ChevronRight } from "lucide-react";
import { usePettyCashBooks, usePettyCashEntries, usePettyCashRequests } from "@/hooks/use-petty-cash";
import { PC_ENTRY_STATUS_LABELS, PC_ENTRY_STATUS_COLORS, PC_REQUEST_STATUS_LABELS, PC_REQUEST_STATUS_COLORS } from "@/lib/constants";
import type { PettyCashBook } from "@/types";
import { getDateRange, type TimelinePreset } from "@/lib/petty-cash-utils";

export function AllBooksTab() {
  const { data: books, loading } = usePettyCashBooks({ all: true });
  const [selectedBook, setSelectedBook] = useState<PettyCashBook | null>(null);
  const [period, setPeriod] = useState<TimelinePreset>("this_month");

  if (loading) {
    return <div className="animate-pulse space-y-3">{[1, 2, 3].map((i) => <div key={i} className="h-16 rounded bg-muted" />)}</div>;
  }

  if (selectedBook) {
    return (
      <BookDetailView
        book={selectedBook}
        period={period}
        setPeriod={setPeriod}
        onBack={() => setSelectedBook(null)}
      />
    );
  }

  const totalBalance = books.reduce((sum, b) => sum + Number(b.current_balance), 0);

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Total Float Outstanding</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-3xl font-bold">₹{totalBalance.toLocaleString("en-IN")}</div>
          <p className="text-sm text-muted-foreground mt-1">Across {books.length} book(s)</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">All Petty Cash Books</CardTitle>
        </CardHeader>
        <CardContent>
          {books.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">No books created yet</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left">
                    <th className="pb-2 font-medium text-muted-foreground">Person</th>
                    <th className="pb-2 font-medium text-muted-foreground hidden md:table-cell">Email</th>
                    <th className="pb-2 font-medium text-muted-foreground hidden md:table-cell">Role</th>
                    <th className="pb-2 font-medium text-muted-foreground text-right">Balance</th>
                    <th className="pb-2 w-8"></th>
                  </tr>
                </thead>
                <tbody>
                  {books.map((b) => (
                    <tr
                      key={b.id}
                      className="border-b last:border-0 hover:bg-muted/30 cursor-pointer"
                      onClick={() => setSelectedBook(b)}
                    >
                      <td className="py-2.5 font-medium">{b.owner?.full_name || "—"}</td>
                      <td className="py-2.5 hidden md:table-cell text-muted-foreground">{b.owner?.email || "—"}</td>
                      <td className="py-2.5 hidden md:table-cell text-muted-foreground capitalize">{b.owner?.role || "—"}</td>
                      <td className="py-2.5 text-right font-medium">
                        ₹{Number(b.current_balance).toLocaleString("en-IN")}
                      </td>
                      <td className="py-2.5 text-right">
                        <ChevronRight className="h-4 w-4 text-muted-foreground" />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ─── Book Detail View ─────────────────────────────────────────────────────────

function BookDetailView({
  book,
  period,
  setPeriod,
  onBack,
}: {
  book: PettyCashBook;
  period: TimelinePreset;
  setPeriod: (p: TimelinePreset) => void;
  onBack: () => void;
}) {
  const { dateFrom, dateTo } = getDateRange(period);

  const { data: entries, loading: entriesLoading } = usePettyCashEntries({
    bookId: book.id,
    dateFrom,
    dateTo,
    limit: 50,
  });
  const { data: requests, loading: requestsLoading } = usePettyCashRequests({
    bookId: book.id,
    limit: 20,
  });

  const loading = entriesLoading || requestsLoading;

  // Compute analytics
  const approvedEntries = entries.filter((e) => e.status === "approved");
  const totalSpend = approvedEntries.reduce((sum, e) => sum + Number(e.amount), 0);
  const totalIssued = requests
    .filter((r) => r.status === "issued" && r.issued_at && r.issued_at >= dateFrom && r.issued_at <= dateTo + "T23:59:59")
    .reduce((sum, r) => sum + Number(r.amount_requested), 0);

  // Category breakdown
  const categoryMap: Record<string, number> = {};
  for (const e of approvedEntries) {
    const catName = (e.category as { name: string } | null)?.name || "Uncategorized";
    categoryMap[catName] = (categoryMap[catName] || 0) + Number(e.amount);
  }
  const sortedCategories = Object.entries(categoryMap).sort(([, a], [, b]) => b - a);
  const maxCategorySpend = sortedCategories.length > 0 ? sortedCategories[0][1] : 1;

  const presets: { key: TimelinePreset; label: string }[] = [
    { key: "this_week", label: "This Week" },
    { key: "this_month", label: "This Month" },
    { key: "this_year", label: "This Year" },
  ];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft className="h-4 w-4 mr-1" />Back
        </Button>
        <div>
          <h3 className="text-lg font-semibold">{book.owner?.full_name || "Unknown"}</h3>
          <p className="text-sm text-muted-foreground">{book.owner?.email} &middot; {book.owner?.role}</p>
        </div>
      </div>

      {/* Timeline presets */}
      <div className="flex gap-2">
        {presets.map((p) => (
          <Button
            key={p.key}
            size="sm"
            variant={period === p.key ? "default" : "outline"}
            onClick={() => setPeriod(p.key)}
          >
            {p.label}
          </Button>
        ))}
      </div>

      {loading ? (
        <div className="animate-pulse space-y-4">
          <div className="h-24 rounded-lg bg-muted" />
          <div className="h-48 rounded-lg bg-muted" />
        </div>
      ) : (
        <>
          {/* Summary cards */}
          <div className="grid gap-4 md:grid-cols-3">
            <Card>
              <CardContent className="pt-6">
                <p className="text-sm text-muted-foreground">Current Balance</p>
                <p className="text-2xl font-bold">₹{Number(book.current_balance).toLocaleString("en-IN")}</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-6">
                <p className="text-sm text-muted-foreground">Spend in Period</p>
                <p className="text-2xl font-bold">₹{totalSpend.toLocaleString("en-IN")}</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-6">
                <p className="text-sm text-muted-foreground">Issued in Period</p>
                <p className="text-2xl font-bold">₹{totalIssued.toLocaleString("en-IN")}</p>
              </CardContent>
            </Card>
          </div>

          {/* Category breakdown */}
          {sortedCategories.length > 0 && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Spend by Category</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-3">
                  {sortedCategories.map(([cat, total]) => (
                    <div key={cat}>
                      <div className="flex items-center justify-between text-sm mb-1">
                        <span>{cat}</span>
                        <span className="font-medium">₹{total.toLocaleString("en-IN")}</span>
                      </div>
                      <div className="h-2 bg-muted rounded-full overflow-hidden">
                        <div
                          className="h-full bg-amber-500 rounded-full transition-all"
                          style={{ width: `${(total / maxCategorySpend) * 100}%` }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          {/* Entries table */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Expenses ({entries.length})</CardTitle>
            </CardHeader>
            <CardContent>
              {entries.length === 0 ? (
                <p className="text-sm text-muted-foreground py-4 text-center">No expenses in this period</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b text-left">
                        <th className="pb-2 font-medium text-muted-foreground">Date</th>
                        <th className="pb-2 font-medium text-muted-foreground">Amount</th>
                        <th className="pb-2 font-medium text-muted-foreground hidden md:table-cell">Category</th>
                        <th className="pb-2 font-medium text-muted-foreground hidden lg:table-cell">Description</th>
                        <th className="pb-2 font-medium text-muted-foreground">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {entries.map((e) => (
                        <tr key={e.id} className="border-b last:border-0 hover:bg-muted/30">
                          <td className="py-2">{new Date(e.date).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}</td>
                          <td className="py-2">₹{Number(e.amount).toLocaleString("en-IN")}</td>
                          <td className="py-2 hidden md:table-cell text-muted-foreground">
                            {(e.category as { name: string } | null)?.name || "—"}
                          </td>
                          <td className="py-2 hidden lg:table-cell text-muted-foreground truncate max-w-[200px]">{e.description}</td>
                          <td className="py-2">
                            <Badge variant="secondary" className={`text-xs ${PC_ENTRY_STATUS_COLORS[e.status] || ""}`}>
                              {PC_ENTRY_STATUS_LABELS[e.status] || e.status}
                            </Badge>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Requests table */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Funding Requests ({requests.length})</CardTitle>
            </CardHeader>
            <CardContent>
              {requests.length === 0 ? (
                <p className="text-sm text-muted-foreground py-4 text-center">No funding requests</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b text-left">
                        <th className="pb-2 font-medium text-muted-foreground">Request #</th>
                        <th className="pb-2 font-medium text-muted-foreground">Amount</th>
                        <th className="pb-2 font-medium text-muted-foreground hidden md:table-cell">Purpose</th>
                        <th className="pb-2 font-medium text-muted-foreground">Status</th>
                        <th className="pb-2 font-medium text-muted-foreground hidden md:table-cell">Date</th>
                      </tr>
                    </thead>
                    <tbody>
                      {requests.map((r) => (
                        <tr key={r.id} className="border-b last:border-0 hover:bg-muted/30">
                          <td className="py-2 font-medium">{r.request_number}</td>
                          <td className="py-2">₹{Number(r.amount_requested).toLocaleString("en-IN")}</td>
                          <td className="py-2 hidden md:table-cell text-muted-foreground truncate max-w-[200px]">{r.purpose}</td>
                          <td className="py-2">
                            <Badge variant="secondary" className={`text-xs ${PC_REQUEST_STATUS_COLORS[r.status] || ""}`}>
                              {PC_REQUEST_STATUS_LABELS[r.status] || r.status}
                            </Badge>
                          </td>
                          <td className="py-2 hidden md:table-cell text-muted-foreground">
                            {new Date(r.created_at).toLocaleDateString("en-IN")}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
