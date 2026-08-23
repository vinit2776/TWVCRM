"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PageBreadcrumb } from "@/components/page-breadcrumb";
import { useFetch } from "@/hooks/use-fetch";

import { KpiTiles } from "@/components/analytics/centers/kpi-tiles";
import { ComparisonTable, type SortColumn } from "@/components/analytics/centers/comparison-table";
import { OccupancyMeters } from "@/components/analytics/centers/occupancy-meters";
import { PeriodFilter } from "@/components/analytics/centers/period-filter";
import { CenterFilterChips } from "@/components/analytics/centers/center-filter-chips";
import { DetailSheet } from "@/components/analytics/centers/detail-sheet";
import { BreakdownDialog } from "@/components/analytics/centers/breakdown-dialog";
import { SpaceHeatmap } from "@/components/analytics/centers/space-heatmap";
import { rangeForPreset, priorRangeOf, isMtd, type PeriodPresetId } from "@/components/analytics/centers/period";
import type {
  SummaryResponse, TrendResponse, TrendMetric, CenterDetail, DateRange,
  BreakdownMetric, BreakdownResponse, HeatmapResponse,
} from "@/components/analytics/centers/types";

const TrendChart = dynamic(
  () => import("@/components/analytics/centers/charts").then((m) => ({ default: m.TrendChart })),
  { ssr: false }
);
const BilledCollectedChart = dynamic(
  () => import("@/components/analytics/centers/charts").then((m) => ({ default: m.BilledCollectedChart })),
  { ssr: false }
);

