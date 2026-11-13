"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { ChevronDown, Loader2, MapPin, Phone } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { FollowUpDateTimeInput } from "@/components/shared/followup-datetime-input";
import { StatusBadge } from "@/components/shared/status-badge";
import {
  LEAD_HANDLER_ROLES,
  NOT_INTERESTED_REASONS,
  NOT_INTERESTED_REASON_LABELS,
  WORKSPACE_TYPE_LABELS,
  type NotInterestedReason,
} from "@/lib/constants";
import { useUsers } from "@/hooks/use-leads";
import { followUpInDays } from "@/lib/followup-hint";
import { dayLabel, istDayKey } from "@/lib/lead-days";
import { datePart, timePart } from "@/lib/next-step-chip";
import { TOUR_OUTCOME_LABELS, tourChip, type TourBucket, type TourGroup, type TourOutcome, type TourStats } from "@/lib/tours";

export interface TourListRow {
  id: string;
  bucket: TourBucket;
  leadId: string;
  leadNumber: number;
  name: string;
  phone: string | null;
  leadStatus: string;
  lostReason: string | null;
  workspaceType: string | null;
  seats: number | null;
  start: string;
  end: string | null;
  location: string | null;
  hostId: string | null;
  hostName: string | null;
  bookedBy: string | null;
  outcome: TourOutcome | null;
  note: string | null;
  next: { due_at: string; notes: string | null } | null;
}

interface ToursResponse {
  counts: Record<TourGroup, number>;
  rows: TourListRow[];
  total: number;
  stats: TourStats | null;
  filters: { locations: { id: string; name: string }[]; hosts: { id: string; name: string }[] } | null;
}

const PILLS: { key: TourGroup; label: string; tone: string }[] = [
  { key: "needs_update", label: "Needs update", tone: "border-red-200 text-red-700" },
  { key: "today", label: "Today", tone: "border-amber-200 text-amber-700" },
  { key: "tomorrow", label: "Tomorrow", tone: "border-emerald-200 text-emerald-700" },
  { key: "week", label: "This week", tone: "border-emerald-200 text-emerald-700" },
  { key: "later", label: "Later", tone: "border-emerald-200 text-emerald-700" },
  { key: "done", label: "Done", tone: "border-slate-200 text-slate-600" },
];

const COUNT_TONE: Record<TourGroup, string> = {
  needs_update: "bg-red-600 text-white",
  today: "bg-amber-600 text-white",
  tomorrow: "bg-emerald-600 text-white",
  week: "bg-emerald-600 text-white",
  later: "bg-emerald-600 text-white",
  done: "bg-slate-200 text-slate-700",
};

const CHIP_STYLES = {
  past: { box: "border-red-200", big: "bg-red-600 text-white", side: "border-red-200 text-red-700" },
  overdue: { box: "border-red-200", big: "bg-red-600 text-white", side: "border-red-200 text-red-700" },
  today: { box: "border-amber-200", big: "bg-amber-600 text-white", side: "border-amber-200 text-amber-700" },
  soon: { box: "border-emerald-200", big: "bg-emerald-600 text-white", side: "border-emerald-200 text-emerald-700" },
  far: { box: "border-slate-200", big: "bg-slate-600 text-white", side: "border-slate-200 text-slate-600" },
} as const;

const OUTCOME_STYLES: Record<TourOutcome, string> = {
  came: "bg-emerald-600 text-white",
  no_show: "bg-red-600 text-white",
  cancelled: "bg-slate-600 text-white",
};

const QUICK_DAYS: [string, number][] = [["Tomorrow", 1], ["In 3 days", 3], ["Next week", 7]];

/** The header over a date: "Today · Thu 5 Nov", "Tomorrow · Fri 6 Nov", "Tue 3 Nov". */
function headerLabel(key: string): string {
  const tomorrow = istDayKey(new Date(Date.now() + 24 * 60 * 60 * 1000));
  return key === tomorrow ? `Tomorrow · ${dayLabel(key)}` : dayLabel(key);
}

