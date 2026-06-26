"use client";

import { useState, useEffect, useMemo, useCallback } from "react";
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  PieChart, Pie, Cell, AreaChart, Area,
} from "recharts";
import {
  Package, IndianRupee, AlertTriangle, TrendingDown, Loader2, Boxes, CalendarClock,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { formatCurrency } from "@/lib/utils";
import { PROCUREMENT_DEPARTMENT_LABELS } from "@/lib/constants";

const DEPT_COLORS: Record<string, string> = {
  pantry: "#10b981", maintenance: "#6366f1", asset: "#f59e0b", administration: "#94a3b8", amc: "#a78bfa", other: "#cbd5e1",
};
const STATUS_COLORS = { ok: "#22c55e", low: "#f59e0b", out: "#ef4444" };
const AGE_COLORS = ["#22c55e", "#eab308", "#f97316", "#ef4444"]; // fresh → old

interface Analytics {
  period: { from: string; to: string; days: number; bucket: string };
  holding: {
    itemCount: number; totalUnits: number; totalValue: number; unpricedCount: number;
    status: { ok: number; low: number; out: number };
    byDepartment: { department: string; items: number; units: number; value: number }[];
    topByValue: { name: string; department: string; qty: number; unit: string; value: number }[];
  };
  needsAttention: {
    belowReorder: { name: string; qty: number; reorder_level: number; unit: string; department: string }[];
    predictedStockouts: { name: string; qty: number; unit: string; avgDaily: number; daysOfCover: number | null }[];
    deadStock: { name: string; department: string; qty: number; unit: string; value: number }[];
    hasConsumption: boolean;
  };
  consumption: {
    logCount: number; totalUnits: number; totalValue: number; avgDaysOfCover: number | null;
    trend: { date: string; units: number; value: number }[];
    topItems: { name: string; unit: string; units: number; value: number }[];
    byDepartment: { department: string; units: number; value: number }[];
    hasData: boolean;
  };
  aging: {
    hasInwardData: boolean;
    buckets: { label: string; count: number; value: number }[];
    oldValue: number;
    oldCount: number;
    oldest: { name: string; department: string; ageDays: number; qty: number; unit: string; value: number; status: string }[];
  };
}

const deptLabel = (d: string) => PROCUREMENT_DEPARTMENT_LABELS[d] ?? d;

function Kpi({ icon: Icon, label, value, sub, tone }: { icon: React.ElementType; label: string; value: string; sub?: string; tone?: string }) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center gap-2 text-muted-foreground text-xs mb-1">
          <Icon className="h-3.5 w-3.5" /> {label}
        </div>
        <div className={`text-2xl font-bold ${tone ?? ""}`}>{value}</div>
        {sub && <div className="text-[11px] text-muted-foreground mt-0.5">{sub}</div>}
      </CardContent>
    </Card>
  );
}

