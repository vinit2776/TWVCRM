"use client";

import { useCallback, useEffect, useState } from "react";
import { Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/shared/empty-state";
import { Skeleton } from "@/components/shared/loading-skeleton";
import type { ElectricityMonth, ElectricitySummary } from "@/lib/customer-value/electricity-share";

interface ElectricityData {
  today: string;
  status: "ok" | "no_center" | "no_meter" | "several_meters" | "no_capacity" | "no_readings";
  center: { id: string; name: string } | null;
  capacity: number | null;
  months: ElectricityMonth[];
  summary: ElectricitySummary | null;
}

const NOT_AVAILABLE: Record<Exclude<ElectricityData["status"], "ok">, { title: string; description: string }> = {
  no_center: { title: "No center yet", description: "This customer has no contract at a center, so there is no electricity to share." },
  no_meter: { title: "No meter linked", description: "No OneGrid meter is linked to an electricity connection at this center. Link one under the center's electricity connections." },
  several_meters: { title: "More than one meter", description: "This center has several linked meters, and adding a main meter to a sub-meter would count the same power twice. The share needs one meter that measures the whole center." },
  no_capacity: { title: "No seat count for the center", description: "The center's space units have no seats set, so there is nothing to split the electricity over." },
  no_readings: { title: "No meter readings yet", description: "The meter is linked but the energy ledger holds no readings for the last 12 months." },
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const monthLabel = (ym: string) => `${MONTHS[Number(ym.slice(5, 7)) - 1]} ${ym.slice(2, 4)}`;
const inr = (v: number) => `${v < 0 ? "−" : ""}₹${Math.abs(Math.round(v)).toLocaleString("en-IN")}`;
const kwh = (v: number | null) => (v === null ? "—" : `${Math.round(v).toLocaleString("en-IN")} kWh`);

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="rounded-lg border p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-0.5 text-lg font-semibold tabular-nums">{value}</p>
      {note && <p className="mt-0.5 text-xs text-muted-foreground">{note}</p>}
    </div>
  );
}

function UsageChart({ months }: { months: ElectricityMonth[] }) {
  const W = 640, H = 200, L = 46, R = 12, T = 12, B = 26;
  const totals = months.map((m) => m.centerKwh ?? 0);
  const max = Math.max(...totals, 1);
  const n = months.length;
  const band = (W - L - R) / n;
  const bw = Math.min(34, band * 0.6);
  const y = (v: number) => T + (1 - v / max) * (H - T - B);
  const ticks = [0, Math.round(max / 2), Math.round(max)];
  return (
    <>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Center electricity by month, split into this customer, other customers and vacant seats">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={L} x2={W - R} y1={y(t)} y2={y(t)} stroke="#e5e7eb" />
            <text x={L - 6} y={y(t) + 4} textAnchor="end" fontSize={11} fill="#6b7280">{t.toLocaleString("en-IN")}</text>
          </g>
        ))}
        {months.map((m, i) => {
          const cx = L + (i + 0.5) * band;
          if (m.kwh === null || m.othersKwh === null || m.vacantKwh === null) {
            return (
              <g key={m.month}>
                <text x={cx} y={H - B - 4} textAnchor="middle" fontSize={11} fill="#9ca3af">no data</text>
                <text x={cx} y={H - 6} textAnchor="middle" fontSize={11} fill="#6b7280">{monthLabel(m.month)}</text>
              </g>
            );
          }
          let top = y(0);
          const seg = (v: number, color: string, label: string) => {
            const h = Math.max(0, y(0) - y(v));
            top -= h;
            return <rect x={cx - bw / 2} y={top} width={bw} height={h} fill={color} opacity={m.partial ? 0.55 : 1}><title>{`${monthLabel(m.month)}: ${label} ${Math.round(v).toLocaleString("en-IN")} kWh`}</title></rect>;
          };
          return (
            <g key={m.month}>
              {seg(m.kwh, "#7c3aed", "this customer")}
              {seg(m.othersKwh, "#94a3b8", "other customers")}
              {seg(m.vacantKwh, "#e2e8f0", "vacant seats")}
              {(i % 2 === 0 || i === n - 1) && <text x={cx} y={H - 6} textAnchor="middle" fontSize={11} fill="#6b7280">{monthLabel(m.month)}</text>}
            </g>
          );
        })}
      </svg>
      <div className="mt-1 flex flex-wrap gap-4 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5"><span className="inline-block h-2.5 w-2.5 rounded-sm bg-violet-600" /> This customer</span>
        <span className="flex items-center gap-1.5"><span className="inline-block h-2.5 w-2.5 rounded-sm bg-slate-400" /> Other customers</span>
        <span className="flex items-center gap-1.5"><span className="inline-block h-2.5 w-2.5 rounded-sm bg-slate-200" /> Vacant seats</span>
      </div>
    </>
  );
}

