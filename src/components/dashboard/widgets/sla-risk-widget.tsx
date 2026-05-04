"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { ShieldAlert, AlertTriangle, Loader2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface PriorityBucket {
  open: number;
  breached: number;
}

interface SlaSide {
  total_open: number;
  total_breached: number;
  by_priority: Record<string, PriorityBucket>;
}

interface SlaData {
  tickets: SlaSide;
  issues: SlaSide;
}

interface SlaRiskWidgetProps {
  locationFilter: string | null;
}

const PRIORITY_ORDER = ["critical", "high", "medium", "low"] as const;
const PRIORITY_COLOR: Record<string, string> = {
  critical: "text-red-600 bg-red-50 border-red-200",
  high: "text-orange-600 bg-orange-50 border-orange-200",
  medium: "text-amber-600 bg-amber-50 border-amber-200",
  low: "text-slate-600 bg-slate-50 border-slate-200",
};

function PrioRow({ p, bucket }: { p: string; bucket: PriorityBucket }) {
  if (bucket.open === 0) return null;
  return (
    <div className={`flex items-center justify-between rounded-md border px-2 py-1.5 ${PRIORITY_COLOR[p]}`}>
      <span className="text-[11px] font-medium uppercase">{p}</span>
      <div className="flex items-center gap-3">
        <span className="text-xs">{bucket.open} open</span>
        {bucket.breached > 0 && (
          <span className="text-xs font-bold flex items-center gap-1">
            <AlertTriangle className="h-3 w-3" />
            {bucket.breached} SLA
          </span>
        )}
      </div>
    </div>
  );
}

function Section({
  title,
  side,
  href,
}: {
  title: string;
  side: SlaSide;
  href: string;
}) {
  if (side.total_open === 0) {
    return (
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground mb-1">
          {title}
        </p>
        <p className="text-xs text-muted-foreground">All clear — no open items</p>
      </div>
    );
  }
  return (
    <div>
      <Link href={href} className="flex items-center justify-between mb-1.5 group">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground group-hover:underline">
          {title}
        </p>
        <span className="text-xs">
          {side.total_open} open
          {side.total_breached > 0 && (
            <span className="text-red-600 font-semibold ml-1">
              ({side.total_breached} breached)
            </span>
          )}
        </span>
      </Link>
      <div className="space-y-1">
        {PRIORITY_ORDER.map((p) => {
          const b = side.by_priority[p];
          if (!b) return null;
          return <PrioRow key={p} p={p} bucket={b} />;
        })}
      </div>
    </div>
  );
}

export function SlaRiskWidget({ locationFilter }: SlaRiskWidgetProps) {
  const [data, setData] = useState<SlaData | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (locationFilter) params.set("location_id", locationFilter);
      const res = await fetch(`/api/dashboard/sla-risk?${params}`);
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
          <ShieldAlert className="h-4 w-4 text-muted-foreground" />
          SLA Risk Board
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
          <div className="space-y-4">
            <Section title="Support Tickets" side={data.tickets} href="/support" />
            <div className="border-t pt-3">
              <Section title="Facility Issues" side={data.issues} href="/facility" />
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
