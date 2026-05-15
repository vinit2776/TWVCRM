"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { Receipt, Loader2, Inbox } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCurrency } from "@/lib/utils";

interface LocationRow {
  location_id: string;
  location_name: string;
  value: number;
  bookings: number;
}

interface MtdBookingsData {
  total_value: number;
  total_bookings: number;
  locations: LocationRow[];
}

interface MtdBookingsWidgetProps {
  locationFilter: string | null;
}

export function MtdBookingsWidget({ locationFilter }: MtdBookingsWidgetProps) {
  const [data, setData] = useState<MtdBookingsData | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (locationFilter) params.set("location_id", locationFilter);
      const res = await fetch(`/api/dashboard/mtd-bookings?${params}`);
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

  const monthLabel = new Date().toLocaleDateString("en-IN", {
    timeZone: "Asia/Kolkata",
    month: "long",
    year: "numeric",
  });

  // Find max for bar normalization
  const maxValue = data?.locations.reduce((m, l) => Math.max(m, l.value), 0) ?? 0;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            <Receipt className="h-4 w-4 text-muted-foreground" />
            Bookings Value (MTD)
          </CardTitle>
          <Link href="/bookings" className="text-xs text-primary hover:underline">
            View all →
          </Link>
        </div>
        <p className="text-xs text-muted-foreground">{monthLabel} · excludes free quota</p>
      </CardHeader>
      <CardContent className="pt-0">
        {loading ? (
          <div className="flex items-center justify-center py-6">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : !data || data.locations.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-6 text-center">
            <Inbox className="h-8 w-8 mb-2 text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">No paid bookings this month</p>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="rounded-lg bg-muted/40 p-3">
              <div className="flex items-baseline justify-between">
                <span className="text-xs text-muted-foreground uppercase tracking-wide">
                  Total
                </span>
                <span className="text-xs text-muted-foreground">
                  {data.total_bookings} booking{data.total_bookings === 1 ? "" : "s"}
                </span>
              </div>
              <p className="text-2xl font-bold mt-1">
                {formatCurrency(data.total_value)}
              </p>
            </div>

            <div className="space-y-2 pt-1">
              <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">
                By location
              </p>
              {data.locations.map((l) => {
                const width = maxValue > 0 ? (l.value / maxValue) * 100 : 0;
                return (
                  <div key={l.location_id}>
                    <div className="flex items-center justify-between text-xs mb-1">
                      <span className="font-medium truncate">{l.location_name}</span>
                      <span className="text-muted-foreground tabular-nums">
                        {l.bookings} · <span className="font-semibold text-foreground">{formatCurrency(l.value)}</span>
                      </span>
                    </div>
                    <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                      <div
                        className="h-full bg-blue-500 transition-all"
                        style={{ width: `${width}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
