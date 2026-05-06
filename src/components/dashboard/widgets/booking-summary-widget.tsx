"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { CalendarDays, CheckCircle2, XCircle, Users, Loader2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCurrency } from "@/lib/utils";

interface BookingSummary {
  total: number;
  confirmed: number;
  completed: number;
  no_show: number;
  cancelled: number;
  revenue: number;
}

interface BookingSummaryWidgetProps {
  locationFilter: string | null;
}

export function BookingSummaryWidget({ locationFilter }: BookingSummaryWidgetProps) {
  const [data, setData] = useState<BookingSummary | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (locationFilter) params.set("location_id", locationFilter);
      const res = await fetch(`/api/dashboard/bookings?${params}`);
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

  const today = new Date().toLocaleDateString("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "numeric",
    month: "short",
    year: "numeric",
  });

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            <CalendarDays className="h-4 w-4 text-muted-foreground" />
            Today&apos;s Bookings
          </CardTitle>
          <Link
            href="/bookings"
            className="text-xs text-primary hover:underline underline-offset-2"
          >
            View all →
          </Link>
        </div>
        <p className="text-xs text-muted-foreground">{today}</p>
      </CardHeader>
      <CardContent className="pt-0">
        {loading ? (
          <div className="flex items-center justify-center py-6">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="space-y-3">
            {/* Total + Revenue */}
            <div className="flex items-center justify-between rounded-lg bg-muted/50 px-4 py-3">
              <div className="flex items-center gap-2">
                <Users className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm font-medium">Total Bookings</span>
              </div>
              <span className="text-lg font-bold">{data?.total ?? 0}</span>
            </div>

            {(data?.revenue ?? 0) > 0 && (
              <div className="flex items-center justify-between px-4 py-2 rounded-lg border border-emerald-200 bg-emerald-50">
                <span className="text-sm font-medium text-emerald-800">Revenue Collected</span>
                <span className="text-base font-bold text-emerald-700">
                  {formatCurrency(data!.revenue)}
                </span>
              </div>
            )}

            {/* Status breakdown */}
            <div className="grid grid-cols-2 gap-2">
              <div className="flex items-center gap-2 rounded-md border px-3 py-2">
                <CheckCircle2 className="h-3.5 w-3.5 text-green-500 shrink-0" />
                <div className="min-w-0">
                  <p className="text-[11px] text-muted-foreground">Confirmed</p>
                  <p className="text-sm font-semibold">{data?.confirmed ?? 0}</p>
                </div>
              </div>
              <div className="flex items-center gap-2 rounded-md border px-3 py-2">
                <CheckCircle2 className="h-3.5 w-3.5 text-blue-500 shrink-0" />
                <div className="min-w-0">
                  <p className="text-[11px] text-muted-foreground">Completed</p>
                  <p className="text-sm font-semibold">{data?.completed ?? 0}</p>
                </div>
              </div>
              <div className="flex items-center gap-2 rounded-md border px-3 py-2">
                <XCircle className="h-3.5 w-3.5 text-red-500 shrink-0" />
                <div className="min-w-0">
                  <p className="text-[11px] text-muted-foreground">No Show</p>
                  <p className="text-sm font-semibold">{data?.no_show ?? 0}</p>
                </div>
              </div>
              <div className="flex items-center gap-2 rounded-md border px-3 py-2">
                <XCircle className="h-3.5 w-3.5 text-slate-400 shrink-0" />
                <div className="min-w-0">
                  <p className="text-[11px] text-muted-foreground">Cancelled</p>
                  <p className="text-sm font-semibold">{data?.cancelled ?? 0}</p>
                </div>
              </div>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
