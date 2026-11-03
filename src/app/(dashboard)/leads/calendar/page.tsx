"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ChevronLeft, ChevronRight, Pin } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useUsers } from "@/hooks/use-leads";
import { LEAD_HANDLER_ROLES } from "@/lib/constants";
import { dayLabel, istDayKey } from "@/lib/lead-days";
import { addDaysKey, bucketByDay, weekOf, type CalendarItem } from "@/lib/lead-calendar";

interface CalendarData {
  followups: CalendarItem[];
  overdue: CalendarItem[];
  pinned: { id: string; name: string; handler: string | null }[];
  enquiryTimes: string[];
  actionTimes: string[];
}

// A week heading reads better without "Today ·" / "Yesterday ·" in front of its first day.
const plainDay = (key: string) => dayLabel(key).replace(/^(Today|Yesterday) · /, "");

const istTime = (iso: string) =>
  new Date(iso).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Kolkata" });

const countByDay = (times: string[]) => {
  const out: Record<string, number> = {};
  for (const t of times) out[istDayKey(t)] = (out[istDayKey(t)] ?? 0) + 1;
  return out;
};

function Item({ item, showHandler }: { item: CalendarItem; showHandler: boolean }) {
  const tour = item.type === "tour";
  return (
    <Link
      href={`/leads/${item.leadId}/activity`}
      className={`block rounded-md border-l-4 px-2.5 py-1.5 text-sm hover:bg-muted ${
        item.pinned ? "border-l-amber-500 bg-amber-50" : tour ? "border-l-emerald-500 bg-emerald-50/50" : "border-l-primary bg-primary/5"
      }`}
    >
      <span className="text-xs text-muted-foreground">{istTime(item.at)}{tour ? " · Tour" : ""}{showHandler && item.handler ? ` · ${item.handler}` : ""}</span>
      <div>
        <span className="font-medium">{item.leadName}</span>
        <span className="text-muted-foreground"> · {item.what}</span>
      </div>
    </Link>
  );
}