export default function CenterAnalyticsPage() {
  const [preset, setPreset] = useState<PeriodPresetId>("this_month");
  const [range, setRange] = useState<DateRange>(() => rangeForPreset("this_month"));
  const [activeCenterIds, setActiveCenterIds] = useState<Set<string>>(new Set());
  const [trendMetric, setTrendMetric] = useState<TrendMetric>("sales");
  const [sortColumn, setSortColumn] = useState<SortColumn>("sales");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [selectedCenterId, setSelectedCenterId] = useState<string | null>(null);
  const [breakdownRequest, setBreakdownRequest] = useState<{ locationId: string; metric: BreakdownMetric } | null>(null);

  const priorRange = useMemo(() => priorRangeOf(range), [range]);

  const handlePeriodChange = useCallback((nextPreset: PeriodPresetId, nextRange: DateRange) => {
    setPreset(nextPreset);
    setRange(nextRange);
  }, []);

  const handleSort = useCallback((col: SortColumn) => {
    setSortColumn((prevCol) => {
      if (prevCol === col) {
        setSortDir((d) => (d === "asc" ? "desc" : "asc"));
        return prevCol;
      }
      setSortDir("desc");
      return col;
    });
  }, []);

  const { data: summary, loading: summaryLoading, error: summaryError } = useFetch<SummaryResponse | null>(
    "/api/analytics/centers/summary",
    { params: { start: range.start, end: range.end }, initialData: null }
  );
  const { data: prevSummary } = useFetch<SummaryResponse | null>(
    "/api/analytics/centers/summary",
    { params: { start: priorRange.start, end: priorRange.end }, initialData: null }
  );
  const { data: trend, loading: trendLoading } = useFetch<TrendResponse | null>(
    "/api/analytics/centers/trend",
    { params: { metric: trendMetric, months: 6 }, initialData: null }
  );
  const { data: detail, loading: detailLoading } = useFetch<CenterDetail | null>(
    selectedCenterId ? `/api/analytics/centers/${selectedCenterId}/detail` : "",
    { params: { start: range.start, end: range.end }, initialData: null, enabled: !!selectedCenterId }
  );
  const { data: heatmap, loading: heatmapLoading } = useFetch<HeatmapResponse | null>(
    "/api/analytics/centers/heatmap",
    { params: { start: range.start, end: range.end }, initialData: null }
  );
  const { data: breakdown, loading: breakdownLoading } = useFetch<BreakdownResponse | null>(
    breakdownRequest ? `/api/analytics/centers/${breakdownRequest.locationId}/breakdown` : "",
    {
      params: { metric: breakdownRequest?.metric, start: range.start, end: range.end },
      initialData: null,
      enabled: !!breakdownRequest,
    }
  );

  // Seed the center filter with every center once the first summary lands,
  // then leave the user's toggles alone across subsequent period changes.
  useEffect(() => {
    if (summary && activeCenterIds.size === 0) {
      setActiveCenterIds(new Set(summary.centers.map((c) => c.location_id)));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [summary]);

  const toggleCenter = useCallback((locationId: string) => {
    setActiveCenterIds((prev) => {
      const next = new Set(prev);
      if (next.has(locationId)) {
        if (next.size === 1) return prev; // keep at least one center selected
        next.delete(locationId);
      } else {
        next.add(locationId);
      }
      return next;
    });
  }, []);

  const allCenters = summary?.centers ?? [];
  const filteredCenters = allCenters.filter((c) => activeCenterIds.has(c.location_id));
  const filteredPrevCenters = (prevSummary?.centers ?? []).filter((c) => activeCenterIds.has(c.location_id));

  const filteredTrendSeries = (trend?.centers ?? []).filter((s) => activeCenterIds.has(s.location_id));
  const highlightMonths = (trend?.centers[0]?.points ?? [])
    .map((p) => p.month)
    .filter((month) => `${month}-01` <= range.end && `${month}-31` >= range.start);

  return (
    <div className="space-y-6">
      <PageBreadcrumb resetTo={{ label: "Analytics" }} />

      <div>
        <h1 className="text-2xl font-bold">Center Analytics</h1>
        <p className="text-sm text-muted-foreground">
          Sales, collections and occupancy across every center.
        </p>
      </div>

      <div className="space-y-3">
        <PeriodFilter preset={preset} range={range} onChange={handlePeriodChange} />
        {allCenters.length > 1 && (
          <CenterFilterChips centers={allCenters} activeIds={activeCenterIds} onToggle={toggleCenter} />
        )}
      </div>

      {summaryError && (
        <p className="text-sm text-destructive">Couldn&apos;t load analytics: {summaryError}</p>
      )}

      {summaryLoading && !summary ? (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Card key={i}><CardContent className="pt-6 h-24 animate-pulse bg-muted/40 rounded-md" /></Card>
          ))}
        </div>
      ) : (
        <KpiTiles current={filteredCenters} previous={prevSummary ? filteredPrevCenters : null} isMtd={isMtd(range)} />
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Center comparison</CardTitle>
        </CardHeader>
        <CardContent>
          <ComparisonTable
            centers={filteredCenters}
            sortColumn={sortColumn}
            sortDir={sortDir}
            onSort={handleSort}
            onSelectCenter={setSelectedCenterId}
            onSelectBreakdown={(locationId, metric) => setBreakdownRequest({ locationId, metric })}
          />
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-5">
        <Card className="lg:col-span-3">
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <div>
              <CardTitle className="text-base">Trend by center</CardTitle>
              <p className="text-xs text-muted-foreground">Last 6 months</p>
            </div>
            <Tabs value={trendMetric} onValueChange={(v) => setTrendMetric(v as TrendMetric)}>
              <TabsList>
                <TabsTrigger value="sales">Sales</TabsTrigger>
                <TabsTrigger value="collections">Collections</TabsTrigger>
                <TabsTrigger value="occ">Occupancy</TabsTrigger>
              </TabsList>
            </Tabs>
          </CardHeader>
          <CardContent>
            {trendLoading && !trend ? (
              <div className="h-[300px] animate-pulse bg-muted/40 rounded-md" />
            ) : (
              <TrendChart series={filteredTrendSeries} metric={trendMetric} highlightMonths={highlightMonths} />
            )}
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-base">Billed vs collected</CardTitle>
            <p className="text-xs text-muted-foreground">Selected period</p>
          </CardHeader>
          <CardContent>
            <BilledCollectedChart centers={filteredCenters} />
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Occupancy by center</CardTitle>
        </CardHeader>
        <CardContent>
          <OccupancyMeters centers={filteredCenters} />
        </CardContent>
      </Card>

      <SpaceHeatmap units={heatmap?.units ?? []} loading={heatmapLoading && !heatmap} />

      <DetailSheet
        detail={detail}
        loading={detailLoading}
        open={!!selectedCenterId}
        onOpenChange={(open) => { if (!open) setSelectedCenterId(null); }}
      />

      <BreakdownDialog
        open={!!breakdownRequest}
        onOpenChange={(open) => { if (!open) setBreakdownRequest(null); }}
        centerName={allCenters.find((c) => c.location_id === breakdownRequest?.locationId)?.location_name ?? ""}
        metric={breakdownRequest?.metric ?? null}
        data={breakdown}
        loading={breakdownLoading}
      />
    </div>
  );
}
