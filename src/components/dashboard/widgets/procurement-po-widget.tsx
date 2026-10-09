"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Loader2 } from "lucide-react";
import { Bar, BarChart, CartesianGrid, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCurrency, cn } from "@/lib/utils";
import { fyLabel, fyStartYearOf } from "@/lib/sales-widget";
import {
  PO_WIDGET_DEPARTMENTS,
  PO_WIDGET_DEPARTMENT_COLORS,
  PO_WIDGET_DEPARTMENT_LABELS,
  PO_WIDGET_STATES,
  PO_WIDGET_STATE_COLORS,
  PO_WIDGET_STATE_LABELS,
  gradeBudget,
  type BudgetGrade,
  type PoWidgetDepartment,
  type PoWidgetState,
} from "@/lib/procurement-widget";

type Cells = Record<string, Record<string, Record<string, { v: number; n: number }>>>;
interface Summary {
  fy: number;
  today: string;
  months: string[];
  cells: Cells;
  budget: {
    monthly: Record<string, number | null>;
    amc_annual: number | null;
    amc_committed: number;
    committed_by_month: Record<string, Record<string, number>>;
  } | null;
}
interface PoDoc {
  id: string;
  po_number: string;
  vendor: string;
  department: PoWidgetDepartment;
  state: PoWidgetState;
  value: number;
  value_with_gst: number;
  advance: number;
}
interface Company { id: string; brand_name: string }

type Stack = "state" | "department";

const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const monthShort = (key: string) => MONTH_SHORT[Number(key.slice(5, 7)) - 1];
const monthLong = (key: string) => `${monthShort(key)} ${key.slice(0, 4)}`;

function compactInr(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e7) return `₹${(v / 1e7).toFixed(2)}Cr`;
  if (a >= 1e5) return `₹${(v / 1e5).toFixed(1)}L`;
  if (a >= 1e3) return `₹${(v / 1e3).toFixed(0)}K`;
  return `₹${Math.round(v)}`;
}

const GRADE_CLASS: Record<BudgetGrade, string> = {
  ok: "bg-emerald-50 text-emerald-700",
  warn: "bg-amber-50 text-amber-700",
  over: "bg-red-50 text-red-700",
  none: "text-muted-foreground",
};
const GRADE_BAR: Record<BudgetGrade, string> = { ok: "#1D9E75", warn: "#EF9F27", over: "#E24B4A", none: "#9AA5B1" };

const STATE_GROUPS: { label: string; states: PoWidgetState[]; tone?: "warn" }[] = [
  { label: "Awaiting goods", states: ["pending", "ordered", "part_recv"] },
  { label: "Received, awaiting invoice", states: ["recv"] },
  { label: "Invoiced, yet to pay", states: ["inv", "inv_ok", "part_paid"], tone: "warn" },
  { label: "Paid in full", states: ["paid"] },
];

interface Props {
  locationFilter: string | null;
}

