"use client";

import { useMemo, useState } from "react";
import { Download } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  usePettyCashAnalytics,
  usePettyCashCategories,
  pettyCashAnalyticsParams,
} from "@/hooks/use-petty-cash";
import { getDateRange, type TimelinePreset } from "@/lib/petty-cash-utils";
import { formatCurrency, formatDate } from "@/lib/utils";
import type { BreakdownItem } from "@/lib/petty-cash-analytics";

const ALL = "all";

const PRESETS: { key: TimelinePreset; label: string }[] = [
  { key: "this_week", label: "This Week" },
  { key: "this_month", label: "This Month" },
  { key: "last_month", label: "Last Month" },
  { key: "this_year", label: "This Year" },
];

function FilterSelect({
  value, onChange, allLabel, options,
}: {
  value: string;
  onChange: (v: string) => void;
  allLabel: string;
  options: { id: string; name: string }[];
}) {
  return (
    <Select value={value || ALL} onValueChange={(v) => onChange(v === ALL ? "" : v)}>
      <SelectTrigger className="h-8 w-auto min-w-[140px] text-sm"><SelectValue /></SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL}>{allLabel}</SelectItem>
        {options.map((o) => <SelectItem key={o.id} value={o.id}>{o.name}</SelectItem>)}
      </SelectContent>
    </Select>
  );
}

