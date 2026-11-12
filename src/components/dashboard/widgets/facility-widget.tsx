"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Loader2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import {
  AGE_BANDS,
  FACILITY_LANES,
  FACILITY_LANE_LABELS,
  FACILITY_PRIORITY_COLORS,
  FACILITY_SCOPES,
  FACILITY_SCOPE_COLORS,
  FACILITY_SCOPE_LABELS,
  ageBand,
  applyFilter,
  expectedDayOffset,
  fmtHours,
  hoursToSla,
  inLane,
  isBreached,
  isOpen,
  slaState,
  type FacilityFilter,
  type FacilityLane,
  type FacilityWidgetItem,
  type FacilityWidgetScope,
} from "@/lib/facility-widget";

interface TimelineEvent {
  id: string;
  event_type: string;
  actor_label: string | null;
  message: string | null;
  created_at: string;
}

const FEED_PAGE = 8;
const DAY_MS = 86_400_000;
const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const STATUS_STYLE: Record<string, { label: string; cls: string }> = {
  new: { label: "New", cls: "bg-blue-50 text-blue-700" },
  acknowledged: { label: "Acknowledged", cls: "bg-muted text-muted-foreground" },
  in_progress: { label: "In progress", cls: "bg-amber-50 text-amber-700" },
  reopened: { label: "Reopened", cls: "bg-red-50 text-red-700" },
  resolved: { label: "Resolved", cls: "bg-emerald-50 text-emerald-700" },
  closed: { label: "Closed", cls: "bg-emerald-50 text-emerald-700" },
};

interface Props {
  locationFilter: string | null;
}