export function ProcurementPoWidget({ locationFilter }: Props) {
  const currentFy = fyStartYearOf(new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10));
  const [fy, setFy] = useState(currentFy);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [companyId, setCompanyId] = useState("");
  const [deptFilter, setDeptFilter] = useState<PoWidgetDepartment | "">("");
  const [stack, setStack] = useState<Stack>("state");
  const [hidden, setHidden] = useState<Set<string>>(new Set(["cancelled"]));
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [forbidden, setForbidden] = useState(false);

  const [month, setMonth] = useState<string | null>(null);
  const [selState, setSelState] = useState<PoWidgetState | null>(null);
  const [selDept, setSelDept] = useState<PoWidgetDepartment | null>(null);
  const [docs, setDocs] = useState<{ rows: PoDoc[]; total: number; totalValue: number } | null>(null);
  const [docsLoading, setDocsLoading] = useState(false);
  const barClicked = useRef(false);

  useEffect(() => {
    fetch("/api/companies")
      .then((r) => r.json())
      .then((j) => setCompanies(j.data || []))
      .catch(() => setCompanies([]));
  }, []);

  const loadSummary = useCallback(async () => {
    setLoading(true);
    setFailed(false);
    try {
      const qs = new URLSearchParams({ fy: String(fy) });
      if (companyId) qs.set("company_id", companyId);
      if (locationFilter) qs.set("location_id", locationFilter);
      const res = await fetch(`/api/dashboard/procurement-po?${qs}`);
      if (res.status === 403) { setForbidden(true); return; }
      if (!res.ok) throw new Error(String(res.status));
      setSummary((await res.json()).data);
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, [fy, companyId, locationFilter]);

  useEffect(() => {
    setMonth(null); setSelState(null); setSelDept(null);
    loadSummary();
  }, [loadSummary]);

  const docsReq = useRef(0);
  const hasSelection = month != null || selState != null || selDept != null;
  useEffect(() => {
    if (!hasSelection) { setDocs(null); return; }
    const id = ++docsReq.current;
    setDocsLoading(true);
    const qs = new URLSearchParams({ fy: String(fy), view: "documents" });
    if (month) qs.set("month", month);
    if (selState) qs.set("state", selState);
    const dept = selDept ?? (deptFilter || null);
    if (dept) qs.set("department", dept);
    if (companyId) qs.set("company_id", companyId);
    if (locationFilter) qs.set("location_id", locationFilter);
    fetch(`/api/dashboard/procurement-po?${qs}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((j) => { if (id === docsReq.current) setDocs({ rows: j.data.documents, total: j.data.total_count, totalValue: j.data.total_value }); })
      .catch(() => { if (id === docsReq.current) setDocs({ rows: [], total: 0, totalValue: 0 }); })
      .finally(() => { if (id === docsReq.current) setDocsLoading(false); });
  }, [hasSelection, month, selState, selDept, deptFilter, fy, companyId, locationFilter]);

  const seriesKeys: string[] = stack === "state" ? [...PO_WIDGET_STATES] : [...PO_WIDGET_DEPARTMENTS];
  const labelOf = (k: string) =>
    stack === "state" ? PO_WIDGET_STATE_LABELS[k as PoWidgetState] : PO_WIDGET_DEPARTMENT_LABELS[k as PoWidgetDepartment];
  const colorOf = (k: string) =>
    stack === "state" ? PO_WIDGET_STATE_COLORS[k as PoWidgetState] : PO_WIDGET_DEPARTMENT_COLORS[k as PoWidgetDepartment];
  const shownKeys = seriesKeys.filter((k) => !hidden.has(k));

  /** PO value in a month, optionally narrowed to one state and/or department. */
  const value = useCallback(
    (m: string, opts: { state?: string; dept?: string } = {}) => {
      const byDept = summary?.cells[m] ?? {};
      let t = 0;
      for (const [d, byState] of Object.entries(byDept)) {
        if (opts.dept && d !== opts.dept) continue;
        if (!opts.dept && deptFilter && d !== deptFilter) continue;
        for (const [s, c] of Object.entries(byState)) {
          if (opts.state ? s !== opts.state : false) continue;
          t += c.v;
        }
      }
      return t;
    },
    [summary, deptFilter]
  );

  const chartData = useMemo(
    () =>
      (summary?.months ?? []).map((m) => {
        const row: Record<string, string | number> = { key: m, label: monthShort(m) };
        for (const k of seriesKeys) {
          row[k] = stack === "state" ? value(m, { state: k }) : value(m, { dept: k });
        }
        return row;
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [summary, stack, value]
  );

  const totals = useMemo(() => {
    const t: Record<string, number> = {};
    let n = 0;
    for (const m of summary?.months ?? []) {
      for (const [d, byState] of Object.entries(summary?.cells[m] ?? {})) {
        if (deptFilter && d !== deptFilter) continue;
        for (const [s, c] of Object.entries(byState)) {
          t[s] = (t[s] ?? 0) + c.v;
          if (s !== "cancelled") n += c.n;
        }
      }
    }
    return { byState: t, count: n };
  }, [summary, deptFilter]);

  const issued = Object.entries(totals.byState).filter(([s]) => s !== "cancelled").reduce((a, [, v]) => a + v, 0);
  const groupSum = (states: PoWidgetState[]) => states.reduce((a, s) => a + (totals.byState[s] ?? 0), 0);

  const budget = summary?.budget ?? null;
  const dBudget = deptFilter && budget ? budget.monthly[deptFilter] : null;
  const todayMonth = summary?.today.slice(0, 7) ?? "";

  function toggleKey(k: string) {
    setHidden((prev) => { const n = new Set(prev); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  }
  function switchStack(s: Stack) {
    setStack(s);
    setHidden(s === "state" ? new Set(["cancelled"]) : new Set());
    setSelState(null); setSelDept(null);
  }
  function resetTo(level: number) {
    if (level === 0) { setMonth(null); setSelState(null); setSelDept(null); }
    else if (level === 1 && month) { setSelState(null); setSelDept(null); }
    else { setSelState(null); }
  }

  if (forbidden) return null;

  const crumbs: string[] = [fyLabel(fy)];
  if (month) crumbs.push(monthLong(month));
  if (selDept) crumbs.push(PO_WIDGET_DEPARTMENT_LABELS[selDept]);
  if (selState) crumbs.push(PO_WIDGET_STATE_LABELS[selState]);

  // Budget context for the panel: only meaningful for a single department.
  const panelDept = (selDept ?? (deptFilter || null)) as PoWidgetDepartment | null;

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="text-base">Procurement · POs issued · {fyLabel(fy)}</CardTitle>
            <p className="mt-0.5 text-xs text-muted-foreground">Value of purchase orders (before GST) by month of issue, with their current state</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <select aria-label="Company" value={companyId} onChange={(e) => setCompanyId(e.target.value)} className="h-8 rounded-md border bg-background px-2 text-xs">
              <option value="">All companies</option>
              {companies.map((c) => <option key={c.id} value={c.id}>{c.brand_name}</option>)}
            </select>
            <select aria-label="Department" value={deptFilter} onChange={(e) => { setDeptFilter(e.target.value as PoWidgetDepartment | ""); setSelDept(null); }} className="h-8 rounded-md border bg-background px-2 text-xs">
              <option value="">All departments</option>
              {PO_WIDGET_DEPARTMENTS.map((d) => <option key={d} value={d}>{PO_WIDGET_DEPARTMENT_LABELS[d]}</option>)}
            </select>
            <select aria-label="Financial year" value={fy} onChange={(e) => setFy(Number(e.target.value))} className="h-8 rounded-md border bg-background px-2 text-xs">
              {[currentFy, currentFy - 1, currentFy - 2].map((y) => <option key={y} value={y}>{fyLabel(y)}</option>)}
            </select>
            <div className="flex overflow-hidden rounded-md border" role="tablist" aria-label="Stack by">
              {(["state", "department"] as Stack[]).map((s) => (
                <button key={s} role="tab" aria-selected={stack === s} onClick={() => switchStack(s)}
                  className={cn("px-3 py-1.5 text-xs transition-colors", stack === s ? "bg-muted font-medium" : "text-muted-foreground hover:bg-muted/50")}>
                  {s === "state" ? "PO state" : "Department"}
                </button>
              ))}
            </div>
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-3">
        {loading && !summary ? (
          <div className="flex h-72 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
        ) : failed || !summary ? (
          <div className="flex h-40 flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
            Couldn&apos;t load procurement data.
            <button onClick={loadSummary} className="text-xs underline underline-offset-2">Retry</button>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-2 md:grid-cols-5">
              <Kpi label="POs issued (FY to date)" value={compactInr(issued)} sub={`${totals.count} POs`} />
              {STATE_GROUPS.map((g) => (
                <Kpi key={g.label} label={g.label} value={compactInr(groupSum(g.states))} tone={g.tone} />
              ))}
            </div>

            <div className="flex flex-wrap gap-1.5">
              {seriesKeys.map((k) => (
                <button key={k} onClick={() => toggleKey(k)} aria-pressed={!hidden.has(k)}
                  className={cn("flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs transition-opacity", hidden.has(k) && "opacity-35")}>
                  <span className="h-2 w-2 rounded-sm" style={{ background: colorOf(k) }} />
                  {labelOf(k)}
                </button>
              ))}
            </div>

            <div className={cn("h-72 w-full text-muted-foreground", loading && "opacity-60")}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={chartData}
                  margin={{ top: 4, right: 4, left: 0, bottom: 0 }}
                  onClick={(state) => {
                    if (barClicked.current) { barClicked.current = false; return; }
                    const idx = state?.activeTooltipIndex;
                    const m = typeof idx === "number" ? summary.months[idx] : null;
                    if (m && m <= todayMonth) { setMonth(m); setSelState(null); setSelDept(null); }
                  }}
                >
                  <CartesianGrid vertical={false} stroke="currentColor" strokeOpacity={0.12} />
                  <XAxis dataKey="label" tickLine={false} axisLine={false} tick={{ fill: "currentColor", fontSize: 12 }} />
                  <YAxis tickLine={false} axisLine={false} width={52} tickFormatter={compactInr} tick={{ fill: "currentColor", fontSize: 11 }} />
                  <Tooltip
                    cursor={{ fill: "currentColor", fillOpacity: 0.06 }}
                    formatter={(v, name) => [formatCurrency(Number(v)), labelOf(String(name))]}
                    labelFormatter={(_, payload) => {
                      const k = (payload?.[0]?.payload as { key?: string } | undefined)?.key;
                      const tot = k ? shownKeys.reduce((a, s) => a + (stack === "state" ? value(k, { state: s }) : value(k, { dept: s })), 0) : 0;
                      return k ? `${monthLong(k)} · total ${formatCurrency(tot)}` : "";
                    }}
                    contentStyle={{ fontSize: 12, borderRadius: 8 }}
                  />
                  {dBudget ? <ReferenceLine y={dBudget} stroke="#E24B4A" strokeDasharray="6 4" strokeWidth={2} label={{ value: "Monthly budget", position: "insideTopRight", fill: "#E24B4A", fontSize: 11 }} /> : null}
                  {shownKeys.map((k) => (
                    <Bar key={k} dataKey={k} stackId="po" fill={colorOf(k)} cursor="pointer"
                      onClick={(d: unknown) => {
                        const key = (d as { payload?: { key?: string } })?.payload?.key;
                        if (!key) return;
                        barClicked.current = true;
                        setMonth(key);
                        if (stack === "state") { setSelState(k as PoWidgetState); setSelDept(null); }
                        else { setSelDept(k as PoWidgetDepartment); setSelState(null); }
                      }} />
                  ))}
                </BarChart>
              </ResponsiveContainer>
            </div>
            <p className="text-[11px] text-muted-foreground">
              Click a bar for that month · a coloured segment to jump to that {stack === "state" ? "state" : "department"} · a legend chip to hide it.
              {dBudget ? ` Dashed line = ${PO_WIDGET_DEPARTMENT_LABELS[deptFilter as PoWidgetDepartment]} monthly budget.` : ""}
            </p>

            <BudgetGrid summary={summary} companyId={companyId} onPick={(m, d) => { setMonth(m); setSelDept(d); setSelState(null); }} />

            <div>
              <div className="mb-1 text-sm font-medium">Department × state, whole financial year</div>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b text-muted-foreground">
                      <th className="px-1.5 py-1 text-left font-normal">Department</th>
                      {PO_WIDGET_STATES.filter((s) => s !== "cancelled").map((s) => <th key={s} className="px-1.5 py-1 text-right font-normal">{PO_WIDGET_STATE_LABELS[s]}</th>)}
                      <th className="px-1.5 py-1 text-right font-normal">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {PO_WIDGET_DEPARTMENTS.filter((d) => !deptFilter || d === deptFilter).map((d) => {
                      const sumState = (s: string) => summary.months.reduce((a, m) => a + (summary.cells[m]?.[d]?.[s]?.v ?? 0), 0);
                      const total = PO_WIDGET_STATES.filter((s) => s !== "cancelled").reduce((a, s) => a + sumState(s), 0);
                      if (total === 0) return null;
                      return (
                        <tr key={d} className="border-b last:border-0">
                          <td className="px-1.5 py-1.5"><span className="mr-1.5 inline-block h-2 w-2 rounded-sm" style={{ background: PO_WIDGET_DEPARTMENT_COLORS[d] }} />{PO_WIDGET_DEPARTMENT_LABELS[d]}</td>
                          {PO_WIDGET_STATES.filter((s) => s !== "cancelled").map((s) => {
                            const v = sumState(s);
                            return (
                              <td key={s} className={cn("px-1.5 py-1.5 text-right tabular-nums", v > 0 && "cursor-pointer hover:bg-muted/60")}
                                onClick={() => { if (v > 0) { setMonth(null); setSelDept(d); setSelState(s); } }}>
                                {v > 0 ? compactInr(v) : "–"}
                              </td>
                            );
                          })}
                          <td className="px-1.5 py-1.5 text-right font-medium tabular-nums">{compactInr(total)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>

            {hasSelection && (
              <div className="rounded-lg border p-3">
                <nav className="mb-2 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground" aria-label="Drill-down">
                  {crumbs.map((c, i) => (
                    <span key={i} className="flex items-center gap-1.5">
                      {i > 0 && <span>›</span>}
                      {i < crumbs.length - 1
                        ? <button className="text-blue-600 hover:underline" onClick={() => resetTo(i)}>{c}</button>
                        : <b className="font-medium text-foreground">{c}</b>}
                    </span>
                  ))}
                </nav>

                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <div className="text-sm font-medium">{docs ? `${docs.total} purchase orders` : "Purchase orders"}</div>
                  <div className="text-lg font-semibold tabular-nums">{docs ? formatCurrency(docs.totalValue) : ""}</div>
                </div>

                {panelDept && <PanelBudget summary={summary} dept={panelDept} month={month} companyId={companyId} />}

                <div className="mt-3 overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b text-left text-muted-foreground">
                        <th className="px-1.5 py-1 font-normal">PO</th>
                        <th className="px-1.5 py-1 font-normal">Vendor</th>
                        <th className="px-1.5 py-1 font-normal">Department</th>
                        <th className="px-1.5 py-1 font-normal">State</th>
                        <th className="px-1.5 py-1 text-right font-normal">Value</th>
                        <th className="px-1.5 py-1 text-right font-normal">Incl. GST</th>
                      </tr>
                    </thead>
                    <tbody>
                      {docsLoading && !docs ? (
                        <tr><td colSpan={6} className="py-4 text-center"><Loader2 className="mx-auto h-4 w-4 animate-spin text-muted-foreground" /></td></tr>
                      ) : (docs?.rows ?? []).length === 0 ? (
                        <tr><td colSpan={6} className="py-4 text-center text-muted-foreground">Nothing to show for this selection.</td></tr>
                      ) : docs!.rows.map((d) => (
                        <tr key={d.id} className="border-b last:border-0 hover:bg-muted/40">
                          <td className="px-1.5 py-1.5 font-mono"><Link href={`/procurement/orders/${d.id}`} className="text-blue-600 hover:underline">{d.po_number}</Link></td>
                          <td className="px-1.5 py-1.5">{d.vendor}</td>
                          <td className="px-1.5 py-1.5">{PO_WIDGET_DEPARTMENT_LABELS[d.department]}</td>
                          <td className="px-1.5 py-1.5">
                            <span className="rounded-full bg-muted px-2 py-0.5 text-[11px]" style={{ borderLeft: `3px solid ${PO_WIDGET_STATE_COLORS[d.state]}` }}>{PO_WIDGET_STATE_LABELS[d.state]}</span>
                            {d.advance > 0 && <span className="ml-1 text-[10px] text-muted-foreground">adv {compactInr(d.advance)}</span>}
                          </td>
                          <td className="px-1.5 py-1.5 text-right tabular-nums">{formatCurrency(d.value)}</td>
                          <td className="px-1.5 py-1.5 text-right tabular-nums text-muted-foreground">{formatCurrency(d.value_with_gst)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {docs && docs.total > docs.rows.length && (
                  <p className="mt-2 text-[11px] text-muted-foreground">Showing the largest {docs.rows.length} of {docs.total} POs.</p>
                )}
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function Kpi({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "warn" }) {
  return (
    <div className="rounded-md bg-muted/50 px-3 py-2">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className={cn("mt-0.5 text-base font-semibold tabular-nums", tone === "warn" && "text-amber-600")}>{value}</div>
      {sub && <div className="text-[11px] text-muted-foreground">{sub}</div>}
    </div>
  );
}

/**
 * Department × month budget grid. Spend here is committed material requests in
 * the month the request was created — the same basis as the Procurement budget
 * screen — so the two never disagree. It is deliberately not PO value.
 */
function BudgetGrid({ summary, companyId, onPick }: { summary: Summary; companyId: string; onPick: (month: string, dept: PoWidgetDepartment) => void }) {
  const b = summary.budget;
  const months = summary.months.filter((m) => m <= summary.today.slice(0, 7));
  const depts = PO_WIDGET_DEPARTMENTS.filter((d) => d !== "other");

  return (
    <div>
      <div className="mb-1 text-sm font-medium">Budget vs spend — department × month</div>
      {!companyId || !b ? (
        <p className="rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
          Department budgets are set per company. Choose a company above to see them against spend.
        </p>
      ) : (
        <>
          <p className="mb-1.5 text-[11px] text-muted-foreground">
            Approved material requests ÷ monthly budget, by month the request was raised (as on the Procurement budget screen).
            <span className="ml-1 rounded bg-emerald-50 px-1.5 text-emerald-700">under 80%</span>
            <span className="ml-1 rounded bg-amber-50 px-1.5 text-amber-700">80–100%</span>
            <span className="ml-1 rounded bg-red-50 px-1.5 text-red-700">over</span>
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b text-muted-foreground">
                  <th className="px-1.5 py-1 text-left font-normal">Department</th>
                  <th className="px-1.5 py-1 text-left font-normal">Budget</th>
                  {months.map((m) => <th key={m} className="px-1 py-1 text-center font-normal">{monthShort(m)}</th>)}
                  <th className="px-1.5 py-1 text-center font-normal">FY to date</th>
                </tr>
              </thead>
              <tbody>
                {depts.map((d) => {
                  const monthly = b.monthly[d];
                  const isAmc = d === "amc";
                  const spendIn = (m: string) => b.committed_by_month[m]?.[d] ?? 0;
                  const ytd = months.reduce((a, m) => a + spendIn(m), 0);
                  return (
                    <tr key={d} className="border-b last:border-0">
                      <td className="px-1.5 py-1.5"><span className="mr-1.5 inline-block h-2 w-2 rounded-sm" style={{ background: PO_WIDGET_DEPARTMENT_COLORS[d] }} />{PO_WIDGET_DEPARTMENT_LABELS[d]}</td>
                      <td className="px-1.5 py-1.5 text-muted-foreground">
                        {isAmc ? (b.amc_annual ? `${compactInr(b.amc_annual)} / yr` : "Not set") : monthly ? `${compactInr(monthly)} / mo` : "Not set"}
                      </td>
                      {months.map((m) => {
                        const u = spendIn(m);
                        const grade = isAmc ? "none" : gradeBudget(u, monthly);
                        return (
                          <td key={m} className={cn("cursor-pointer px-1 py-1 text-center leading-tight tabular-nums", GRADE_CLASS[grade])} onClick={() => onPick(m, d)}>
                            {isAmc ? "–" : compactInr(u)}
                            <div className="text-[10px] opacity-75">{!isAmc && monthly ? `${Math.round((u / monthly) * 100)}%` : isAmc ? "annual" : "no budget"}</div>
                          </td>
                        );
                      })}
                      {(() => {
                        const spent = isAmc ? b.amc_committed : ytd;
                        const budget = isAmc ? b.amc_annual : monthly ? monthly * months.length : null;
                        const grade = gradeBudget(spent, budget);
                        return (
                          <td className={cn("px-1.5 py-1 text-center leading-tight tabular-nums", GRADE_CLASS[grade])}>
                            {compactInr(spent)}
                            <div className="text-[10px] opacity-75">{budget ? `${Math.round((spent / budget) * 100)}% of ${compactInr(budget)}` : "no budget"}</div>
                          </td>
                        );
                      })()}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

function PanelBudget({ summary, dept, month, companyId }: { summary: Summary; dept: PoWidgetDepartment; month: string | null; companyId: string }) {
  const b = summary.budget;
  if (!companyId || !b || dept === "other") return null;
  const label = PO_WIDGET_DEPARTMENT_LABELS[dept];

  if (dept === "amc") {
    if (!b.amc_annual) return <p className="mt-2 text-xs text-muted-foreground">{label} has no annual budget set.</p>;
    const pct = (b.amc_committed / b.amc_annual) * 100;
    return <BudgetBar title={`${label} annual budget`} spent={b.amc_committed} budget={b.amc_annual} pct={pct} />;
  }
  const monthly = b.monthly[dept];
  if (!monthly) return <p className="mt-2 text-xs text-muted-foreground">{label} has no monthly budget set.</p>;
  if (!month) return null;
  const spent = b.committed_by_month[month]?.[dept] ?? 0;
  return <BudgetBar title={`${label} · ${monthLong(month)} budget`} spent={spent} budget={monthly} pct={(spent / monthly) * 100} />;
}

function BudgetBar({ title, spent, budget, pct }: { title: string; spent: number; budget: number; pct: number }) {
  const grade = gradeBudget(spent, budget);
  return (
    <div className="mt-2 text-xs">
      <div>
        <b className="font-medium">{title}</b> · {compactInr(spent)} of {compactInr(budget)} approved ({Math.round(pct)}%)
        {grade === "over"
          ? <span className="ml-2 rounded-full bg-red-50 px-2 py-0.5 text-red-700">{compactInr(spent - budget)} over</span>
          : <span className="ml-2 rounded-full bg-emerald-50 px-2 py-0.5 text-emerald-700">{compactInr(budget - spent)} left</span>}
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden>
        <div className="h-full" style={{ width: `${Math.min(100, pct)}%`, background: GRADE_BAR[grade] }} />
      </div>
    </div>
  );
}