/** Today's date in IST as yyyy-MM-dd. */
function istToday(): string {
  return new Date(Date.now() + 330 * 60 * 1000).toISOString().slice(0, 10);
}

async function call(url: string, method: string, body: Record<string, unknown>): Promise<string | null> {
  const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (res.ok) return null;
  const err = await res.json().catch(() => ({}));
  const e = err as { error?: string; details?: { message?: string }[] };
  return e.details?.[0]?.message ?? e.error ?? "Could not save";
}

function Chips({ options, selected, onPick }: { options: readonly string[]; selected: string; onPick: (v: string) => void }) {
  return (
    <div className="flex flex-wrap gap-2">
      {options.map((o) => (
        <button
          key={o}
          type="button"
          onClick={() => onPick(o)}
          className={`rounded-full border px-3 py-1 text-sm ${
            selected === o ? "border-primary bg-primary/10 font-medium text-primary" : "hover:bg-muted"
          }`}
        >
          {o}
        </button>
      ))}
    </div>
  );
}

type PanelMode = "came" | "no_show" | "cancelled" | "reschedule" | "host";

/** What happens after an outcome: a next step with a date, or the lead is closed with a reason. */
const REBOOK_CHOICES = ["Book a new tour", "Call to rebook", "Close the lead"] as const;
const CAME_CHOICES = ["Next step", "Not continuing"] as const;

