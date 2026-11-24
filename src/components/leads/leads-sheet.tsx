"use client";

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useLocations } from "@/hooks/use-locations";
import { useUsers } from "@/hooks/use-leads";
import { LEAD_SOURCES, LEAD_SOURCE_LABELS } from "@/lib/constants";
import { formatDate } from "@/lib/utils";
import {
  LAST_ACTION_CHOICES,
  SEAT_BANDS,
  sheetSeats,
  SHEET_STATUSES,
  SHEET_STATUS_META,
  dayHeading,
  flagTooltip,
  filtersActive,
  groupByDay,
  istDay,
  passesSheetFilters,
  sheetLastAction,
  sheetStatus,
  startsFolded,
  waitingText,
  type SheetFilters,
  type SheetStatus,
} from "@/lib/lead-sheet";
import { LeadFlagControl, type FlagFields } from "@/components/leads/lead-flag-control";
import type { Lead } from "@/types";

const PAGE_SIZE = 100;

const selectClass = "h-9 rounded-md border bg-background px-2 text-sm";

function ago(iso: string | null, nowMs: number): string {
  if (!iso) return "";
  const mins = Math.max(0, Math.round((nowMs - new Date(iso).getTime()) / 60_000));
  if (mins < 60) return `${mins} min ago`;
  const h = Math.round(mins / 60);
  return h < 24 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
}

/**
 * The Leads landing sheet: one row per lead, latest enquiry first, grouped by the day it came in,
 * coloured by where it stands. Read-only: a row opens the lead's activity page, where the action
 * buttons live. "All leads" is the other way to list them.
 */