function BreakdownBars({
  items, total, onPick,
}: { items: BreakdownItem[]; total: number; onPick?: (item: BreakdownItem) => void }) {
  const max = items[0]?.total || 1;
  if (items.length === 0) return <p className="text-sm text-muted-foreground py-4 text-center">No approved expenses in this period</p>;
  return (
    <div className="space-y-3">
      {items.map((it) => {
        const clickable = onPick && it.id;
        return (
          <div key={it.id ?? it.name} className={clickable ? "cursor-pointer" : undefined} onClick={clickable ? () => onPick(it) : undefined}>
            <div className="flex items-center justify-between text-sm mb-1">
              <span>{it.name}</span>
              <span><span className="font-medium">{formatCurrency(it.total)}</span>{" "}
                <span className="text-muted-foreground">{total ? Math.round((it.total / total) * 100) : 0}%</span></span>
            </div>
            <div className="h-2 bg-muted rounded-full overflow-hidden">
              <div className="h-full bg-amber-500 rounded-full" style={{ width: `${(it.total / max) * 100}%` }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function AnalyticsTab() {
  const [period, setPeriod] = useState<TimelinePreset>("this_month");
  const [personId, setPersonId] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [locationId, setLocationId] = useState("");
  const { dateFrom, dateTo } = getDateRange(period);
  const filters = { dateFrom, dateTo, personId, categoryId, locationId };

  const { data: res, loading, error } = usePettyCashAnalytics(filters);
  const { data: categories } = usePettyCashCategories();

  const a = res?.data;
  const isAll = res?.scope === "all";
  const filtered = !!(personId || categoryId || locationId);

  const csvHref = useMemo(() => {
    const qs = new URLSearchParams({ format: "csv" });
    for (const [k, v] of Object.entries(pettyCashAnalyticsParams(filters))) if (v) qs.set(k, v);
    return `/api/petty-cash/analytics?${qs}`;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dateFrom, dateTo, personId, categoryId, locationId]);

  const maxWeek = Math.max(1, ...(a?.byWeek.map((w) => w.total) ?? [0]));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-lg font-semibold mr-2">Spending Analytics</h3>
        {PRESETS.map((p) => (
          <Button key={p.key} size="sm" variant={period === p.key ? "default" : "outline"} onClick={() => setPeriod(p.key)}>
            {p.label}
          </Button>
        ))}
        {isAll && (
          <>
            <FilterSelect value={personId} onChange={setPersonId} allLabel="Everyone" options={res?.options.people ?? []} />
            <FilterSelect value={categoryId} onChange={setCategoryId} allLabel="All categories" options={categories} />
            <FilterSelect value={locationId} onChange={setLocationId} allLabel="All locations" options={res?.options.locations ?? []} />
          </>
        )}
        {filtered && (
          <Button size="sm" variant="ghost" onClick={() => { setPersonId(""); setCategoryId(""); setLocationId(""); }}>Clear filters</Button>
        )}
        <Button size="sm" variant="outline" className="ml-auto" asChild>
          <a href={csvHref} download><Download className="h-4 w-4 mr-1" />Export CSV</a>
        </Button>
      </div>

      {res?.scope === "own" && (
        <p className="text-sm text-muted-foreground">Showing your own approved expenses.</p>
      )}
      {res?.truncated && (
        <p className="text-sm rounded-md bg-amber-50 text-amber-800 px-3 py-2">
          Very large result — only the first 20,000 expenses were counted. Narrow the dates or filters to see exact totals.
        </p>
      )}
      {error && <p className="text-sm rounded-md bg-red-50 text-red-700 px-3 py-2">Could not load analytics: {error}</p>}

      {loading && !a ? (
        <div className="animate-pulse space-y-4">
          <div className="h-24 rounded-lg bg-muted" />
          <div className="h-48 rounded-lg bg-muted" />
        </div>
      ) : a && (
        <div className={loading ? "opacity-60 transition-opacity space-y-6" : "space-y-6"}>
          <div className={`grid gap-4 ${res?.cashInHand ? "md:grid-cols-4" : "md:grid-cols-3"}`}>
            <Card><CardContent className="pt-6">
              <p className="text-sm text-muted-foreground">Total Spend</p>
              <p className="text-2xl font-bold">{formatCurrency(a.totalSpend)}</p>
            </CardContent></Card>
            <Card><CardContent className="pt-6">
              <p className="text-sm text-muted-foreground">Expenses</p>
              <p className="text-2xl font-bold">{a.count}</p>
            </CardContent></Card>
            <Card><CardContent className="pt-6">
              <p className="text-sm text-muted-foreground">Average per Expense</p>
              <p className="text-2xl font-bold">{formatCurrency(Math.round(a.average))}</p>
            </CardContent></Card>
            {res?.cashInHand && (
              <Card><CardContent className="pt-6">
                <p className="text-sm text-muted-foreground">Cash in Hand (all books)</p>
                <p className="text-2xl font-bold">{formatCurrency(res.cashInHand.total)}</p>
                <p className="text-xs text-muted-foreground">
                  {res.cashInHand.books} books{res.cashInHand.lowBooks > 0 && ` · ${res.cashInHand.lowBooks} below ₹1,000`}
                </p>
              </CardContent></Card>
            )}
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <Card>
              <CardHeader className="pb-3"><CardTitle className="text-base">Spend by Week</CardTitle></CardHeader>
              <CardContent>
                {a.byWeek.length === 0 ? (
                  <p className="text-sm text-muted-foreground py-4 text-center">No data</p>
                ) : (
                  <div className="flex items-end gap-2 h-36">
                    {a.byWeek.map((w) => (
                      <div key={w.weekStart} className="flex-1 flex flex-col items-center justify-end h-full min-w-0"
                        title={`Week of ${formatDate(w.weekStart)} · ${w.count} expenses`}>
                        <span className="text-[10px] text-muted-foreground mb-1">{formatCurrency(w.total)}</span>
                        <div className="w-full bg-amber-500 rounded-t" style={{ height: `${(w.total / maxWeek) * 100}%`, minHeight: 2 }} />
                        <span className="text-[10px] text-muted-foreground mt-1">{formatDate(w.weekStart)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Spend by Category{isAll && <span className="text-xs font-normal text-muted-foreground"> · click to filter</span>}</CardTitle>
              </CardHeader>
              <CardContent>
                <BreakdownBars items={a.byCategory} total={a.totalSpend} onPick={isAll ? (it) => setCategoryId(it.id!) : undefined} />
              </CardContent>
            </Card>
          </div>

          {isAll && (
            <div className="grid gap-4 md:grid-cols-2">
              <Card>
                <CardHeader className="pb-3"><CardTitle className="text-base">Spend by Person <span className="text-xs font-normal text-muted-foreground">· click to filter</span></CardTitle></CardHeader>
                <CardContent><BreakdownBars items={a.byPerson} total={a.totalSpend} onPick={(it) => setPersonId(it.id!)} /></CardContent>
              </Card>
              <Card>
                <CardHeader className="pb-3"><CardTitle className="text-base">Spend by Location <span className="text-xs font-normal text-muted-foreground">· click to filter</span></CardTitle></CardHeader>
                <CardContent><BreakdownBars items={a.byLocation} total={a.totalSpend} onPick={(it) => setLocationId(it.id!)} /></CardContent>
              </Card>
            </div>
          )}

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Largest expenses ({a.topEntries.length} of {a.count})</CardTitle>
            </CardHeader>
            <CardContent>
              {a.topEntries.length === 0 ? (
                <p className="text-sm text-muted-foreground py-4 text-center">No approved expenses in this period</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b text-left text-muted-foreground">
                        <th className="pb-2 font-medium">Date</th>
                        <th className="pb-2 font-medium">Who</th>
                        <th className="pb-2 font-medium">Category</th>
                        <th className="pb-2 font-medium">For</th>
                        <th className="pb-2 font-medium text-right">Amount</th>
                      </tr>
                    </thead>
                    <tbody>
                      {a.topEntries.map((e) => (
                        <tr key={e.entry_number} className="border-b last:border-0">
                          <td className="py-2">{formatDate(e.date)}</td>
                          <td className="py-2">{e.person}</td>
                          <td className="py-2">{e.category ?? "Uncategorized"}</td>
                          <td className="py-2 max-w-[240px] truncate" title={e.description}>{e.description}</td>
                          <td className="py-2 text-right font-medium">{formatCurrency(e.amount)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <p className="text-xs text-muted-foreground mt-3">Export CSV lists every expense behind these numbers.</p>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
