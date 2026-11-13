"use client";

import { useState, useEffect, useCallback } from "react";
import { Target, Loader2, Inbox } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { LEAD_SOURCE_LABELS } from "@/lib/constants";
import { formatCurrency } from "@/lib/utils";
import { dashboardFetch } from "@/lib/dashboard-fetch";

interface SourceRow {
  source: string;
  total: number;
  won: number;
  conversion_pct: number;
  revenue: number;
}

interface SourceRoiData {
  window_days: number;
  total_leads: number;
  total_won: number;
  sources: SourceRow[];
}

interface SourceRoiWidgetProps {
  locationFilter: string | null;
}

export function SourceRoiWidget({ locationFilter }: SourceRoiWidgetProps) {
  const [data, setData] = useState<SourceRoiData | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (locationFilter) params.set("location_id", locationFilter);
      const res = await dashboardFetch(`/api/dashboard/source-roi?${params}`);
      const json = await res.json();
      setData(json.data ?? null);
    } catch {
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [locationFilter]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const maxRevenue =
    data?.sources.reduce((m, s) => Math.max(m, s.revenue), 0) ?? 0;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Target className="h-4 w-4 text-muted-foreground" />
          Source ROI (180d)
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        {loading ? (
          <div className="flex items-center justify-center py-6">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : !data || data.sources.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-6 text-center">
            <Inbox className="h-8 w-8 mb-2 text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">No leads in last 180 days</p>
          </div>
        ) : (
          <div className="space-y-2">
            <div className="flex items-center justify-between text-xs text-muted-foreground border-b pb-1.5">
              <span>{data.total_leads} leads · {data.total_won} won</span>
            </div>
            {data.sources.map((s) => {
              const width = maxRevenue > 0 ? (s.revenue / maxRevenue) * 100 : 0;
              return (
                <div key={s.source}>
                  <div className="flex items-center justify-between text-xs mb-1">
                    <span className="font-medium truncate">
                      {LEAD_SOURCE_LABELS[s.source] ?? s.source}
                    </span>
                    <span className="text-muted-foreground tabular-nums">
                      {s.won}/{s.total} · {s.conversion_pct}%
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="h-2 rounded-full bg-muted flex-1 overflow-hidden">
                      <div
                        className="h-full bg-emerald-500 transition-all"
                        style={{ width: `${width}%` }}
                      />
                    </div>
                    <span className="text-xs font-semibold tabular-nums w-20 text-right">
                      {s.revenue > 0 ? formatCurrency(s.revenue) : "—"}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
