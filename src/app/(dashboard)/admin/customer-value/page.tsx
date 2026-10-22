"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowDown, ArrowRight, ArrowUp, Gauge } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { EmptyState } from "@/components/shared/empty-state";
import { Skeleton } from "@/components/shared/loading-skeleton";
import { PageBreadcrumb } from "@/components/page-breadcrumb";
import {
  DEFAULT_RENEWING_WITHIN_DAYS,
  SORT_LABELS,
  filterPortfolio,
  sortPortfolio,
  summarisePortfolio,
  type PortfolioRow,
  type PortfolioSort,
  type PortfolioTier,
} from "@/lib/customer-value/portfolio-view";
import { formatCurrency } from "@/lib/utils";

const TIERS: PortfolioTier[] = ["A", "B", "C", "D"];
const TIER_CLASS: Record<PortfolioTier, string> = {
  A: "bg-green-100 text-green-800",
  B: "bg-blue-100 text-blue-800",
  C: "bg-amber-100 text-amber-800",
  D: "bg-red-100 text-red-800",
};
const TONE_CLASS: Record<"risk" | "watch" | "good", string> = {
  risk: "bg-red-100 text-red-800",
  watch: "bg-amber-100 text-amber-800",
  good: "bg-green-100 text-green-800",
};
const INSIGHT_SHORT: Record<string, string> = {
  late_not_service: "Late payer",
  valuable_but_friction: "Valuable, high friction",
  negative_margin: "Loses money",
  shrinking_and_renewing: "Shrinking, renewing",
  pushed_back_and_renewing: "Escalation push-back",
  room_to_raise: "Room to raise rent",
  tier_dropped: "Tier dropped",
  healthy_and_renewing: "Healthy, renew early",
};
const ANY = "any";

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="rounded-lg border p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-0.5 text-lg font-semibold tabular-nums">{value}</p>
      {note && <p className="mt-0.5 text-xs text-muted-foreground">{note}</p>}
    </div>
  );
}

function Change({ value }: { value: number | null }) {
  if (value === null) return <span className="text-muted-foreground">—</span>;
  if (Math.abs(value) < 0.5) return <span className="inline-flex items-center gap-0.5 text-muted-foreground"><ArrowRight className="h-3 w-3" />0</span>;
  return value < 0 ? (
    <span className="inline-flex items-center gap-0.5 text-red-700"><ArrowDown className="h-3 w-3" />{Math.abs(Math.round(value))}</span>
  ) : (
    <span className="inline-flex items-center gap-0.5 text-green-700"><ArrowUp className="h-3 w-3" />{Math.round(value)}</span>
  );
}

const pillar = (v: number | null) => (v === null ? "—" : String(Math.round(v)));

