"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { useFetch } from "@/hooks/use-fetch";
import { formatCurrency } from "@/lib/utils";
import { CONTRACT_STATUS_LABELS, CONTRACT_STATUS_COLORS } from "@/lib/constants";
import { CenterFilterChips } from "./center-filter-chips";
import { ProjectionAdjustmentsPanel } from "./projection-adjustments-panel";
import type { ProjectionsResponse } from "./types";

const ProjectionChart = dynamic(
  () => import("./projection-chart").then((m) => ({ default: m.ProjectionChart })),
  { ssr: false }
);

function compactCurrency(n: number): string {
  if (Math.abs(n) >= 100000) return `₹${(n / 100000).toFixed(n % 100000 === 0 ? 0 : 1)}L`;
  if (Math.abs(n) >= 1000) return `₹${(n / 1000).toFixed(0)}k`;
  return formatCurrency(n);
}

const CONTRACTS_PAGE_SIZE = 8;

export function ProjectionsTab() {
  const [fyYear, setFyYear] = useState<number | null>(null);
  const [activeCenterIds, setActiveCenterIds] = useState<Set<string>>(new Set());
  const [showAllContracts, setShowAllContracts] = useState(false);

  const { data, loading, error, refetch } = useFetch<ProjectionsResponse | null>(
    "/api/analytics/centers/projections",
    { params: { fy: fyYear ?? undefined }, initialData: null }
  );

  // Seed both the FY toggle and the center filter from the first response —
  // the route resolves "current FY" server-side, so the client doesn't
  // duplicate that date math beyond picking "current" vs "next" to request.
  useEffect(() => {
    if (data && fyYear === null) setFyYear(data.fy.year);
    if (data && activeCenterIds.size === 0) {
      setActiveCenterIds(new Set(data.centers.map((c) => c.location_id)));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  const toggleCenter = useCallback((locationId: string) => {
    setActiveCenterIds((prev) => {
      const next = new Set(prev);
      if (next.has(locationId)) {
        if (next.size === 1) return prev;
        next.delete(locationId);
      } else {
        next.add(locationId);
      }
      return next;
    });
  }, []);

  const filteredCenters = useMemo(
    () => (data?.centers ?? []).filter((c) => activeCenterIds.has(c.location_id)),
    [data, activeCenterIds]
  );

  const months = useMemo(() => data?.months ?? [], [data]);
  const confirmedByMonth = useMemo(
    () => months.map((_, i) => filteredCenters.reduce((s, c) => s + (c.confirmed[i] ?? 0), 0)),
    [months, filteredCenters]
  );
  const ifRenewedByMonth = useMemo(
    () => months.map((_, i) => filteredCenters.reduce((s, c) => s + (c.if_renewed[i] ?? 0), 0)),
    [months, filteredCenters]
  );

  const confirmedTotal = confirmedByMonth.reduce((a, b) => a + b, 0);
  const ifRenewedTotal = ifRenewedByMonth.reduce((a, b) => a + b, 0);
  const combinedTotal = confirmedTotal + ifRenewedTotal;
  const avgConfirmed = months.length > 0 ? confirmedTotal / months.length : 0;
  const dependsPct = combinedTotal > 0 ? Math.round((ifRenewedTotal / combinedTotal) * 100) : 0;
  let peakIdx = 0;
  months.forEach((_, i) => {
    if (confirmedByMonth[i] + ifRenewedByMonth[i] > confirmedByMonth[peakIdx] + ifRenewedByMonth[peakIdx]) peakIdx = i;
  });

  const filteredContracts = useMemo(
    () => (data?.contracts ?? []).filter((c) => activeCenterIds.has(c.location_id)),
    [data, activeCenterIds]
  );
  const visibleContracts = showAllContracts ? filteredContracts : filteredContracts.slice(0, CONTRACTS_PAGE_SIZE);

  const adjustmentsInView = useMemo(
    () => (data?.adjustments ?? []).filter((a) => activeCenterIds.has(a.location_id) && months.includes(a.month)),
    [data, activeCenterIds, months]
  );

  const monthLabel = (ym: string) => {
    const [y, m] = ym.split("-").map(Number);
    const names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    return `${names[m - 1]} '${String(y).slice(2)}`;
  };

  if (error) {
    return <p className="text-sm text-destructive">Couldn&apos;t load projections: {error}</p>;
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="inline-flex rounded-md border bg-muted p-1">
          {data && (() => {
            const currentYear = data.fy.is_current ? data.fy.year : data.fy.year - 1;
            const nextYear = currentYear + 1;
            const fyLabel = (y: number) => `FY ${y}–${String((y + 1) % 100).padStart(2, "0")}`;
            return (
              <>
                <Button
                  type="button"
                  size="sm"
                  variant={fyYear === currentYear ? "default" : "ghost"}
                  className="h-8"
                  onClick={() => setFyYear(currentYear)}
                >
                  {fyLabel(currentYear)}
                  <span className="ml-1.5 text-[11px] font-normal opacity-70">current</span>
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant={fyYear === nextYear ? "default" : "ghost"}
                  className="h-8"
                  onClick={() => setFyYear(nextYear)}
                >
                  {fyLabel(nextYear)}
                  <span className="ml-1.5 text-[11px] font-normal opacity-70">next</span>
                </Button>
              </>
            );
          })()}
        </div>
        {data && data.centers.length > 1 && (
          <CenterFilterChips centers={data.centers} activeIds={activeCenterIds} onToggle={toggleCenter} />
        )}
      </div>

      {loading && !data ? (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
          {Array.from({ length: 5 }).map((_, i) => (
            <Card key={i}><CardContent className="pt-6 h-24 animate-pulse bg-muted/40 rounded-md" /></Card>
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
          <Card>
            <CardContent className="pt-6">
              <div className="text-xs font-medium text-muted-foreground">Confirmed FY total</div>
              <div className="mt-1 text-2xl font-bold tracking-tight">{compactCurrency(confirmedTotal)}</div>
              <div className="mt-1 text-xs text-muted-foreground">
                Active / renewal-in-progress, pre-GST
                {adjustmentsInView.length > 0 && ` · incl. ${adjustmentsInView.length} manual adjustment${adjustmentsInView.length > 1 ? "s" : ""}`}
              </div>
            </CardContent>
          </Card>
          <Card className="border-amber-200">
            <CardContent className="pt-6">
              <div className="text-xs font-medium text-muted-foreground">If all renew, +escalation</div>
              <div className="mt-1 text-2xl font-bold tracking-tight text-amber-700">+{compactCurrency(ifRenewedTotal)}</div>
              <div className="mt-1 text-xs text-muted-foreground">{dependsPct}% of the full picture depends on renewal</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <div className="text-xs font-medium text-muted-foreground">Combined FY total</div>
              <div className="mt-1 text-2xl font-bold tracking-tight">{compactCurrency(combinedTotal)}</div>
              <div className="mt-1 text-xs text-muted-foreground">Confirmed + hypothetical renewals</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <div className="text-xs font-medium text-muted-foreground">Avg. confirmed MRR</div>
              <div className="mt-1 text-2xl font-bold tracking-tight">{compactCurrency(avgConfirmed)}</div>
              <div className="mt-1 text-xs text-muted-foreground">Monthly, across selected centers</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <div className="text-xs font-medium text-muted-foreground">Peak month</div>
              <div className="mt-1 text-2xl font-bold tracking-tight">
                {compactCurrency(confirmedByMonth[peakIdx] + ifRenewedByMonth[peakIdx])}
              </div>
              <div className="mt-1 text-xs text-muted-foreground">{months[peakIdx] ? monthLabel(months[peakIdx]) : "—"} · combined</div>
            </CardContent>
          </Card>
        </div>
      )}

      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <div>
            <CardTitle className="text-base">Projected monthly recurring revenue</CardTitle>
            <p className="text-xs text-muted-foreground">{data ? `${data.fy.label} · pre-GST` : " "}</p>
          </div>
        </CardHeader>
        <CardContent>
          {loading && !data ? (
            <div className="h-[300px] animate-pulse bg-muted/40 rounded-md" />
          ) : (
            <ProjectionChart months={months} confirmed={confirmedByMonth} ifRenewed={ifRenewedByMonth} />
          )}
          <p className="mt-3 text-xs text-muted-foreground">
            <b className="text-foreground">Confirmed</b> sums every active / renewal-in-progress contract overlapping
            that month at its current phase rate, and stops at each contract&apos;s own end date — no renewal assumed.{" "}
            <b className="text-foreground">If renewed</b> is hypothetical: for a contract that has already ended,
            it adds back one month at that contract&apos;s own escalation % (rate × (1 + esc%), the formula the real
            renewal flow uses), applied once, not compounded per month.
          </p>
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-5">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-base">By center</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Center</TableHead>
                    <TableHead className="text-right">Confirmed</TableHead>
                    <TableHead className="text-right">If renewed</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {[...filteredCenters]
                    .sort((a, b) =>
                      (b.confirmed.reduce((s, v) => s + v, 0) + b.if_renewed.reduce((s, v) => s + v, 0)) -
                      (a.confirmed.reduce((s, v) => s + v, 0) + a.if_renewed.reduce((s, v) => s + v, 0))
                    )
                    .map((c) => {
                      const conf = c.confirmed.reduce((s, v) => s + v, 0);
                      const ren = c.if_renewed.reduce((s, v) => s + v, 0);
                      return (
                        <TableRow key={c.location_id}>
                          <TableCell className="font-medium">{c.location_name}</TableCell>
                          <TableCell className="text-right">{compactCurrency(conf)}</TableCell>
                          <TableCell className="text-right text-amber-700">
                            {ren > 0 ? `+${compactCurrency(ren)}` : "—"}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  {filteredCenters.length === 0 && (
                    <TableRow><TableCell colSpan={3} className="text-center text-sm text-muted-foreground py-6">No centers selected.</TableCell></TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>

        <Card className="lg:col-span-3">
          <CardHeader>
            <CardTitle className="text-base">Contracts ending soonest</CardTitle>
            <p className="text-xs text-muted-foreground">Drives the projection above — sorted by end date</p>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Client</TableHead>
                    <TableHead>Center</TableHead>
                    <TableHead className="text-right">Rate /mo</TableHead>
                    <TableHead>Ends</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">If renewed</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visibleContracts.map((c) => (
                    <TableRow key={c.id}>
                      <TableCell>
                        <Link href={`/contracts/${c.id}`} className="font-medium hover:underline">{c.client_name}</Link>
                      </TableCell>
                      <TableCell className="text-muted-foreground">{c.location_name}</TableCell>
                      <TableCell className="text-right">{formatCurrency(c.monthly_rate)}</TableCell>
                      <TableCell>{c.end_date ?? "—"}</TableCell>
                      <TableCell>
                        <Badge variant="outline" className={`border-0 ${CONTRACT_STATUS_COLORS[c.status] ?? ""}`}>
                          {CONTRACT_STATUS_LABELS[c.status] ?? c.status}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex flex-col items-end">
                          <Badge variant="outline" className="border-amber-200 bg-amber-50 text-amber-800 text-[10px]">
                            +{c.escalation_percentage}%
                          </Badge>
                          <span className="mt-0.5 text-xs font-medium text-amber-700">{formatCurrency(c.renewed_rate)}</span>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                  {filteredContracts.length === 0 && (
                    <TableRow><TableCell colSpan={6} className="text-center text-sm text-muted-foreground py-6">No contracts for the selected centers.</TableCell></TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
            {filteredContracts.length > CONTRACTS_PAGE_SIZE && (
              <button
                type="button"
                className="mt-3 w-full text-center text-xs font-medium text-primary hover:underline"
                onClick={() => setShowAllContracts((v) => !v)}
              >
                {showAllContracts ? "Show fewer" : `View all ${filteredContracts.length} contracts in this projection →`}
              </button>
            )}
          </CardContent>
        </Card>
      </div>

      {data && (
        <ProjectionAdjustmentsPanel
          adjustments={data.adjustments}
          contracts={data.contracts}
          onChanged={refetch}
        />
      )}
    </div>
  );
}
