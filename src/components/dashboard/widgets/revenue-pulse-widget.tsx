"use client";

import { useState, useEffect, useCallback } from "react";
import { TrendingUp, TrendingDown, Minus, Loader2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCurrency } from "@/lib/utils";

interface RevenueStream {
  current: number;
  previous: number;
}

interface RevenuePulseData {
  total_mtd: number;
  total_last_mtd: number;
  change_pct: number | null;
  streams: {
    contracts: RevenueStream;
    bookings: RevenueStream;
    prepaid: RevenueStream;
  };
}

interface RevenuePulseWidgetProps {
  locationFilter: string | null;
}

function StreamRow({ label, stream }: { label: string; stream: RevenueStream }) {
  const change =
    stream.previous > 0
      ? Math.round(((stream.current - stream.previous) / stream.previous) * 100)
      : null;
  const trend = change == null ? null : change > 5 ? "up" : change < -5 ? "down" : "flat";
  const TrendIcon = trend === "up" ? TrendingUp : trend === "down" ? TrendingDown : Minus;
  const trendColor =
    trend === "up" ? "text-emerald-600" : trend === "down" ? "text-red-600" : "text-muted-foreground";

  return (
    <div className="flex items-center justify-between py-1.5">
      <span className="text-sm text-muted-foreground">{label}</span>
      <div className="flex items-center gap-3">
        <span className="text-sm font-semibold tabular-nums">{formatCurrency(stream.current)}</span>
        {change != null && (
          <span className={`flex items-center gap-0.5 text-xs ${trendColor} min-w-[3.5rem] justify-end`}>
            <TrendIcon className="h-3 w-3" />
            {Math.abs(change)}%
          </span>
        )}
      </div>
    </div>
  );
}

export function RevenuePulseWidget({ locationFilter }: RevenuePulseWidgetProps) {
  const [data, setData] = useState<RevenuePulseData | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (locationFilter) params.set("location_id", locationFilter);
      const res = await fetch(`/api/dashboard/revenue-pulse?${params}`);
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

  const overallTrend =
    data?.change_pct == null
      ? "flat"
      : data.change_pct > 5
      ? "up"
      : data.change_pct < -5
      ? "down"
      : "flat";
  const TrendIcon =
    overallTrend === "up" ? TrendingUp : overallTrend === "down" ? TrendingDown : Minus;
  const trendColor =
    overallTrend === "up" ? "text-emerald-600" : overallTrend === "down" ? "text-red-600" : "text-muted-foreground";

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <TrendingUp className="h-4 w-4 text-muted-foreground" />
          Revenue Pulse (MTD)
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        {loading ? (
          <div className="flex items-center justify-center py-6">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : !data ? (
          <p className="text-sm text-muted-foreground">No data</p>
        ) : (
          <div className="space-y-3">
            <div className="rounded-lg bg-muted/40 p-3">
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground uppercase tracking-wide">
                  This Month
                </span>
                {data.change_pct != null && (
                  <span className={`flex items-center gap-1 text-xs font-medium ${trendColor}`}>
                    <TrendIcon className="h-3 w-3" />
                    {data.change_pct >= 0 ? "+" : ""}
                    {data.change_pct}% vs last
                  </span>
                )}
              </div>
              <p className="text-2xl font-bold mt-1">{formatCurrency(data.total_mtd)}</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                vs {formatCurrency(data.total_last_mtd)} same-period last month
              </p>
            </div>

            <div className="border-t pt-2">
              <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide mb-1">
                By stream
              </p>
              <StreamRow label="Contracts" stream={data.streams.contracts} />
              <StreamRow label="Bookings" stream={data.streams.bookings} />
              <StreamRow label="Prepaid Packages" stream={data.streams.prepaid} />
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
