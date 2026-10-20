"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { LineChart } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/shared/empty-state";
import { Skeleton } from "@/components/shared/loading-skeleton";
import { DaysToPayChart, PillarChart, PillarLegend, SeatsChart, TicketsChart } from "@/components/leads/value/perf-charts";
import {
  RANGE_LABELS,
  daysToPayPoints,
  monthlyInRange,
  pillarSeries,
  seatPoints,
  ticketPoints,
  type PerfMonthRow,
  type PerfScoreRow,
  type RangeKey,
} from "@/lib/customer-value/performance-view";

export interface PerformanceData {
  today: string;
  scores: PerfScoreRow[];
  monthly: PerfMonthRow[];
}

function ChartCard({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">{title}</CardTitle>
        {note && <p className="text-xs text-muted-foreground">{note}</p>}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

export function PerformancePanel({ leadId }: { leadId: string }) {
  const [data, setData] = useState<PerformanceData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [range, setRange] = useState<RangeKey>("12");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // no-store so a Recompute is reflected straight away instead of from the 60-second browser copy.
      const res = await fetch(`/api/leads/${leadId}/value/performance`, { cache: "no-store" });
      if (!res.ok) throw new Error(res.status === 403 ? "Admins only" : "Could not load performance");
      setData((await res.json()) as PerformanceData);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load performance");
    } finally {
      setLoading(false);
    }
  }, [leadId]);

  useEffect(() => {
    load();
  }, [load]);

  // Switching range only re-slices rows that are already loaded.
  const view = useMemo(() => {
    if (!data) return null;
    const months = monthlyInRange(data.monthly, data.today, range);
    return {
      pillars: pillarSeries(data.scores, data.today, range),
      days: daysToPayPoints(months),
      seats: seatPoints(months),
      tickets: ticketPoints(months),
      months: months.length,
    };
  }, [data, range]);

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-52" />
        <Skeleton className="h-52" />
        <Skeleton className="h-52" />
      </div>
    );
  }

  if (error || !data || !view) {
    return (
      <Card>
        <CardContent className="flex items-center justify-between gap-4 py-6">
          <p className="text-sm text-muted-foreground">{error ?? "Could not load performance"}</p>
          <Button variant="outline" size="sm" onClick={load}>Retry</Button>
        </CardContent>
      </Card>
    );
  }

  if (view.months === 0 && view.pillars.length === 0) {
    return (
      <Card>
        <CardContent>
          <EmptyState
            icon={LineChart}
            title="No history yet"
            description="Charts appear once this customer has monthly figures. They are computed each night, or use Recompute above."
          />
        </CardContent>
      </Card>
    );
  }

  const noDaysData = view.days.every((p) => p.days === null);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted-foreground">Range</span>
        {(Object.keys(RANGE_LABELS) as RangeKey[]).map((k) => (
          <Button key={k} size="sm" variant={range === k ? "default" : "outline"} onClick={() => setRange(k)}>
            {RANGE_LABELS[k]}
          </Button>
        ))}
      </div>

      <ChartCard title="Scores over time" note="Each line is one measure, 0 to 100. A break in a line means that measure could not be scored that month.">
        {view.pillars.length > 0 ? (
          <>
            <PillarChart points={view.pillars} />
            <PillarLegend />
          </>
        ) : (
          <p className="text-sm text-muted-foreground">No scores in this range yet.</p>
        )}
      </ChartCard>

      <div className="space-y-4">
        <ChartCard title="Days to pay" note="Average per month, for invoices that fell due. Below the line is early, above is late.">
          {noDaysData ? (
            <p className="text-sm text-muted-foreground">No paid invoices with a due date in this range.</p>
          ) : (
            <DaysToPayChart points={view.days} />
          )}
        </ChartCard>

        <ChartCard
          title="Seats paid for and used"
          note={view.seats.hasUsage ? "Dashed: seats on the contract. Solid: average seats in use, from door access." : "Dashed: seats on the contract. Seats in use are not shown: there is no door-access data for this customer."}
        >
          {view.seats.points.some((p) => p.paid !== null) ? (
            <SeatsChart points={view.seats.points} hasUsage={view.seats.hasUsage} />
          ) : (
            <p className="text-sm text-muted-foreground">No contract seats in this range.</p>
          )}
        </ChartCard>
      </div>

      <ChartCard
        title="Tickets raised"
        note={
          view.tickets.unlinkedTotal > 0
            ? `Only tickets that can be tied to this customer. ${view.tickets.unlinkedTotal} more at the same center could not be attributed to anyone.`
            : "Only tickets that can be tied to this customer. Dark: past their target time."
        }
      >
        {view.tickets.total > 0 ? (
          <TicketsChart points={view.tickets.points} />
        ) : (
          <p className="text-sm text-muted-foreground">No tickets tied to this customer in this range.</p>
        )}
      </ChartCard>
    </div>
  );
}
