"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import {
  CalendarClock,
  Loader2,
  Inbox,
  CalendarDays,
  Users,
  MapPin,
  Bell,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { dashboardFetch } from "@/lib/dashboard-fetch";

interface ScheduleItem {
  time: string;
  title: string;
  subtitle: string;
  kind: string;
  href: string;
}

interface ScheduleData {
  total: number;
  items: ScheduleItem[];
}

interface ScheduleWidgetProps {
  locationFilter: string | null;
}

const KIND_ICON: Record<string, typeof CalendarDays> = {
  booking: CalendarDays,
  meeting: Users,
  tour: MapPin,
  follow_up: Bell,
};

const KIND_COLOR: Record<string, string> = {
  booking: "text-blue-600 bg-blue-50",
  meeting: "text-purple-600 bg-purple-50",
  tour: "text-emerald-600 bg-emerald-50",
  follow_up: "text-amber-600 bg-amber-50",
};

export function ScheduleWidget({ locationFilter }: ScheduleWidgetProps) {
  const [data, setData] = useState<ScheduleData | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (locationFilter) params.set("location_id", locationFilter);
      const res = await dashboardFetch(`/api/dashboard/schedule?${params}`);
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
    weekday: "short",
    day: "numeric",
    month: "short",
  });

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            <CalendarClock className="h-4 w-4 text-muted-foreground" />
            Today&apos;s Schedule
          </CardTitle>
          <span className="text-xs text-muted-foreground">{today}</span>
        </div>
      </CardHeader>
      <CardContent className="pt-0">
        {loading ? (
          <div className="flex items-center justify-center py-6">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : !data || data.total === 0 ? (
          <div className="flex flex-col items-center justify-center py-6 text-center">
            <Inbox className="h-8 w-8 mb-2 text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">Nothing scheduled today</p>
          </div>
        ) : (
          <div className="space-y-1">
            {data.items.map((item, idx) => {
              const Icon = KIND_ICON[item.kind] ?? CalendarClock;
              const color = KIND_COLOR[item.kind] ?? "text-slate-600 bg-slate-50";
              return (
                <Link
                  key={idx}
                  href={item.href}
                  className="flex items-start gap-3 rounded-md px-2 py-2 hover:bg-muted/40 transition-colors"
                >
                  <span className="text-xs font-mono text-muted-foreground tabular-nums w-12 shrink-0 pt-0.5">
                    {item.time}
                  </span>
                  <div className={`rounded-full p-1 shrink-0 ${color}`}>
                    <Icon className="h-3 w-3" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{item.title}</p>
                    <p className="text-xs text-muted-foreground truncate">{item.subtitle}</p>
                  </div>
                </Link>
              );
            })}
            {data.total > data.items.length && (
              <p className="text-xs text-muted-foreground text-center pt-1">
                +{data.total - data.items.length} more
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
