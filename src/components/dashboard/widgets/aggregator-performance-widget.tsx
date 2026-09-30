"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { Network, Loader2, Inbox } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCurrency } from "@/lib/utils";
import { dashboardFetch } from "@/lib/dashboard-fetch";

interface AggRow {
  id: string;
  name: string;
  active_cases: number;
  total_value: number;
  invoiced_ytd: number;
  outstanding_ytd: number;
}

interface AggData {
  total_aggregators: number;
  total_active_cases: number;
  total_outstanding_ytd: number;
  aggregators: AggRow[];
}

export function AggregatorPerformanceWidget() {
  const [data, setData] = useState<AggData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    dashboardFetch("/api/dashboard/aggregator-performance")
      .then((r) => r.json())
      .then((j) => setData(j.data ?? null))
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, []);

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            <Network className="h-4 w-4 text-muted-foreground" />
            Aggregator Performance
          </CardTitle>
          <Link href="/aggregators" className="text-xs text-primary hover:underline">
            View all →
          </Link>
        </div>
      </CardHeader>
      <CardContent className="pt-0">
        {loading ? (
          <div className="flex items-center justify-center py-6">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : !data || data.aggregators.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-6 text-center">
            <Inbox className="h-8 w-8 mb-2 text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">No aggregator activity</p>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-2">
              <div className="rounded-md border bg-muted/30 px-3 py-2">
                <p className="text-[10px] text-muted-foreground uppercase">Active Cases</p>
                <p className="text-base font-semibold">{data.total_active_cases}</p>
              </div>
              <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2">
                <p className="text-[10px] text-amber-700 uppercase">Outstanding YTD</p>
                <p className="text-base font-semibold text-amber-700">
                  {formatCurrency(data.total_outstanding_ytd)}
                </p>
              </div>
            </div>

            <div className="space-y-1 pt-1">
              <div className="grid grid-cols-[1fr_auto_auto] gap-2 px-1 pb-1 border-b text-[10px] uppercase tracking-wide text-muted-foreground">
                <span>Aggregator</span>
                <span className="text-right w-16">Cases</span>
                <span className="text-right w-24">Outstanding</span>
              </div>
              {data.aggregators.map((a) => (
                <div
                  key={a.id}
                  className="grid grid-cols-[1fr_auto_auto] gap-2 items-center px-1 py-1.5 hover:bg-muted/40 transition-colors rounded-md"
                >
                  <span className="text-sm truncate">{a.name}</span>
                  <span className="text-sm text-right tabular-nums w-16">{a.active_cases}</span>
                  <span
                    className={`text-sm font-semibold text-right tabular-nums w-24 ${
                      a.outstanding_ytd > 0 ? "text-amber-700" : "text-muted-foreground"
                    }`}
                  >
                    {a.outstanding_ytd > 0 ? formatCurrency(a.outstanding_ytd) : "—"}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