export default function CustomerValuePortfolioPage() {
  const [rows, setRows] = useState<PortfolioRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [sort, setSort] = useState<PortfolioSort>("biggest_drop");
  const [center, setCenter] = useState(ANY);
  const [tiers, setTiers] = useState<PortfolioTier[]>([]);
  const [renewing, setRenewing] = useState(ANY);
  const [includePast, setIncludePast] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/customer-value/portfolio", { cache: "no-store" });
      if (!res.ok) throw new Error(res.status === 403 ? "Admins only" : "Could not load the portfolio");
      setRows(((await res.json()) as { rows: PortfolioRow[] }).rows);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load the portfolio");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const centers = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of rows) if (r.centerId && r.centerName) m.set(r.centerId, r.centerName);
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [rows]);

  const shown = useMemo(
    () => sortPortfolio(filterPortfolio(rows, { centerId: center === ANY ? null : center, tiers, renewingWithinDays: renewing === ANY ? null : Number(renewing), includePast }), sort),
    [rows, center, tiers, renewing, includePast, sort]
  );
  const summary = useMemo(() => summarisePortfolio(shown), [shown]);

  const toggleTier = (t: PortfolioTier) => setTiers((cur) => (cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t]));

  return (
    <div className="space-y-6">
      <PageBreadcrumb resetTo={{ label: "Customer Value" }} />
      <div className="flex items-start gap-3">
        <Gauge className="mt-1 h-6 w-6 text-muted-foreground" />
        <div>
          <h1 className="text-2xl font-semibold">Customer value</h1>
          <p className="text-sm text-muted-foreground">
            Every customer with a score, in one list. Scores are worked out each night; margin is an estimate that rests on the cost rates entered. Open a row for that customer&apos;s Value tab.
          </p>
        </div>
      </div>

      {loading ? (
        <div className="space-y-3"><Skeleton className="h-20" /><Skeleton className="h-72" /></div>
      ) : error ? (
        <Card><CardContent className="flex items-center justify-between py-6"><p className="text-sm text-muted-foreground">{error}</p><Button variant="outline" size="sm" onClick={() => void load()}>Retry</Button></CardContent></Card>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
            <Stat label="Customers shown" value={String(summary.customers)} note={`A ${summary.byTier.A} · B ${summary.byTier.B} · C ${summary.byTier.C} · D ${summary.byTier.D}${summary.byTier.none ? ` · no tier ${summary.byTier.none}` : ""}`} />
            <Stat label="Dropped a tier" value={String(summary.dropped)} note="In the last 90 days" />
            <Stat label="Renewing within 90 days" value={String(summary.renewingSoon)} />
            <Stat label="With a risk flag" value={String(summary.atRisk)} />
            <Stat label="Sorted by" value={SORT_LABELS[sort]} />
          </div>

          <div className="flex flex-wrap items-end gap-4">
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">Sort</p>
              <Select value={sort} onValueChange={(v) => setSort(v as PortfolioSort)}>
                <SelectTrigger className="w-44"><SelectValue /></SelectTrigger>
                <SelectContent>{(Object.keys(SORT_LABELS) as PortfolioSort[]).map((k) => <SelectItem key={k} value={k}>{SORT_LABELS[k]}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">Center</p>
              <Select value={center} onValueChange={setCenter}>
                <SelectTrigger className="w-52"><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value={ANY}>All centers</SelectItem>{centers.map(([id, name]) => <SelectItem key={id} value={id}>{name}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">Renewing</p>
              <Select value={renewing} onValueChange={setRenewing}>
                <SelectTrigger className="w-44"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={ANY}>Any time</SelectItem>
                  {[30, 60, DEFAULT_RENEWING_WITHIN_DAYS, 180].map((d) => <SelectItem key={d} value={String(d)}>Within {d} days</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">Tier</p>
              <div className="flex gap-1">
                {TIERS.map((t) => (
                  <Button key={t} size="sm" variant={tiers.includes(t) ? "default" : "outline"} onClick={() => toggleTier(t)} aria-pressed={tiers.includes(t)}>{t}</Button>
                ))}
              </div>
            </div>
            <label className="flex items-center gap-2 pb-1.5 text-sm">
              <Switch checked={includePast} onCheckedChange={setIncludePast} aria-label="Include past customers" />
              Include past customers
            </label>
          </div>

          {shown.length === 0 ? (
            <Card><CardContent><EmptyState icon={Gauge} title="No customers match" description={rows.length === 0 ? "Scores are worked out each night. Nothing has been stored yet." : "Try widening the filters."} /></CardContent></Card>
          ) : (
            <Card>
              <CardContent className="overflow-x-auto p-0">
                <table className="w-full min-w-[920px] text-sm">
                  <thead>
                    <tr className="border-b text-left text-xs text-muted-foreground">
                      <th className="px-3 py-2 font-medium">Customer</th>
                      <th className="px-3 py-2 font-medium">Tier</th>
                      <th className="px-3 py-2 text-right font-medium">Score</th>
                      <th className="px-3 py-2 text-right font-medium" title="Change in the overall score over the last 90 days">90 days</th>
                      <th className="px-3 py-2 text-right font-medium" title="Payment · Friction · Engagement · Profitability">Pillars</th>
                      <th className="px-3 py-2 text-right font-medium">Margin a month</th>
                      <th className="px-3 py-2 text-right font-medium">Renewal</th>
                      <th className="px-3 py-2 font-medium">Flags</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map((r) => (
                      <tr key={r.leadId} className="border-b align-top last:border-0 hover:bg-muted/40">
                        <td className="px-3 py-2">
                          <Link href={`/leads/${r.leadId}?tab=value`} className="font-medium hover:underline">{r.name}</Link>
                          <div className="text-xs text-muted-foreground">{r.centerName ?? "No center"}{!r.hasLiveContract ? " · past customer" : ""}</div>
                        </td>
                        <td className="px-3 py-2">{r.tier ? <Badge variant="secondary" className={TIER_CLASS[r.tier]}>{r.tier}</Badge> : <span className="text-muted-foreground">—</span>}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{r.overall === null ? "—" : Math.round(r.overall)}</td>
                        <td className="px-3 py-2 text-right tabular-nums"><Change value={r.change90} /></td>
                        <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{pillar(r.payment)} · {pillar(r.friction)} · {pillar(r.engagement)} · {pillar(r.profitability)}</td>
                        <td className={`px-3 py-2 text-right tabular-nums ${r.marginPerMonth !== null && r.marginPerMonth < 0 ? "text-red-700" : ""}`}>
                          {r.marginPerMonth === null ? "—" : formatCurrency(r.marginPerMonth)}
                          {r.marginPct !== null && <div className="text-xs text-muted-foreground">{Math.round(r.marginPct * 100)}%</div>}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {r.daysToRenewal === null ? "—" : r.daysToRenewal < 0 ? <span className="text-red-700">ended</span> : `${r.daysToRenewal} d`}
                        </td>
                        <td className="px-3 py-2">
                          <div className="flex flex-wrap gap-1">
                            {r.insights.slice(0, 3).map((i) => <Badge key={i.key} variant="secondary" className={`whitespace-nowrap ${TONE_CLASS[i.tone]}`} title={i.text}>{INSIGHT_SHORT[i.key] ?? i.key}</Badge>)}
                            {r.insights.length > 3 && <span className="text-xs text-muted-foreground">+{r.insights.length - 3}</span>}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
