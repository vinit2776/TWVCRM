"use client";

import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { usePettyCashEntries, usePettyCashCategories } from "@/hooks/use-petty-cash";

export function AnalyticsTab() {
  const [period, setPeriod] = useState<"30" | "90" | "365">("30");
  const dateFrom = new Date(Date.now() - parseInt(period) * 86400000).toISOString().slice(0, 10);

  const { data: entries, loading } = usePettyCashEntries({
    status: "approved",
    dateFrom,
    limit: 50,
  });
  const { data: categories } = usePettyCashCategories();

  // Compute analytics
  const totalSpend = entries.reduce((sum, e) => sum + Number(e.amount), 0);
  const categoryMap: Record<string, number> = {};
  const dailyMap: Record<string, number> = {};

  for (const e of entries) {
    const catName = (e.category as { name: string } | null)?.name || "Uncategorized";
    categoryMap[catName] = (categoryMap[catName] || 0) + Number(e.amount);
    dailyMap[e.date] = (dailyMap[e.date] || 0) + 1;
  }

  const sortedCategories = Object.entries(categoryMap).sort(([, a], [, b]) => b - a);
  const maxCategorySpend = sortedCategories.length > 0 ? sortedCategories[0][1] : 1;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold">Spending Analytics</h3>
        <Select value={period} onValueChange={(v) => setPeriod(v as "30" | "90" | "365")}>
          <SelectTrigger className="w-[160px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="30">Last 30 days</SelectItem>
            <SelectItem value="90">Last 90 days</SelectItem>
            <SelectItem value="365">This year</SelectItem>
          </SelectContent>
        </Select>
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
                <p className="text-sm text-muted-foreground">Total Spend</p>
                <p className="text-2xl font-bold">₹{totalSpend.toLocaleString("en-IN")}</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-6">
                <p className="text-sm text-muted-foreground">Transactions</p>
                <p className="text-2xl font-bold">{entries.length}</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-6">
                <p className="text-sm text-muted-foreground">Avg per Transaction</p>
                <p className="text-2xl font-bold">
                  ₹{entries.length > 0 ? Math.round(totalSpend / entries.length).toLocaleString("en-IN") : "0"}
                </p>
              </CardContent>
            </Card>
          </div>

          {/* Category breakdown (horizontal bar chart) */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Spend by Category</CardTitle>
            </CardHeader>
            <CardContent>
              {sortedCategories.length === 0 ? (
                <p className="text-sm text-muted-foreground py-4 text-center">No approved expenses in this period</p>
              ) : (
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
              )}
            </CardContent>
          </Card>

          {/* Daily frequency */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Transaction Frequency</CardTitle>
            </CardHeader>
            <CardContent>
              {Object.keys(dailyMap).length === 0 ? (
                <p className="text-sm text-muted-foreground py-4 text-center">No data</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b text-left">
                        <th className="pb-2 font-medium text-muted-foreground">Date</th>
                        <th className="pb-2 font-medium text-muted-foreground text-right">Transactions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {Object.entries(dailyMap)
                        .sort(([a], [b]) => b.localeCompare(a))
                        .slice(0, 15)
                        .map(([date, count]) => (
                          <tr key={date} className="border-b last:border-0">
                            <td className="py-2">{new Date(date).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" })}</td>
                            <td className="py-2 text-right font-medium">{count}</td>
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