export function LeadsSheet({ onShowAll }: { onShowAll: () => void }) {
  const router = useRouter();
  const { locations } = useLocations();
  const { users } = useUsers();

  const [center, setCenter] = useState("");
  const [channel, setChannel] = useState("");
  const [owner, setOwner] = useState("");
  const [filters, setFilters] = useState<SheetFilters>({ notContacted: false, lastAction: "", seats: "", statuses: [] });

  const [rows, setRows] = useState<Lead[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [nowMs] = useState(() => Date.now());
  // Days the person opened or closed by hand; the rest follow the "older than a week starts folded" rule.
  const [opened, setOpened] = useState<Set<string>>(new Set());
  const [closed, setClosed] = useState<Set<string>>(new Set());

  const buildUrl = useCallback(
    (page: number) => {
      const p = new URLSearchParams({ view: "all", limit: String(PAGE_SIZE), page: String(page), sort_by: "created_at", sort_order: "desc" });
      if (center) p.set("location_id", center);
      if (channel) p.set("source", channel);
      if (owner) p.set("assigned_to", owner);
      return `/api/leads?${p.toString()}`;
    },
    [center, channel, owner],
  );

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    fetch(buildUrl(1))
      .then(async (r) => ({ ok: r.ok, json: await r.json() }))
      .then(({ ok, json }) => {
        if (cancelled) return;
        if (!ok) throw new Error(json.error || "Could not load leads");
        setRows(json.data as Lead[]);
        setTotal(json.pagination?.total ?? 0);
      })
      .catch((e: Error) => !cancelled && setError(e.message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [buildUrl]);

  async function loadMore() {
    setLoadingMore(true);
    try {
      const page = Math.floor(rows.length / PAGE_SIZE) + 1;
      const res = await fetch(buildUrl(page));
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Could not load more");
      setRows((prev) => [...prev, ...(json.data as Lead[])]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoadingMore(false);
    }
  }

  const today = istDay(nowMs);
  const filtering = filtersActive(filters, { center, channel, owner });

  // The guide's counts follow every filter except its own status picks.
  const forGuide = useMemo(() => rows.filter((l) => passesSheetFilters(l, filters, { skipStatuses: true })), [rows, filters]);
  const shown = useMemo(() => rows.filter((l) => passesSheetFilters(l, filters)), [rows, filters]);
  const groups = useMemo(() => groupByDay(shown), [shown]);
  const untouched = useMemo(() => rows.filter((l) => !sheetLastAction(l)).length, [rows]);

  const toggleStatus = (s: SheetStatus) =>
    setFilters((f) => ({ ...f, statuses: f.statuses.includes(s) ? f.statuses.filter((x) => x !== s) : [...f.statuses, s] }));
  const clearAll = () => {
    setCenter("");
    setChannel("");
    setOwner("");
    setFilters({ notContacted: false, lastAction: "", seats: "", statuses: [] });
  };
  const isFolded = (day: string) => (closed.has(day) ? true : opened.has(day) ? false : startsFolded(day, today, filtering));
  const toggleDay = (day: string) => {
    const wasFolded = isFolded(day);
    const flip = (add: boolean) => (s: Set<string>) => {
      const n = new Set(s);
      if (add) n.add(day);
      else n.delete(day);
      return n;
    };
    setOpened(flip(wasFolded));
    setClosed(flip(!wasFolded));
  };

  const gapCount = forGuide.filter(isGap).length;

  return (
    <div className="space-y-3">
      {/* The only filters: not contacted, center, channel, owner, last action, and All. */}
      <div className="flex flex-wrap items-end gap-2 rounded-lg border bg-card p-3">
        <button
          type="button"
          onClick={() => setFilters((f) => ({ ...f, notContacted: !f.notContacted }))}
          className={`h-9 self-end rounded-full border px-4 text-sm ${filters.notContacted ? "border-primary bg-primary text-primary-foreground" : "bg-background"}`}
        >
          Not contacted <span className="ml-1 opacity-70">{untouched}</span>
        </button>
        <label className="flex flex-col gap-0.5 text-[11px] uppercase tracking-wide text-muted-foreground">
          Center
          <select className={selectClass} value={center} onChange={(e) => setCenter(e.target.value)}>
            <option value="">All centers</option>
            {locations.map((l) => (
              <option key={l.id} value={l.id}>{l.name}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-0.5 text-[11px] uppercase tracking-wide text-muted-foreground">
          Channel
          <select className={selectClass} value={channel} onChange={(e) => setChannel(e.target.value)}>
            <option value="">All channels</option>
            {LEAD_SOURCES.map((s) => (
              <option key={s} value={s}>{LEAD_SOURCE_LABELS[s] ?? s}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-0.5 text-[11px] uppercase tracking-wide text-muted-foreground">
          Owner
          <select className={selectClass} value={owner} onChange={(e) => setOwner(e.target.value)}>
            <option value="">Everyone</option>
            <option value="none">Unassigned</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>{u.full_name}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-0.5 text-[11px] uppercase tracking-wide text-muted-foreground">
          Last action
          <select className={selectClass} value={filters.lastAction} onChange={(e) => setFilters((f) => ({ ...f, lastAction: e.target.value }))}>
            <option value="">Any action</option>
            {LAST_ACTION_CHOICES.map((a) => (
              <option key={a} value={a}>{a}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-0.5 text-[11px] uppercase tracking-wide text-muted-foreground">
          Seats
          <select className={selectClass} value={filters.seats} onChange={(e) => setFilters((f) => ({ ...f, seats: e.target.value }))}>
            <option value="">Any seats</option>
            {SEAT_BANDS.map((b) => (
              <option key={b.value} value={b.value}>{b.label}</option>
            ))}
            <option value="none">Not captured</option>
          </select>
        </label>
        <button
          type="button"
          onClick={clearAll}
          className={`h-9 self-end rounded-full border px-4 text-sm ${filtering ? "bg-background" : "border-primary bg-primary text-primary-foreground"}`}
        >
          All <span className="ml-1 opacity-70">{total}</span>
        </button>
        <Button variant="outline" className="ml-auto self-end" onClick={onShowAll}>
          Show all leads (full list)
        </Button>
      </div>

      {error && <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}

      <div className="max-h-[68vh] overflow-auto rounded-lg border bg-card">
        <table className="w-full min-w-[1080px] border-collapse text-sm">
          <thead className="sticky top-0 z-10 bg-muted text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              {["Received", "Channel", "Full name", "Phone", "Seats", "Center", "Last action", "Next call", "Owner", "Flag"].map((h) => (
                <th key={h} className="whitespace-nowrap px-3 py-2 font-medium">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={10} className="px-3 py-10 text-center text-muted-foreground"><Loader2 className="mx-auto h-5 w-5 animate-spin" /></td></tr>
            )}
            {!loading && groups.length === 0 && (
              <tr><td colSpan={10} className="px-3 py-10 text-center text-muted-foreground">No leads match these filters.</td></tr>
            )}
            {!loading &&
              groups.map((g) => {
                const folded = isFolded(g.day);
                const unattended = g.rows.filter((l) => !sheetLastAction(l)).length;
                return (
                  <Fragment key={g.day}>
                    <tr onClick={() => toggleDay(g.day)} className="cursor-pointer bg-slate-200/70 hover:bg-slate-200">
                      <td colSpan={10} className="sticky top-8 px-3 py-1.5">
                        <span className="inline-flex items-center gap-2">
                          {folded ? <ChevronRight className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                          <b>{dayHeading(g.day, today)}</b>
                          <span className="text-muted-foreground">
                            {g.rows.length} {g.rows.length === 1 ? "enquiry" : "enquiries"}
                            {folded && startsFolded(g.day, today, filtering) && !opened.has(g.day) ? " · folded, click to open" : ""}
                          </span>
                          {unattended > 0 ? (
                            <span className="rounded-full bg-red-600 px-2 py-0.5 text-xs font-bold text-white">{unattended} not attended</span>
                          ) : (
                            <span className="text-xs font-semibold text-emerald-700">all attended</span>
                          )}
                        </span>
                      </td>
                    </tr>
                    {!folded && g.rows.map((l) => <SheetRow key={l.id} lead={l} nowMs={nowMs} onOpen={() => router.push(`/leads/${l.id}/activity`)} onFlag={(f) => setRows((prev) => prev.map((r) => (r.id === l.id ? { ...r, ...f } : r)))} />)}
                  </Fragment>
                );
              })}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between text-sm text-muted-foreground">
        <span>
          Showing {shown.length} of {rows.length} loaded ({total} in all). Latest first. Click a row for the gist and the action buttons.
        </span>
        {rows.length < total && (
          <Button variant="outline" size="sm" onClick={loadMore} disabled={loadingMore}>
            {loadingMore ? "Loading…" : `Load ${Math.min(PAGE_SIZE, total - rows.length)} older`}
          </Button>
        )}
      </div>

      {/* The colour guide is the status filter. */}
      <div className="rounded-lg border bg-card p-3">
        <div className="mb-2 flex flex-wrap items-center gap-3 text-xs uppercase tracking-wide text-muted-foreground">
          <span>Colour guide: click to show only those</span>
          <Button
            size="sm"
            variant={filters.statuses.length === 0 ? "default" : "outline"}
            className="h-7 normal-case"
            onClick={() => setFilters((f) => ({ ...f, statuses: [] }))}
          >
            Show all <b className="ml-1 opacity-80">{forGuide.length}</b>
          </Button>
        </div>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {SHEET_STATUSES.map((s) => {
            const m = SHEET_STATUS_META[s];
            const n = forGuide.filter((l) => sheetStatus(l) === s).length;
            const on = filters.statuses.includes(s);
            return (
              <button
                key={s}
                type="button"
                onClick={() => toggleStatus(s)}
                className={`flex items-start gap-2 rounded-md border-2 p-2 text-left text-sm hover:bg-muted/50 ${on ? "border-primary bg-primary/5" : "border-transparent"}`}
              >
                <span className="mt-0.5 h-5 w-9 shrink-0 rounded border" style={{ background: m.bg, boxShadow: `inset 6px 0 ${m.bar}` }} />
                <span>
                  <b>{m.label}</b>
                  <span className={`ml-1.5 rounded-full px-2 text-xs ${s === "none" ? "bg-red-600 text-white" : "bg-muted"}`}>{n}</span>
                  <span className="block text-xs text-muted-foreground">{m.hint}</span>
                </span>
              </button>
            );
          })}
          <div className="flex items-start gap-2 rounded-md border-2 border-transparent p-2 text-sm">
            <span className="mt-0.5 h-5 w-9 shrink-0 rounded border-2 border-amber-300 bg-white" />
            <span>
              <b>Yellow cell</b>
              <span className="ml-1.5 rounded-full bg-muted px-2 text-xs">{gapCount}</span>
              <span className="block text-xs text-muted-foreground">Seats or center missing on a lead being worked</span>
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

/** A lead someone is working whose seats or center are still blank. */
function isGap(l: Lead): boolean {
  const st = sheetStatus(l);
  if (st === "none" || st === "won" || st === "lost" || st === "junk") return false;
  return !seatsOf(l) || !centerOf(l);
}
const seatsOf = (l: Lead) => sheetSeats(l) || null;
const centerOf = (l: Lead) => l.location?.name ?? l._enquiry?.preferred_location ?? null;

function SheetRow({ lead: l, nowMs, onOpen, onFlag }: { lead: Lead; nowMs: number; onOpen: () => void; onFlag: (f: FlagFields) => void }) {
  const st = sheetStatus(l);
  const meta = SHEET_STATUS_META[st];
  const last = sheetLastAction(l);
  const name = `${l.first_name} ${l.last_name === "-" ? "" : l.last_name}`.trim();
  const phone = l.mobile?.trim() || l.phone?.trim() || "";
  const gap = isGap(l);
  const seats = seatsOf(l);
  const center = centerOf(l);
  const next = (l as Lead & { _followup?: { overdue: boolean; due_today: boolean; next?: { due_at: string } } | null })._followup;
  const cell = "whitespace-nowrap px-3 py-2";
  const hot = st === "none";
  return (
    <tr
      onClick={onOpen}
      title={flagTooltip(l) || undefined}
      className="cursor-pointer border-b hover:brightness-95"
      style={{ background: meta.bg, color: st === "lost" || st === "junk" ? "#7a6a6a" : undefined }}
    >
      <td className={cell} style={{ boxShadow: `inset ${hot ? 7 : 5}px 0 ${meta.bar}`, paddingLeft: 16 }}>
        <div>{formatDate(l.created_at)}</div>
        <div className="text-xs text-muted-foreground">{new Date(l.created_at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" })}</div>
      </td>
      <td className={cell}>{LEAD_SOURCE_LABELS[l.source as string] ?? l.source ?? ""}</td>
      <td className={`${cell} font-semibold`} style={{ color: hot ? "#b42318" : "#0f5c5c" }}>{name || "—"}</td>
      <td className={cell}>{phone}</td>
      <td className={cell} style={gap && !seats ? { background: "#fff4cc" } : undefined}>{seats ?? ""}</td>
      <td className={cell} style={gap && !center ? { background: "#fff4cc" } : undefined}>{center ?? ""}</td>
      <td className={cell}>
        {last ? (
          <div>
            <div className="font-semibold">
              {last.label}
              {last.auto && <span className="ml-1.5 rounded-full bg-blue-100 px-1.5 text-[11px] font-semibold text-blue-800">auto</span>}
            </div>
            <div className="text-xs text-muted-foreground">{[last.by, ago(last.at, nowMs)].filter(Boolean).join(" · ")}</div>
          </div>
        ) : (
          <div>
            <div className="font-bold text-red-700">NOT ATTENDED</div>
            <div className="text-xs font-semibold text-red-700">Waiting {waitingText(l.created_at, nowMs)} · nobody has acted</div>
          </div>
        )}
      </td>
      <td className={cell}>
        {next?.next ? (
          <span className={next.overdue ? "font-semibold text-red-700" : next.due_today ? "font-semibold text-amber-700" : ""}>
            {formatDate(next.next.due_at)}
            {next.overdue ? " · overdue" : next.due_today ? " · today" : ""}
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </td>
      <td className={cell}>{l.assigned_user?.full_name ?? <span className="text-muted-foreground">Unassigned</span>}</td>
      <td className="px-2 py-2 text-center">
        <LeadFlagControl lead={l} onChanged={onFlag} />
      </td>
    </tr>
  );
}