export function InventoryAnalytics({ locationId, locationName }: { locationId: string; locationName?: string }) {
  const [preset, setPreset] = useState<"30" | "90" | "custom">("30");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [data, setData] = useState<Analytics | null>(null);
  const [loading, setLoading] = useState(true);

  const range = useMemo(() => {
    const to = preset === "custom" && customTo ? new Date(customTo) : new Date();
    const from =
      preset === "custom" && customFrom
        ? new Date(customFrom)
        : new Date(to.getTime() - (preset === "90" ? 90 : 30) * 86400000);
    return { from: from.toISOString(), to: to.toISOString() };
  }, [preset, customFrom, customTo]);

  const fetchData = useCallback(async () => {
    if (!locationId) return;
    setLoading(true);
    try {
      const params = new URLSearchParams({ location_id: locationId, from: range.from, to: range.to });
      const res = await fetch(`/api/procurement/inventory/analytics?${params}`, { cache: "no-store" });
      if (res.ok) setData(await res.json());
    } finally {
      setLoading(false);
    }
  }, [locationId, range.from, range.to]);

  useEffect(() => { fetchData(); }, [fetchData]);

  if (loading && !data) {
    return <div className="flex items-center justify-center py-16"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>;
  }
  if (!data) return null;

  const { holding, needsAttention, consumption, aging } = data;
  const valLabel = (v: number) => formatCurrency(v);
  const deptHoldingChart = holding.byDepartment.map((d) => ({ name: deptLabel(d.department), value: Math.round(d.value), units: d.units, color: DEPT_COLORS[d.department] ?? DEPT_COLORS.other }));
  const statusChart = [
    { name: "OK", value: holding.status.ok, color: STATUS_COLORS.ok },
    { name: "Low", value: holding.status.low, color: STATUS_COLORS.low },
    { name: "Out", value: holding.status.out, color: STATUS_COLORS.out },
  ].filter((s) => s.value > 0);

  return (
    <div className="space-y-5">
      {/* Period selector */}
      <div className="flex items-center gap-2 flex-wrap">
        <CalendarClock className="h-4 w-4 text-muted-foreground" />
        {(["30", "90", "custom"] as const).map((p) => (
          <Button key={p} size="sm" variant={preset === p ? "default" : "outline"} onClick={() => setPreset(p)}>
            {p === "30" ? "Last 30 days" : p === "90" ? "Last 90 days" : "Custom"}
          </Button>
        ))}
        {preset === "custom" && (
          <div className="flex items-center gap-2">
            <Input type="date" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)} className="w-40 h-9" />
            <span className="text-muted-foreground text-sm">to</span>
            <Input type="date" value={customTo} onChange={(e) => setCustomTo(e.target.value)} className="w-40 h-9" />
          </div>
        )}
        <span className="text-xs text-muted-foreground ml-auto">{locationName ?? "Location"} · last {data.period.days} days</span>
      </div>

      {/* KPI cards */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        <Kpi icon={Boxes} label="Items tracked" value={String(holding.itemCount)} />
        <Kpi icon={IndianRupee} label="Stock value held" value={valLabel(holding.totalValue)} sub={holding.unpricedCount ? `${holding.unpricedCount} unpriced` : undefined} />
        <Kpi icon={AlertTriangle} label="Low stock" value={String(holding.status.low)} tone={holding.status.low ? "text-amber-600" : ""} />
        <Kpi icon={AlertTriangle} label="Out of stock" value={String(holding.status.out)} tone={holding.status.out ? "text-red-600" : ""} />
        <Kpi icon={Package} label="Consumed (period)" value={consumption.hasData ? `${consumption.totalUnits} u` : "—"} sub={consumption.hasData ? valLabel(consumption.totalValue) : "no logs yet"} />
        <Kpi icon={TrendingDown} label="Avg days of cover" value={consumption.avgDaysOfCover != null ? `${consumption.avgDaysOfCover}d` : "—"} sub={consumption.avgDaysOfCover == null ? "needs usage data" : undefined} />
      </div>

      {/* Needs attention */}
      <div className="grid md:grid-cols-3 gap-4">
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm flex items-center gap-2"><AlertTriangle className="h-4 w-4 text-amber-500" /> Reorder now ({needsAttention.belowReorder.length})</CardTitle></CardHeader>
          <CardContent className="text-sm">
            {needsAttention.belowReorder.length === 0 ? (
              <p className="text-muted-foreground text-xs">Nothing at or below reorder level. 👍</p>
            ) : (
              <ul className="space-y-1.5">
                {needsAttention.belowReorder.slice(0, 8).map((i, k) => (
                  <li key={k} className="flex items-center justify-between gap-2">
                    <span className="truncate">{i.name}</span>
                    <span className={`text-xs shrink-0 ${i.qty === 0 ? "text-red-600" : "text-amber-600"}`}>{i.qty}/{i.reorder_level} {i.unit}</span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm flex items-center gap-2"><CalendarClock className="h-4 w-4 text-indigo-500" /> Running out soon</CardTitle></CardHeader>
          <CardContent className="text-sm">
            {needsAttention.predictedStockouts.length === 0 ? (
              <p className="text-muted-foreground text-xs">{consumption.hasData ? "No imminent stockouts in the next 14 days." : "Needs consumption history to predict."}</p>
            ) : (
              <ul className="space-y-1.5">
                {needsAttention.predictedStockouts.map((i, k) => (
                  <li key={k} className="flex items-center justify-between gap-2">
                    <span className="truncate">{i.name}</span>
                    <span className="text-xs shrink-0 text-indigo-600">~{i.daysOfCover}d left</span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm flex items-center gap-2"><Boxes className="h-4 w-4 text-slate-500" /> Slow / dead stock</CardTitle></CardHeader>
          <CardContent className="text-sm">
            {!consumption.hasData ? (
              <p className="text-muted-foreground text-xs">Needs consumption history.</p>
            ) : needsAttention.deadStock.length === 0 ? (
              <p className="text-muted-foreground text-xs">All stocked items saw some usage. 👍</p>
            ) : (
              <ul className="space-y-1.5">
                {needsAttention.deadStock.slice(0, 8).map((i, k) => (
                  <li key={k} className="flex items-center justify-between gap-2">
                    <span className="truncate">{i.name}</span>
                    <span className="text-xs shrink-0 text-muted-foreground">{i.qty} {i.unit} · {valLabel(i.value)}</span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Holding breakdown */}
      <div className="grid md:grid-cols-2 gap-4">
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm">Holding value by department</CardTitle></CardHeader>
          <CardContent>
            {deptHoldingChart.length === 0 ? <p className="text-xs text-muted-foreground py-8 text-center">No stock at this location.</p> : (
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={deptHoldingChart} layout="vertical" margin={{ left: 10, right: 20 }}>
                  <CartesianGrid strokeDasharray="3 3" horizontal={false} />
                  <XAxis type="number" tickFormatter={(v) => `₹${v >= 1000 ? (v / 1000).toFixed(0) + "k" : v}`} fontSize={11} />
                  <YAxis type="category" dataKey="name" width={90} fontSize={11} />
                  <Tooltip formatter={(v) => valLabel(Number(v) || 0)} />
                  <Bar dataKey="value" radius={[0, 4, 4, 0]}>
                    {deptHoldingChart.map((d, i) => <Cell key={i} fill={d.color} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm">Stock status</CardTitle></CardHeader>
          <CardContent>
            {statusChart.length === 0 ? <p className="text-xs text-muted-foreground py-8 text-center">No stock.</p> : (
              <ResponsiveContainer width="100%" height={220}>
                <PieChart>
                  <Pie data={statusChart} dataKey="value" nameKey="name" cx="50%" cy="50%" innerRadius={50} outerRadius={80} label={(e) => `${e.name}: ${e.value}`}>
                    {statusChart.map((s, i) => <Cell key={i} fill={s.color} />)}
                  </Pie>
                  <Tooltip />
                </PieChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Top holdings by value */}
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-sm">Top items by value held</CardTitle></CardHeader>
        <CardContent>
          {holding.topByValue.filter((t) => t.value > 0).length === 0 ? (
            <p className="text-xs text-muted-foreground py-4">No priced stock to rank. Set item prices in the catalog to see value.</p>
          ) : (
            <div className="space-y-1.5">
              {holding.topByValue.filter((t) => t.value > 0).map((t, k) => (
                <div key={k} className="flex items-center justify-between gap-2 text-sm">
                  <span className="flex items-center gap-2 min-w-0">
                    <Badge variant="secondary" className="text-[10px]" style={{ backgroundColor: (DEPT_COLORS[t.department] ?? "#eee") + "22", color: DEPT_COLORS[t.department] }}>{deptLabel(t.department)}</Badge>
                    <span className="truncate">{t.name}</span>
                  </span>
                  <span className="shrink-0 text-muted-foreground">{t.qty} {t.unit} · <span className="font-medium text-foreground">{valLabel(t.value)}</span></span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Stock aging */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center justify-between gap-2">
            <span className="flex items-center gap-2"><CalendarClock className="h-4 w-4 text-amber-500" /> Stock aging (time held)</span>
            {aging.oldCount > 0 && (
              <span className="text-xs font-normal text-red-600">{aging.oldCount} item{aging.oldCount > 1 ? "s" : ""} too old · {valLabel(aging.oldValue)}</span>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {!aging.hasInwardData ? (
            <p className="text-xs text-muted-foreground py-6 text-center">
              No inward dates yet — aging appears once items arrive via PO delivery or transfer.
            </p>
          ) : (
            <div className="grid md:grid-cols-2 gap-6">
              <div>
                <p className="text-xs font-medium text-muted-foreground mb-1">Holding value by age</p>
                <ResponsiveContainer width="100%" height={200}>
                  <BarChart data={aging.buckets}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} />
                    <XAxis dataKey="label" fontSize={11} />
                    <YAxis fontSize={11} tickFormatter={(v) => `₹${v >= 1000 ? (v / 1000).toFixed(0) + "k" : v}`} />
                    <Tooltip formatter={(v) => valLabel(Number(v) || 0)} />
                    <Bar dataKey="value" radius={[4, 4, 0, 0]}>
                      {aging.buckets.map((_, i) => <Cell key={i} fill={AGE_COLORS[i]} />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <div>
                <p className="text-xs font-medium text-muted-foreground mb-2">Oldest stock held</p>
                <div className="space-y-1.5">
                  {aging.oldest.map((o, k) => (
                    <div key={k} className="flex items-center justify-between gap-2 text-sm">
                      <span className="flex items-center gap-2 min-w-0">
                        <Badge variant="secondary" className="text-[10px]" style={{ backgroundColor: (DEPT_COLORS[o.department] ?? "#eee") + "22", color: DEPT_COLORS[o.department] }}>{deptLabel(o.department)}</Badge>
                        <span className="truncate">{o.name}</span>
                      </span>
                      <span className={`text-xs shrink-0 ${o.status === "old" ? "text-red-600 font-medium" : o.status === "watch" ? "text-amber-600" : "text-muted-foreground"}`}>
                        {o.ageDays}d · {valLabel(o.value)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Consumption */}
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-sm">Consumption over time</CardTitle></CardHeader>
        <CardContent>
          {!consumption.hasData ? (
            <div className="py-10 text-center text-sm text-muted-foreground">
              <Package className="h-6 w-6 mx-auto mb-2 opacity-40" />
              No consumption logged in this period yet.<br />
              <span className="text-xs">Once your team logs usage, you&apos;ll see trends, top items, and stockout predictions here.</span>
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={240}>
              <AreaChart data={consumption.trend} margin={{ left: 0, right: 10 }}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="date" fontSize={11} tickFormatter={(d) => d.slice(5)} />
                <YAxis fontSize={11} />
                <Tooltip formatter={(v) => `${Number(v) || 0} units`} />
                <Area type="monotone" dataKey="units" stroke="#6366f1" fill="#6366f1" fillOpacity={0.15} name="units" />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </CardContent>
      </Card>

      {consumption.hasData && consumption.topItems.length > 0 && (
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm">Most consumed items</CardTitle></CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={Math.max(160, consumption.topItems.length * 32)}>
              <BarChart data={consumption.topItems} layout="vertical" margin={{ left: 10, right: 20 }}>
                <CartesianGrid strokeDasharray="3 3" horizontal={false} />
                <XAxis type="number" fontSize={11} />
                <YAxis type="category" dataKey="name" width={120} fontSize={11} />
                <Tooltip />
                <Bar dataKey="units" fill="#10b981" radius={[0, 4, 4, 0]} name="units" />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
