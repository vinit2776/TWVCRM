"use client";

import { useState, useEffect, useCallback } from "react";
import { PiggyBank, Loader2, Inbox } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCurrency } from "@/lib/utils";
import { dashboardFetch } from "@/lib/dashboard-fetch";

interface DeptRow {
  department: string;
  spend: number;
  budget: number;
  consumed_pct: number | null;
}

interface SpendData {
  total_spend_mtd: number;
  total_budget: number;
  total_consumed_pct: number | null;
  departments: DeptRow[];
}

interface ProcurementSpendWidgetProps {
  locationFilter: string | null;
}

function pctColor(pct: number | null) {
  if (pct == null) return "bg-slate-400";
  if (pct >= 100) return "bg-red-500";
  if (pct >= 80) return "bg-orange-500";
  if (pct >= 50) return "bg-amber-500";
  return "bg-emerald-500";
}

export function ProcurementSpendWidget({ locationFilter }: ProcurementSpendWidgetProps) {
  const [data, setData] = useState<SpendData | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (locationFilter) params.set("location_id", locationFilter);
      const res = await dashboardFetch(`/api/dashboard/procurement-spend?${params}`);
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
        <CardTitle className="text-base flex items-center gap-2">
          <PiggyBank className="h-4 w-4 text-muted-foreground" />
          Procurement Spend (MTD)
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        {loading ? (
          <div className="flex items-center justify-center py-6">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : !data || data.departments.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-6 text-center">
            <Inbox className="h-8 w-8 mb-2 text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">No spend or budgets configured</p>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="rounded-lg bg-muted/40 p-3">
              <div className="flex items-baseline justify-between">
                <span className="text-xs text-muted-foreground uppercase tracking-wide">
                  Total MTD
                </span>
                {data.total_consumed_pct != null && (
                  <span className="text-xs text-muted-foreground">
                    {data.total_consumed_pct}% of budget
                  </span>
                )}
              </div>
              <p className="text-2xl font-bold mt-1">
                {formatCurrency(data.total_spend_mtd)}
              </p>
              {data.total_budget > 0 && (
                <p className="text-xs text-muted-foreground mt-0.5">
                  Budget {formatCurrency(data.total_budget)}
                </p>
              )}
            </div>

            <div className="space-y-2 pt-1">
              <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">
                By department
              </p>
              {data.departments.slice(0, 6).map((d) => (
                <div key={d.department}>
                  <div className="flex items-center justify-between text-xs mb-1">
                    <span className="font-medium capitalize truncate">{d.department}</span>
                    <span className="text-muted-foreground tabular-nums">
                      {formatCurrency(d.spend)}
                      {d.budget > 0 && (
                        <span className="ml-1 text-[10px]">/ {formatCurrency(d.budget)}</span>
                      )}
                    </span>
                  </div>
                  <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                    <div
                      className={`h-full ${pctColor(d.consumed_pct)}`}
                      style={{
                        width: `${Math.min(d.consumed_pct ?? 0, 100)}%`,
                      }}
                    />
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
