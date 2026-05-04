"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { CalendarX, Loader2, Inbox, AlertTriangle } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCurrency } from "@/lib/utils";

interface RenewalItem {
  id: string;
  contract_number: string | null;
  end_date: string;
  days_left: number;
  monthly_value: number;
  seats: number;
  customer: string;
  lead_id: string | null;
}

interface RenewalData {
  total_count: number;
  total_monthly_at_risk: number;
  bucket_0_30: { count: number; monthly_value: number };
  bucket_31_60: { count: number; monthly_value: number };
  items: RenewalItem[];
}

interface RenewalPipelineWidgetProps {
  locationFilter: string | null;
}

export function RenewalPipelineWidget({ locationFilter }: RenewalPipelineWidgetProps) {
  const [data, setData] = useState<RenewalData | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (locationFilter) params.set("location_id", locationFilter);
      const res = await fetch(`/api/dashboard/renewals?${params}`);
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

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            <CalendarX className="h-4 w-4 text-muted-foreground" />
            Renewal Pipeline (60d)
          </CardTitle>
          <Link href="/contracts?status=active" className="text-xs text-primary hover:underline">
            View all →
          </Link>
        </div>
      </CardHeader>
      <CardContent className="pt-0">
        {loading ? (
          <div className="flex items-center justify-center py-6">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : !data || data.total_count === 0 ? (
          <div className="flex flex-col items-center justify-center py-6 text-center">
            <Inbox className="h-8 w-8 mb-2 text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">No renewals due in 60 days</p>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 dark:bg-amber-950/20">
              <div className="flex items-center gap-2 text-amber-800 dark:text-amber-300">
                <AlertTriangle className="h-4 w-4" />
                <span className="text-xs font-semibold uppercase tracking-wide">
                  Monthly Revenue At Risk
                </span>
              </div>
              <p className="text-2xl font-bold text-amber-900 dark:text-amber-200 mt-1">
                {formatCurrency(data.total_monthly_at_risk)}
              </p>
              <p className="text-xs text-amber-700 dark:text-amber-400 mt-0.5">
                Across {data.total_count} contract{data.total_count === 1 ? "" : "s"}
              </p>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2">
                <p className="text-[11px] text-red-700">Next 30 days</p>
                <p className="text-base font-semibold text-red-700">
                  {data.bucket_0_30.count} · {formatCurrency(data.bucket_0_30.monthly_value)}
                </p>
              </div>
              <div className="rounded-md border border-orange-200 bg-orange-50 px-3 py-2">
                <p className="text-[11px] text-orange-700">31–60 days</p>
                <p className="text-base font-semibold text-orange-700">
                  {data.bucket_31_60.count} · {formatCurrency(data.bucket_31_60.monthly_value)}
                </p>
              </div>
            </div>

            <div className="space-y-1 pt-1">
              {data.items.map((c) => (
                <Link
                  key={c.id}
                  href={c.lead_id ? `/leads/${c.lead_id}` : `/contracts`}
                  className="flex items-center justify-between rounded-md px-2 py-2 hover:bg-muted/40 transition-colors"
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium truncate">{c.customer}</p>
                    <p className="text-xs text-muted-foreground">
                      {c.contract_number ?? "—"} · {c.seats} seat{c.seats === 1 ? "" : "s"}
                    </p>
                  </div>
                  <div className="text-right shrink-0 ml-2">
                    <p className="text-sm font-semibold">{formatCurrency(c.monthly_value)}/mo</p>
                    <p
                      className={`text-[10px] ${
                        c.days_left <= 7
                          ? "text-red-600"
                          : c.days_left <= 30
                          ? "text-orange-600"
                          : "text-muted-foreground"
                      }`}
                    >
                      {c.days_left === 0 ? "Today" : `In ${c.days_left}d`}
                    </p>
                  </div>
                </Link>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
