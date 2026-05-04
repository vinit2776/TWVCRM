"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { Filter, AlertTriangle, Loader2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { LEAD_STATUS_LABELS } from "@/lib/constants";

interface FunnelStage {
  stage: string;
  count: number;
  avg_days_in_stage: number;
  aging_count: number;
}

interface FunnelData {
  active_total: number;
  won: number;
  lost: number;
  closed_conversion_pct: number;
  total_aging: number;
  stages: FunnelStage[];
}

interface LeadFunnelWidgetProps {
  locationFilter: string | null;
}

export function LeadFunnelWidget({ locationFilter }: LeadFunnelWidgetProps) {
  const [data, setData] = useState<FunnelData | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (locationFilter) params.set("location_id", locationFilter);
      const res = await fetch(`/api/dashboard/lead-funnel?${params}`);
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

  // Find max for bar normalization
  const maxCount = data?.stages.reduce((m, s) => Math.max(m, s.count), 0) ?? 0;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Filter className="h-4 w-4 text-muted-foreground" />
          Lead Funnel
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
            <div className="grid grid-cols-3 gap-2">
              <div className="rounded-md border bg-muted/30 px-2 py-2 text-center">
                <p className="text-[10px] text-muted-foreground uppercase">In Pipeline</p>
                <p className="text-base font-semibold">{data.active_total}</p>
              </div>
              <div className="rounded-md border border-emerald-200 bg-emerald-50 px-2 py-2 text-center">
                <p className="text-[10px] text-emerald-700 uppercase">Closed Conv.</p>
                <p className="text-base font-semibold text-emerald-700">
                  {data.closed_conversion_pct}%
                </p>
              </div>
              <div className="rounded-md border border-red-200 bg-red-50 px-2 py-2 text-center">
                <p className="text-[10px] text-red-700 uppercase">Aging &gt;7d</p>
                <p className="text-base font-semibold text-red-700">{data.total_aging}</p>
              </div>
            </div>

            <div className="space-y-2 pt-1">
              {data.stages.map((s) => {
                const width = maxCount > 0 ? (s.count / maxCount) * 100 : 0;
                return (
                  <Link
                    key={s.stage}
                    href={`/leads?status=${s.stage}`}
                    className="block group"
                  >
                    <div className="flex items-center justify-between text-xs mb-1">
                      <span className="font-medium group-hover:underline">
                        {LEAD_STATUS_LABELS[s.stage] ?? s.stage}
                      </span>
                      <span className="flex items-center gap-2 text-muted-foreground">
                        {s.aging_count > 0 && (
                          <span className="flex items-center gap-0.5 text-red-600">
                            <AlertTriangle className="h-3 w-3" />
                            {s.aging_count}
                          </span>
                        )}
                        <span>~{s.avg_days_in_stage}d</span>
                        <span className="font-semibold text-foreground">{s.count}</span>
                      </span>
                    </div>
                    <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                      <div
                        className="h-full bg-blue-500 transition-all"
                        style={{ width: `${width}%` }}
                      />
                    </div>
                  </Link>
                );
              })}
            </div>

            <div className="border-t pt-2 flex items-center justify-between text-xs">
              <span className="text-muted-foreground">
                Won: <span className="font-semibold text-emerald-700">{data.won}</span>
              </span>
              <span className="text-muted-foreground">
                Lost: <span className="font-semibold text-red-700">{data.lost}</span>
              </span>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