export function ElectricityPanel({ leadId }: { leadId: string }) {
  const [data, setData] = useState<ElectricityData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/leads/${leadId}/value/electricity`, { cache: "no-store" });
      if (!res.ok) throw new Error(res.status === 403 ? "Admins only" : "Could not load electricity");
      setData((await res.json()) as ElectricityData);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load electricity");
    } finally {
      setLoading(false);
    }
  }, [leadId]);

  useEffect(() => {
    load();
  }, [load]);

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-20" />
        <Skeleton className="h-56" />
        <Skeleton className="h-40" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <Card>
        <CardContent className="flex items-center justify-between gap-4 py-6">
          <p className="text-sm text-muted-foreground">{error ?? "Could not load electricity"}</p>
          <Button variant="outline" size="sm" onClick={load}>Retry</Button>
        </CardContent>
      </Card>
    );
  }

  if (data.status !== "ok" || data.months.length === 0) {
    const msg = data.status === "ok"
      ? { title: "No months to show", description: "This customer had no seats at the center in the last 12 months." }
      : NOT_AVAILABLE[data.status];
    return (
      <Card>
        <CardContent>
          <EmptyState icon={Zap} title={msg.title} description={msg.description} />
        </CardContent>
      </Card>
    );
  }

  const { summary, months, center } = data;
  const anyPartial = months.some((m) => m.partial);

  return (
    <div className="space-y-4">
      {summary && (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Stat label={`Share of ${center?.name ?? "the center"}`} value={summary.share === null ? "—" : `${(summary.share * 100).toFixed(1)}%`} note={`Average of ${summary.months} completed month${summary.months === 1 ? "" : "s"}, by seats`} />
          <Stat label="Electricity attributed" value={kwh(summary.kwh)} />
          <Stat label="Cost to us" value={summary.months - summary.monthsWithoutBill > 0 ? inr(summary.cost) : "—"} note={summary.monthsWithoutBill > 0 ? (summary.monthsWithoutBill === 1 ? "1 month has no captured bill, so no cost" : `${summary.monthsWithoutBill} months have no captured bill, so no cost`) : undefined} />
          <Stat label="Billed to this customer" value={summary.months - summary.monthsWithoutBill > 0 ? inr(summary.billed) : "—"} note={summary.months - summary.monthsWithoutBill > 0 ? (summary.shortfall > 0 ? `${inr(summary.shortfall)} not recovered` : summary.shortfall < 0 ? `${inr(-summary.shortfall)} more than it cost` : "Covers the cost") : undefined} />
        </div>
      )}

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Where the center&apos;s electricity goes</CardTitle>
          <p className="text-xs text-muted-foreground">
            Monthly kWh from the center&apos;s meter, split by seats over {data.capacity} seats. Seats nobody has contracted are shown as vacant: that is the center&apos;s cost, not any customer&apos;s.
            {anyPartial && " The current month is still running and is lighter."}
          </p>
        </CardHeader>
        <CardContent>
          <UsageChart months={months} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Month by month</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="border-b text-left text-xs text-muted-foreground">
                <th className="py-2 pr-3 font-medium">Month</th>
                <th className="py-2 pr-3 text-right font-medium">Seats</th>
                <th className="py-2 pr-3 text-right font-medium">Share</th>
                <th className="py-2 pr-3 text-right font-medium">Attributed</th>
                <th className="py-2 pr-3 text-right font-medium">Cost to us</th>
                <th className="py-2 pr-3 text-right font-medium">Billed</th>
                <th className="py-2 text-right font-medium">Not recovered</th>
              </tr>
            </thead>
            <tbody>
              {[...months].reverse().map((m) => (
                <tr key={m.month} className="border-b last:border-0">
                  <td className="py-2 pr-3">
                    {monthLabel(m.month)}
                    {m.partial && <span className="ml-1.5 text-xs text-muted-foreground">(so far)</span>}
                    {!m.partial && m.unknownDays > 0 && <span className="ml-1.5 text-xs text-amber-700">{m.unknownDays} day{m.unknownDays === 1 ? "" : "s"} unread</span>}
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums">{Number(m.seats.toFixed(1))}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{m.share === null ? "—" : `${(m.share * 100).toFixed(1)}%`}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{kwh(m.kwh)}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{m.cost === null ? <span className="text-muted-foreground" title="No captured bill for this month">no bill</span> : inr(m.cost)}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{m.cost === null ? "—" : inr(m.billed ?? 0)}</td>
                  <td className={`py-2 text-right tabular-nums ${m.shortfall !== null && m.shortfall > 0 ? "font-medium text-red-700" : ""}`}>{m.shortfall === null ? "—" : inr(m.shortfall)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-3 text-xs text-muted-foreground">
            This is a seats split, so it shows what this customer&apos;s seats cost, not how much power they actually use: every customer at a center gets the same kWh per seat. Cost is kWh times the month&apos;s average rate from the captured landlord bill, so it is an estimate. The seat count is today&apos;s, applied to past months.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