export default function LeadsCalendarPage() {
  const todayKey = istDayKey(new Date());
  const [view, setView] = useState<"day" | "week">("day");
  const [anchor, setAnchor] = useState(todayKey);
  const [owner, setOwner] = useState("me");
  const [data, setData] = useState<CalendarData | null>(null);
  const [failed, setFailed] = useState(false);
  const { users } = useUsers();

  const days = useMemo(() => (view === "week" ? weekOf(anchor) : [anchor]), [view, anchor]);

  useEffect(() => {
    const params = new URLSearchParams({ from: days[0], to: days[days.length - 1], owner });
    if (view === "day" && anchor === todayKey) params.set("overdue", "true");
    let cancelled = false;
    setFailed(false);
    fetch(`/api/leads/calendar?${params}`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((json) => !cancelled && setData(json.data))
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
  }, [days, owner, view, anchor, todayKey]);

  const byDay = useMemo(() => bucketByDay(data?.followups ?? []), [data]);
  const enquiries = useMemo(() => countByDay(data?.enquiryTimes ?? []), [data]);
  const actions = useMemo(() => countByDay(data?.actionTimes ?? []), [data]);
  const step = view === "week" ? 7 : 1;

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Calendar</h1>
          <p className="text-sm text-muted-foreground">Follow-ups go to whoever is handling the lead.</p>
        </div>
        <Link href="/leads" className="text-sm text-muted-foreground underline underline-offset-2">Back to leads</Link>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex overflow-hidden rounded-lg border">
          {(["day", "week"] as const).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setView(v)}
              className={`px-4 py-1.5 text-sm font-medium ${view === v ? "bg-primary text-primary-foreground" : "hover:bg-muted"}`}
            >
              {v === "day" ? "Day" : "Week"}
            </button>
          ))}
        </div>
        <Button variant="outline" size="icon" onClick={() => setAnchor((a) => addDaysKey(a, -step))} aria-label="Previous"><ChevronLeft className="h-4 w-4" /></Button>
        <Button variant="outline" onClick={() => setAnchor(todayKey)}>Today</Button>
        <Button variant="outline" size="icon" onClick={() => setAnchor((a) => addDaysKey(a, step))} aria-label="Next"><ChevronRight className="h-4 w-4" /></Button>
        <span className="font-semibold">
          {view === "day" ? dayLabel(anchor) : `${plainDay(days[0])} – ${plainDay(days[6])}`}
        </span>
        <div className="ml-auto w-[190px]">
          <Select value={owner} onValueChange={setOwner}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="me">Mine</SelectItem>
              <SelectItem value="all">Everyone</SelectItem>
              {users
                .filter((u) => (LEAD_HANDLER_ROLES as readonly string[]).includes(u.role))
                .map((u) => (
                  <SelectItem key={u.id} value={u.id}>{u.full_name || u.email}</SelectItem>
                ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {data && data.pinned.length > 0 && (
        <div className="rounded-lg border-2 border-amber-400 bg-amber-50 px-3 py-2">
          <div className="flex items-center gap-1.5 text-sm font-semibold"><Pin className="h-4 w-4 fill-amber-500" /> Pinned enquiries <span className="text-xs font-normal text-muted-foreground">shown every day until unpinned</span></div>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {data.pinned.map((p) => (
              <Link key={p.id} href={`/leads/${p.id}/activity`} className="rounded-md bg-amber-200 px-2.5 py-1 text-sm font-medium text-amber-900 hover:bg-amber-300">
                {p.name}{p.handler ? ` · ${p.handler}` : ""}
              </Link>
            ))}
          </div>
        </div>
      )}

      {failed && <p className="text-sm text-red-600">Could not load the calendar. Refresh to try again.</p>}
      {!data && !failed && <p className="text-sm text-muted-foreground">Loading…</p>}

      {data && view === "day" && (
        <div className="space-y-4">
          <div className="text-sm text-muted-foreground">
            {data.followups.length} follow-up{data.followups.length === 1 ? "" : "s"} · {enquiries[anchor] ?? 0} enquir{(enquiries[anchor] ?? 0) === 1 ? "y" : "ies"} received · {actions[anchor] ?? 0} action{(actions[anchor] ?? 0) === 1 ? "" : "s"} logged
          </div>
          {data.overdue.length > 0 && (
            <div className="rounded-lg border border-red-200 bg-red-50 p-3">
              <div className="mb-2 text-sm font-semibold text-red-700">Overdue ({data.overdue.length})</div>
              <div className="space-y-1.5">
                {data.overdue.slice(0, 20).map((i) => (
                  <Link key={i.id} href={`/leads/${i.leadId}/activity`} className="block rounded-md bg-background px-2.5 py-1.5 text-sm hover:bg-muted">
                    <span className="text-xs text-red-600">{dayLabel(istDayKey(i.at))}</span>{" "}
                    <span className="font-medium">{i.leadName}</span>
                    <span className="text-muted-foreground"> · {i.what}</span>
                  </Link>
                ))}
                {data.overdue.length > 20 && <div className="text-xs text-muted-foreground">and {data.overdue.length - 20} more, oldest last</div>}
              </div>
            </div>
          )}
          {data.followups.length === 0 ? (
            <p className="rounded-lg border p-4 text-sm text-muted-foreground">Nothing scheduled for this day.</p>
          ) : (
            <div className="space-y-1.5">{data.followups.map((i) => <Item key={i.id} item={i} showHandler={owner === "all"} />)}</div>
          )}
        </div>
      )}

      {data && view === "week" && (
        <div className="grid gap-3 md:grid-cols-7">
          {days.map((d) => (
            <div key={d} className={`rounded-lg border p-2 ${d === todayKey ? "border-primary bg-primary/5" : ""}`}>
              <button type="button" onClick={() => { setAnchor(d); setView("day"); }} className="w-full text-left">
                <div className="text-sm font-semibold">{plainDay(d)}</div>
                <div className="text-xs text-muted-foreground">{enquiries[d] ?? 0} new · {actions[d] ?? 0} logged</div>
              </button>
              <div className="mt-2 space-y-1.5">
                {(byDay[d] ?? []).map((i) => <Item key={i.id} item={i} showHandler={owner === "all"} />)}
                {(byDay[d] ?? []).length === 0 && <div className="text-xs text-muted-foreground">Nothing scheduled</div>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