function TourPanel({
  row,
  mode,
  users,
  onDone,
  onCancel,
}: {
  row: TourListRow;
  mode: PanelMode;
  users: { id: string; full_name: string; role: string }[];
  onDone: () => void;
  onCancel: () => void;
}) {
  const [note, setNote] = useState("");
  const [choice, setChoice] = useState<string>(mode === "came" ? CAME_CHOICES[0] : REBOOK_CHOICES[1]);
  const [when, setWhen] = useState("");
  const [nextText, setNextText] = useState(mode === "came" ? "" : "Call to rebook the tour");
  const [reason, setReason] = useState("");
  const [host, setHost] = useState(row.hostId ?? "");
  const [busy, setBusy] = useState(false);

  const closing = choice === "Not continuing" || choice === "Close the lead";
  const isOutcome = mode === "came" || mode === "no_show" || mode === "cancelled";
  // Judged from the value itself: a quick pick sets it without the date input reporting a status.
  const dateOk = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(when) && new Date(`${when}:00+05:30`).getTime() > Date.now();

  const canSave =
    !busy &&
    (mode === "reschedule"
      ? dateOk
      : mode === "host"
        ? true
        : (mode !== "came" || !!note.trim()) && (closing ? !!reason : dateOk && !!nextText.trim()));

  const pickChoice = (c: string) => {
    setChoice(c);
    if (c === "Book a new tour") setNextText("Book a new tour");
    if (c === "Call to rebook") setNextText("Call to rebook the tour");
    if (c === "Next step") setNextText("");
  };

  const save = async () => {
    setBusy(true);
    try {
      if (mode === "reschedule") {
        const error = await call(`/api/tours/${row.id}`, "PATCH", { action: "reschedule", meeting_start_at: when });
        if (error) throw new Error(error);
        toast.success("Tour rescheduled");
      } else if (mode === "host") {
        const error = await call(`/api/tours/${row.id}`, "PATCH", { action: "set_host", tour_host_id: host || null });
        if (error) throw new Error(error);
        toast.success("Host updated");
      } else {
        const outcomeError = await call(`/api/tours/${row.id}`, "PATCH", { action: "outcome", outcome: mode, note: note.trim() || undefined });
        if (outcomeError) throw new Error(outcomeError);
        // The outcome is saved; what follows is a second step, so say which one failed.
        let followError: string | null;
        if (closing) {
          const key = NOT_INTERESTED_REASONS.find((r) => NOT_INTERESTED_REASON_LABELS[r] === reason) as NotInterestedReason;
          followError = await call(`/api/leads/${row.leadId}/not-interested`, "POST", { reason: key });
        } else {
          followError = await call(`/api/leads/${row.leadId}/activities`, "POST", {
            type: "note",
            subject: "Next step",
            description: nextText.trim(),
            follow_up_date: when,
            follow_up_notes: nextText.trim(),
            closes_open_follow_ups: true,
          });
        }
        if (followError) {
          toast.warning(`Outcome saved, but the next step was not: ${followError}`);
          onDone();
          return;
        }
        toast.success(closing ? "Tour recorded and lead closed" : "Tour recorded");
      }
      onDone();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save");
    } finally {
      setBusy(false);
    }
  };

  const hosts = users.filter((u) => (LEAD_HANDLER_ROLES as readonly string[]).includes(u.role));

  return (
    <div className="space-y-3 rounded-lg border bg-muted/30 p-3" onClick={(e) => e.stopPropagation()}>
      {mode === "came" && (
        <div className="space-y-1">
          <div className="text-sm font-medium">How did it go?</div>
          <Textarea autoFocus rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Liked the cabin, wants 6 seats from Jan" />
        </div>
      )}
      {(mode === "no_show" || mode === "cancelled") && (
        <div className="space-y-1">
          <div className="text-sm font-medium">{mode === "cancelled" ? "Who cancelled, and why? (optional)" : "Anything to add? (optional)"}</div>
          <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Customer called, travelling" />
        </div>
      )}

      {isOutcome && (
        <div className="space-y-1">
          <div className="text-sm font-medium">{mode === "came" ? "What next?" : "What now?"}</div>
          <Chips options={mode === "came" ? CAME_CHOICES : REBOOK_CHOICES} selected={choice} onPick={pickChoice} />
        </div>
      )}

      {isOutcome && closing && (
        <div className="space-y-1">
          <div className="text-sm font-medium">Why?</div>
          <Chips options={NOT_INTERESTED_REASONS.map((r) => NOT_INTERESTED_REASON_LABELS[r])} selected={reason} onPick={setReason} />
          <div className="text-xs text-muted-foreground">No date needed. The lead is closed, and stays in the list so it can be reopened.</div>
        </div>
      )}

      {isOutcome && !closing && (
        <div className="space-y-2">
          <div className="text-xs font-medium text-muted-foreground">Next step (required)</div>
          <div className="flex flex-wrap gap-2">
            {QUICK_DAYS.map(([text, days]) => (
              <button
                key={text}
                type="button"
                onClick={() => setWhen(followUpInDays(days))}
                className={`rounded-full border px-3 py-1 text-sm ${when === followUpInDays(days) ? "border-primary bg-primary/10 font-medium text-primary" : "hover:bg-muted"}`}
              >
                {text}
              </button>
            ))}
          </div>
          <FollowUpDateTimeInput value={when} onChange={setWhen} minDate={istToday()} />
          <Input value={nextText} onChange={(e) => setNextText(e.target.value)} placeholder="What needs to happen?" />
        </div>
      )}

      {mode === "reschedule" && (
        <div className="space-y-2">
          <div className="text-xs font-medium text-muted-foreground">New date and time (the host stays the same)</div>
          <FollowUpDateTimeInput value={when} onChange={setWhen} minDate={istToday()} />
        </div>
      )}

      {mode === "host" && (
        <label className="block space-y-1">
          <span className="text-sm font-medium">Who will host it?</span>
          <select value={host} onChange={(e) => setHost(e.target.value)} className="h-9 w-full rounded-md border bg-background px-2 text-sm">
            <option value="">No host yet</option>
            {hosts.map((u) => (
              <option key={u.id} value={u.id}>{u.full_name}</option>
            ))}
          </select>
          <span className="block text-xs text-muted-foreground">The reminder 2 hours before goes to the new host.</span>
        </label>
      )}

      <div className="flex gap-2">
        <Button type="button" size="sm" disabled={!canSave} onClick={() => void save()}>
          {busy && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
          {isOutcome && closing ? "Save and close lead" : "Save"}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}

function TourRowView({
  row,
  users,
  onChanged,
}: {
  row: TourListRow;
  users: { id: string; full_name: string; role: string }[];
  onChanged: () => void;
}) {
  const [panel, setPanel] = useState<PanelMode | null>(null);
  const chip = tourChip({ start: row.start, end: row.end, outcome: row.outcome, cutoff: null }, new Date());
  const style = CHIP_STYLES[chip.state];
  const needsUpdate = row.bucket === "needs_update";
  const isDone = row.bucket === "done" || row.bucket === "legacy";
  const want = [row.workspaceType ? (WORKSPACE_TYPE_LABELS[row.workspaceType] ?? row.workspaceType.replace(/_/g, " ")) : null, row.seats ? `${row.seats} seat${row.seats === 1 ? "" : "s"}` : null]
    .filter(Boolean)
    .join(" · ");

  const finish = () => {
    setPanel(null);
    onChanged();
  };

  return (
    <div className="space-y-1.5 px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Link href={`/leads/${row.leadId}/activity`} className="truncate font-medium text-primary hover:underline">{row.name}</Link>
          <span className="shrink-0 font-mono text-xs text-muted-foreground">#{row.leadNumber}</span>
        </div>
        <StatusBadge type="lead_status" value={row.leadStatus} />
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-sm text-muted-foreground">
        {want && <span className="text-foreground">{want}</span>}
        {row.phone && (
          <a href={`tel:${row.phone.replace(/[^\d+]/g, "")}`} className="inline-flex items-center gap-1 font-semibold text-primary hover:underline">
            <Phone className="h-3.5 w-3.5 shrink-0" />
            {row.phone}
          </a>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-sm">
        {isDone ? (
          <span className="inline-flex items-stretch overflow-hidden rounded-lg border border-slate-200">
            <span className={`flex items-center px-2.5 py-0.5 font-extrabold ${row.outcome ? OUTCOME_STYLES[row.outcome] : "bg-slate-200 text-slate-700"}`}>
              {row.outcome ? (row.outcome === "came" ? "✓ " : row.outcome === "no_show" ? "✗ " : "") + TOUR_OUTCOME_LABELS[row.outcome] : "Outcome not recorded"}
            </span>
            <span className="flex items-center border-l bg-background px-2.5 py-0.5 font-semibold text-slate-600">{datePart(row.start)}, {timePart(row.start)}</span>
          </span>
        ) : (
          <span className={`inline-flex items-stretch overflow-hidden rounded-lg border text-sm ${style.box}`}>
            <span className={`flex items-center px-2.5 py-0.5 font-extrabold ${style.big}`}>{chip.big}</span>
            <span className={`flex items-center border-l bg-background px-2.5 py-0.5 font-semibold ${style.side}`}>{chip.when}</span>
            {!needsUpdate && (
              <DropdownMenu>
                <DropdownMenuTrigger className={`flex items-center gap-0.5 border-l bg-background px-2 py-0.5 text-xs text-muted-foreground hover:bg-muted ${style.side}`} aria-label="Change this tour">
                  change <ChevronDown className="h-3 w-3" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-60">
                  <DropdownMenuItem onSelect={() => setPanel("reschedule")}>
                    <div><div className="font-medium">Reschedule…</div><div className="text-xs text-muted-foreground">New date and time</div></div>
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => setPanel("host")}>
                    <div><div className="font-medium">Change host…</div><div className="text-xs text-muted-foreground">Reminders follow the new host</div></div>
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => setPanel("cancelled")}>
                    <div><div className="font-medium">Cancel tour…</div><div className="text-xs text-muted-foreground">Asks why, then the next step</div></div>
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </span>
        )}
        {needsUpdate && <span className="text-sm font-semibold text-red-700">What happened?</span>}
      </div>

      <div className="flex flex-wrap items-center gap-x-2 text-[13px] text-muted-foreground">
        {row.location && (
          <span className="inline-flex items-center gap-1"><MapPin className="h-3.5 w-3.5 shrink-0" />{row.location}</span>
        )}
        <span>
          · Host:{" "}
          {row.hostName ? (
            <b className="font-semibold text-foreground">{row.hostName}</b>
          ) : isDone ? (
            <b className="font-semibold text-foreground">none</b>
          ) : (
            <button type="button" className="font-semibold text-amber-700 hover:underline" onClick={() => setPanel("host")}>none yet · pick a host</button>
          )}
        </span>
        {row.bookedBy && <span>· booked by {row.bookedBy}</span>}
      </div>

      {isDone && row.note && (
        <div className="truncate text-[13px] text-muted-foreground">“{row.note.split("\n").filter(Boolean).slice(-1)[0].replace(/^Tour [^:]+: /, "")}”</div>
      )}
      {isDone && (
        <div className="text-[13px] text-muted-foreground">
          {["won", "lost", "junk"].includes(row.leadStatus) ? (
            <><b className="text-foreground">Result:</b> {row.leadStatus === "lost" ? `closed as Lost${row.lostReason ? ` · ${row.lostReason.replace(/_/g, " ")}` : ""}` : row.leadStatus === "won" ? "customer won" : "closed as junk"}</>
          ) : row.next ? (
            <><b className="text-foreground">Next:</b> {row.next.notes || "Follow up"} · due {datePart(row.next.due_at)}</>
          ) : (
            <><b className="text-foreground">Next:</b> <span className="text-amber-700">no next step set</span></>
          )}
        </div>
      )}

      {needsUpdate && !panel && (
        <div className="flex flex-wrap gap-2 pt-1">
          <Button type="button" size="sm" variant="outline" className="border-emerald-200 bg-emerald-50 font-semibold text-emerald-700 hover:bg-emerald-100" onClick={() => setPanel("came")}>✓ Came</Button>
          <Button type="button" size="sm" variant="outline" onClick={() => setPanel("no_show")}>Didn&apos;t come</Button>
          <Button type="button" size="sm" variant="outline" onClick={() => setPanel("reschedule")}>Reschedule</Button>
          <Button type="button" size="sm" variant="outline" className="text-red-600 hover:text-red-700" onClick={() => setPanel("cancelled")}>Cancelled</Button>
        </div>
      )}

      {panel && <TourPanel row={row} mode={panel} users={users} onDone={finish} onCancel={() => setPanel(null)} />}
    </div>
  );
}

export function ToursView({ onCounts }: { onCounts?: (counts: Record<TourGroup, number>) => void }) {
  const { users } = useUsers();
  const [group, setGroup] = useState<TourGroup>("needs_update");
  const [days, setDays] = useState(30);
  const [locationId, setLocationId] = useState("");
  const [host, setHost] = useState("");
  const [data, setData] = useState<ToursResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const params = new URLSearchParams({ group, days: String(days) });
    if (group === "done" && locationId) params.set("location_id", locationId);
    if (group === "done" && host) params.set("host", host);
    try {
      const res = await fetch(`/api/tours?${params}`);
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "Could not load tours");
      const json = (await res.json()) as ToursResponse;
      setData(json);
      setError(null);
      onCounts?.(json.counts);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load tours");
    } finally {
      setLoading(false);
    }
  }, [group, days, locationId, host, onCounts]);

  useEffect(() => {
    setLoading(true);
    void load();
  }, [load]);

  // The tours under their date headers, in the order the group calls for.
  const byDay = useMemo(() => {
    const map = new Map<string, TourListRow[]>();
    for (const r of data?.rows ?? []) {
      const key = istDayKey(r.start);
      (map.get(key) ?? map.set(key, []).get(key)!).push(r);
    }
    return [...map];
  }, [data]);

  const stats = data?.stats;
  const pct = (n: number) => (stats && stats.total > 0 ? ` · ${Math.round((n / stats.total) * 100)}%` : "");

  return (
    <div className="space-y-3">
      <div className="sticky top-0 z-10 flex flex-wrap gap-2 border-b bg-background py-3">
        {PILLS.map((p) => {
          const n = data?.counts[p.key] ?? 0;
          const on = group === p.key;
          return (
            <button
              key={p.key}
              type="button"
              onClick={() => setGroup(p.key)}
              className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-sm font-semibold ${p.tone} ${on ? "ring-2 ring-foreground ring-inset" : "hover:bg-muted"}`}
            >
              {p.label}
              <span className={`rounded-full px-1.5 text-[11px] font-bold ${COUNT_TONE[p.key]}`}>{n}</span>
            </button>
          );
        })}
      </div>

      {group === "done" && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <select value={days} onChange={(e) => setDays(Number(e.target.value))} className="h-8 rounded-md border bg-background px-2 text-sm" aria-label="Date range">
              <option value={7}>Last 7 days</option>
              <option value={30}>Last 30 days</option>
              <option value={90}>Last 90 days</option>
            </select>
            <select value={locationId} onChange={(e) => setLocationId(e.target.value)} className="h-8 rounded-md border bg-background px-2 text-sm" aria-label="Location">
              <option value="">All locations</option>
              {data?.filters?.locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
            <select value={host} onChange={(e) => setHost(e.target.value)} className="h-8 rounded-md border bg-background px-2 text-sm" aria-label="Host">
              <option value="">All hosts</option>
              <option value="none">No host</option>
              {data?.filters?.hosts.map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}
            </select>
          </div>
          {stats && (
            <div className="grid grid-cols-2 overflow-hidden rounded-lg border sm:grid-cols-4">
              {[
                { label: "Tours recorded", value: String(stats.total), sub: "", tone: "" },
                { label: "Came", value: String(stats.came), sub: pct(stats.came), tone: "text-emerald-700" },
                { label: "Didn't come", value: String(stats.noShow), sub: pct(stats.noShow), tone: "text-red-700" },
                { label: "Led to a proposal or deal", value: String(stats.convertedOfCame), sub: ` · of ${stats.came} who came`, tone: "" },
              ].map((s) => (
                <div key={s.label} className="border-b border-r px-4 py-3 last:border-r-0">
                  <div className="text-xs text-muted-foreground">{s.label}</div>
                  <div className={`text-2xl font-extrabold ${s.tone}`}>{s.value}<span className="text-sm font-semibold">{s.sub}</span></div>
                </div>
              ))}
            </div>
          )}
          <div className="text-xs text-muted-foreground">Tours from before outcomes were recorded show as &quot;Outcome not recorded&quot; and are left out of these numbers.</div>
        </div>
      )}

      {error && <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}

      {loading && !data ? (
        <div className="flex items-center gap-2 py-10 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading tours…</div>
      ) : (data?.rows.length ?? 0) === 0 ? (
        <div className="rounded-lg border px-4 py-10 text-center text-sm text-muted-foreground">
          {group === "needs_update" ? "No tours are waiting for an update." : group === "done" ? "No completed tours in this period." : "No tours booked for this period."}
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border">
          {byDay.map(([key, rows]) => (
            <div key={key}>
              <div className="flex justify-between border-b border-t bg-muted/40 px-4 py-2 text-[13px] first:border-t-0">
                <b className={group === "needs_update" ? "text-red-700" : group === "today" ? "text-amber-700" : group === "done" ? "" : "text-emerald-700"}>{headerLabel(key)}</b>
                <span className="text-muted-foreground">{rows.length} tour{rows.length === 1 ? "" : "s"}</span>
              </div>
              <div className="divide-y">
                {rows.map((r) => <TourRowView key={r.id} row={r} users={users} onChanged={() => void load()} />)}
              </div>
            </div>
          ))}
          {data && data.total > data.rows.length && (
            <div className="border-t px-4 py-3 text-center text-sm text-muted-foreground">Showing the first {data.rows.length} of {data.total}. Narrow the dates to see the rest.</div>
          )}
        </div>
      )}
    </div>
  );
}