export function FacilityWidget({ locationFilter }: Props) {
  const [items, setItems] = useState<FacilityWidgetItem[]>([]);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [forbidden, setForbidden] = useState(false);

  const [filter, setFilter] = useState<FacilityFilter>({ kind: "all", lane: "pending", scope: null, ageBand: null, day: null });
  const [shown, setShown] = useState(FEED_PAGE);
  const [selId, setSelId] = useState<string | null>(null);
  const [timeline, setTimeline] = useState<TimelineEvent[] | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setFailed(false);
    try {
      const qs = new URLSearchParams();
      if (locationFilter) qs.set("location_id", locationFilter);
      const res = await fetch(`/api/dashboard/facility?${qs}`);
      if (res.status === 403) { setForbidden(true); return; }
      if (!res.ok) throw new Error(String(res.status));
      const j = (await res.json()).data;
      setItems(j.items);
      setNowMs(Date.parse(j.now));
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, [locationFilter]);

  useEffect(() => { setSelId(null); load(); }, [load]);

  // Drop a slow timeline response that a newer click has overtaken.
  const tlReq = useRef(0);
  useEffect(() => {
    if (!selId) { setTimeline(null); return; }
    const id = ++tlReq.current;
    setTimeline(null);
    fetch(`/api/dashboard/facility?view=timeline&issue_id=${selId}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((j) => { if (id === tlReq.current) setTimeline(j.data.events); })
      .catch(() => { if (id === tlReq.current) setTimeline([]); });
  }, [selId]);

  const kindScoped = useMemo(() => items.filter((i) => filter.kind === "all" || i.kind === filter.kind), [items, filter.kind]);
  const open = useMemo(() => kindScoped.filter(isOpen), [kindScoped]);
  const feed = useMemo(() => applyFilter(items, filter, nowMs), [items, filter, nowMs]);
  const selected = items.find((i) => i.id === selId) ?? null;

  const patch = (p: Partial<FacilityFilter>) => { setFilter((f) => ({ ...f, ...p })); setShown(FEED_PAGE); setSelId(null); };

  if (forbidden) return null;

  const laneCount = (l: FacilityLane) => kindScoped.filter((i) => inLane(l, i, nowMs)).length;

  const days = Array.from({ length: 7 }, (_, d) => {
    const due = open.filter((i) => expectedDayOffset(i, nowMs) === d);
    const hi = due.filter((i) => i.priority === "critical" || i.priority === "high").length;
    const label = d === 0 ? "Today" : d === 1 ? "Tomorrow" : WEEKDAY[new Date(nowMs + 5.5 * 3_600_000 + d * DAY_MS).getUTCDay()];
    return { d, label, n: due.length, hi };
  });
  const breachedCount = open.filter((i) => isBreached(i, nowMs)).length;
  const noSla = open.filter((i) => !i.sla_target_at).length;

  const ageCounts = AGE_BANDS.map((_, b) => open.filter((i) => ageBand(i, nowMs) === b).length);
  const ageMax = Math.max(...ageCounts, 1);
  const scopeRows = FACILITY_SCOPES.map((s) => {
    const rows = open.filter((i) => i.scope === s);
    return { s, n: rows.length, b: rows.filter((i) => isBreached(i, nowMs)).length };
  }).filter((r) => r.n > 0).sort((a, b) => b.n - a.n);
  const scopeMax = Math.max(...scopeRows.map((r) => r.n), 1);

  const laneTitle = filter.lane === "pending" ? "Activity feed — all open" : filter.lane === "done" ? "Recently resolved" : `Feed — ${FACILITY_LANE_LABELS[filter.lane].label}`;
  const filtered = filter.scope || filter.ageBand != null || filter.day != null;

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="text-base">Facilities · what&apos;s happening</CardTitle>
            <p className="mt-0.5 text-xs text-muted-foreground">Tickets and delegated tasks · what&apos;s pending and what&apos;s due, by SLA</p>
          </div>
          <div className="flex overflow-hidden rounded-md border" role="tablist" aria-label="Type">
            {([["all", "All"], ["ticket", "Tickets"], ["task", "Tasks"]] as const).map(([k, l]) => (
              <button key={k} role="tab" aria-selected={filter.kind === k} onClick={() => patch({ kind: k })}
                className={cn("px-3 py-1.5 text-xs transition-colors", filter.kind === k ? "bg-muted font-medium" : "text-muted-foreground hover:bg-muted/50")}>
                {l}
              </button>
            ))}
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-3">
        {loading && items.length === 0 ? (
          <div className="flex h-60 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
        ) : failed ? (
          <div className="flex h-40 flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
            Couldn&apos;t load facilities.
            <button onClick={load} className="text-xs underline underline-offset-2">Retry</button>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
              {FACILITY_LANES.map((l) => {
                const c = laneCount(l);
                return (
                  <button key={l} onClick={() => patch({ lane: l, scope: null, ageBand: null, day: null })} aria-pressed={filter.lane === l}
                    className={cn("rounded-md border-2 bg-muted/50 px-3 py-2 text-left", filter.lane === l ? "border-blue-400" : "border-transparent hover:bg-muted")}>
                    <div className="text-[11px] text-muted-foreground">{FACILITY_LANE_LABELS[l].label}</div>
                    <div className={cn("text-xl font-semibold tabular-nums", l === "breached" && c > 0 && "text-red-600", l === "reopened" && c > 0 && "text-amber-600")}>{c}</div>
                    <div className="text-[10px] text-muted-foreground">{FACILITY_LANE_LABELS[l].hint || " "}</div>
                  </button>
                );
              })}
            </div>

            <div className="grid gap-3 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
              <div className="rounded-lg border p-3">
                <div className="mb-2 flex items-baseline justify-between">
                  <span className="text-sm font-medium">{laneTitle}</span>
                  <span className="text-[11px] text-muted-foreground">{feed.length} item{feed.length === 1 ? "" : "s"}{filtered ? " · filtered" : ""}</span>
                </div>
                <div className="mb-2 flex flex-wrap gap-1.5">
                  <Chip on={!filter.scope} onClick={() => patch({ scope: null })}>All scopes</Chip>
                  {FACILITY_SCOPES.map((s) => (
                    <Chip key={s} on={filter.scope === s} onClick={() => patch({ scope: filter.scope === s ? null : s })}>{FACILITY_SCOPE_LABELS[s]}</Chip>
                  ))}
                </div>

                {feed.length === 0 ? (
                  <p className="px-1 py-4 text-xs text-muted-foreground">Nothing here — all clear.</p>
                ) : (
                  <ul>
                    {feed.slice(0, shown).map((i) => {
                      const st = STATUS_STYLE[i.status] ?? STATUS_STYLE.new;
                      return (
                        <li key={i.id}>
                          <button onClick={() => setSelId(selId === i.id ? null : i.id)}
                            className={cn("flex w-full items-start gap-2 border-b px-1 py-2 text-left last:border-0 hover:bg-muted/50", selId === i.id && "bg-muted/50")}>
                            <span className="mt-1.5 h-2 w-2 flex-none rounded-full" style={{ background: FACILITY_PRIORITY_COLORS[i.priority] ?? "#B4B2A9" }} title={`${i.priority} priority`} />
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-[13px] font-medium">{i.title}</span>
                              <span className="block text-[11px] text-muted-foreground">
                                {i.number} · {i.kind === "task" ? "Task" : "Ticket"} · {FACILITY_SCOPE_LABELS[i.scope]}{i.location ? ` · ${i.location}` : ""} · {i.assignee ?? "Unassigned"}
                              </span>
                            </span>
                            <span className="flex flex-none flex-col items-end gap-0.5">
                              <span className={cn("rounded-full px-2 py-0.5 text-[10.5px]", st.cls)}>{st.label}</span>
                              <SlaText item={i} nowMs={nowMs} />
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
                {feed.length > shown && (
                  <button onClick={() => setShown((n) => n + FEED_PAGE)} className="px-1 pt-2 text-xs text-blue-600 hover:underline">Show {Math.min(FEED_PAGE, feed.length - shown)} more →</button>
                )}
              </div>

              <div className="flex flex-col gap-3">
                <div className="rounded-lg border p-3">
                  <div className="mb-2 flex items-baseline justify-between text-sm font-medium">Expected — next 7 days <span className="text-[11px] font-normal text-muted-foreground">by SLA due</span></div>
                  <div className="grid grid-cols-7 gap-1">
                    {days.map((d) => (
                      <button key={d.d} onClick={() => patch({ lane: "pending", day: filter.day === d.d ? null : d.d, scope: null, ageBand: null })} aria-pressed={filter.day === d.d}
                        className={cn("rounded-md border-2 bg-muted/50 px-0.5 py-1.5 text-center", filter.day === d.d ? "border-blue-400" : "border-transparent hover:bg-muted")}>
                        <div className="text-[10px] text-muted-foreground">{d.label}</div>
                        <div className="text-[15px] font-semibold tabular-nums">{d.n}</div>
                        <div className="mt-0.5 flex h-1.5 justify-center gap-0.5">
                          {d.hi > 0 && <i className="h-1.5 w-1.5 rounded-full bg-red-500" />}
                          {d.n - d.hi > 0 && <i className="h-1.5 w-1.5 rounded-full bg-blue-500" />}
                        </div>
                      </button>
                    ))}
                  </div>
                  <p className="mt-1.5 text-[11px] text-muted-foreground">
                    <button className="text-red-600 hover:underline" onClick={() => patch({ lane: "breached", day: null, scope: null, ageBand: null })}>{breachedCount} already past SLA</button>
                    {" "}(not in the strip) · red dot = high/critical{noSla > 0 ? ` · ${noSla} open with no SLA` : ""}
                  </p>
                </div>

                <div className="rounded-lg border p-3">
                  <div className="mb-1 flex items-baseline justify-between text-sm font-medium">Open by age <span className="text-[11px] font-normal text-muted-foreground">click to filter</span></div>
                  {AGE_BANDS.map((b, i) => (
                    <BarRow key={b} label={b} count={ageCounts[i]} max={ageMax} active={filter.ageBand === i}
                      color={i > 2 ? "#E24B4A" : i > 1 ? "#EF9F27" : "#378ADD"}
                      onClick={() => patch({ lane: "pending", ageBand: filter.ageBand === i ? null : i, scope: null, day: null })} />
                  ))}
                </div>

                <div className="rounded-lg border p-3">
                  <div className="mb-1 flex items-baseline justify-between text-sm font-medium">Open by scope <span className="text-[11px] font-normal text-muted-foreground">click to filter</span></div>
                  {scopeRows.length === 0 ? <p className="text-xs text-muted-foreground">Nothing open.</p> : scopeRows.map((r) => (
                    <BarRow key={r.s} label={FACILITY_SCOPE_LABELS[r.s]} count={r.n} max={scopeMax} active={filter.scope === r.s}
                      color={FACILITY_SCOPE_COLORS[r.s]} breached={r.b}
                      onClick={() => patch({ scope: filter.scope === r.s ? null : (r.s as FacilityWidgetScope) })} />
                  ))}
                  {scopeRows.some((r) => r.b > 0) && <p className="mt-1 text-[11px] text-muted-foreground">red = past SLA</p>}
                </div>
              </div>
            </div>

            {selected && (
              <div className="rounded-lg border p-3">
                <div className="flex items-baseline justify-between gap-2">
                  <div className="text-sm font-medium">{selected.number} · {selected.title}</div>
                  <button onClick={() => setSelId(null)} className="text-[11px] text-muted-foreground hover:text-foreground">close ✕</button>
                </div>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  {(STATUS_STYLE[selected.status] ?? STATUS_STYLE.new).label} · {selected.priority} priority · {FACILITY_SCOPE_LABELS[selected.scope]}
                  {selected.location ? ` · ${selected.location}` : ""} · {selected.assignee ?? "Unassigned"} · {selected.kind === "task" ? "delegated task" : "reported problem"}
                  {selected.sla_target_at ? "" : " · no SLA set"}
                </p>
                <div className="ml-1.5 mt-2 border-l pl-3">
                  {timeline === null ? (
                    <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                  ) : timeline.length === 0 ? (
                    <p className="text-xs text-muted-foreground">No activity recorded.</p>
                  ) : timeline.map((e) => (
                    <div key={e.id} className="mb-1.5 text-xs">
                      {e.message || e.event_type.replace(/_/g, " ")}
                      <span className="text-muted-foreground"> · {e.actor_label ? `${e.actor_label} · ` : ""}{fmtHours((nowMs - Date.parse(e.created_at)) / 3_600_000)} ago</span>
                    </div>
                  ))}
                </div>
                <Link href={`/facility/issues/${selected.id}`} className="mt-2 inline-block rounded-md border px-3 py-1 text-xs text-blue-600 hover:bg-muted/50">Open ticket →</Link>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} aria-pressed={on}
      className={cn("rounded-full border px-2.5 py-0.5 text-[11px]", on ? "border-blue-300 bg-blue-50 text-blue-700" : "hover:bg-muted/50")}>
      {children}
    </button>
  );
}

function BarRow({ label, count, max, active, color, breached = 0, onClick }: { label: string; count: number; max: number; active: boolean; color: string; breached?: number; onClick: () => void }) {
  return (
    <button onClick={onClick} aria-pressed={active} className={cn("my-1 flex w-full items-center gap-2 text-left text-[11.5px] hover:opacity-80", active && "font-medium")}>
      <span className="w-24 flex-none truncate">{label}</span>
      <span className="flex h-2 flex-1 overflow-hidden rounded-full bg-muted">
        <span style={{ width: `${((count - breached) / max) * 100}%`, background: color }} />
        <span style={{ width: `${(breached / max) * 100}%`, background: "#E24B4A" }} />
      </span>
      <span className="w-6 text-right tabular-nums">{count}</span>
    </button>
  );
}

function SlaText({ item, nowMs }: { item: FacilityWidgetItem; nowMs: number }) {
  const state = slaState(item, nowMs);
  if (state === "closed") {
    const at = item.resolved_at ?? item.last_activity;
    return <span className="text-[11px] text-muted-foreground">resolved {fmtHours((nowMs - Date.parse(at)) / 3_600_000)} ago</span>;
  }
  const h = hoursToSla(item, nowMs);
  if (state === "no_sla" || h == null) return <span className="text-[11px] text-muted-foreground">no SLA</span>;
  if (state === "breached") return <span className="text-[11px] text-red-600">breached {fmtHours(-h)} ago</span>;
  return <span className={cn("text-[11px]", state === "due_soon" ? "text-amber-600" : "text-muted-foreground")}>due in {fmtHours(h)}</span>;
}
