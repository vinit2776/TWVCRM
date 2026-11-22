"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Hourglass } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { PARK_REASON_LABELS, type ParkReason } from "@/lib/space-parking";
import type { DemandRow } from "@/lib/space-review";
import { formatDate } from "@/lib/utils";

interface WaitingRow {
  id: string;
  leadId: string;
  name: string;
  group: string;
  want: string | null;
  reason: string;
  note: string | null;
  lookAgainOn: string | null;
  state: string;
  parkedBy: string | null;
  daysWaiting: number;
  parkedAt: string;
  matchedNote: string | null;
  reviewDue: boolean;
}

/**
 * Real enquiries we could not offer yet: no follow-up dates and nobody chases them. Grouped by what
 * is missing (a centre that is not open, an area, no space of that size) with the oldest wait first.
 * Open one to take it out once space is available. Reports its count to the navigation.
 */
export function WaitingForSpaceView({ onCount }: { onCount?: (n: number) => void }) {
  const [rows, setRows] = useState<WaitingRow[] | null>(null);
  const [enabled, setEnabled] = useState(true);
  const [demand, setDemand] = useState<DemandRow[]>([]);
  const [reviewDays, setReviewDays] = useState(60);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/leads/waiting-for-space")
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (cancelled || !j) return;
        setEnabled(!!j.enabled);
        setRows(j.rows as WaitingRow[]);
        setDemand((j.demand as DemandRow[]) ?? []);
        setReviewDays((j.reviewDays as number) ?? 60);
        onCount?.(j.total as number);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [onCount, reloadKey]);

  const review = async (leadId: string, action: "keep" | "close", done: string) => {
    const res = await fetch(`/api/leads/${leadId}/park/review`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action }) });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) return void toast.error(json.error ?? "Could not do that");
    toast.success(done);
    setReloadKey((k) => k + 1);
  };

  if (rows === null) return <p className="py-8 text-sm text-muted-foreground">Loading…</p>;
  if (!enabled) return <p className="py-8 text-sm text-muted-foreground">Waiting for space is not switched on yet.</p>;
  if (rows.length === 0) return <p className="py-8 text-center text-sm text-muted-foreground">Nobody is waiting for space.</p>;

  const groups = new Map<string, WaitingRow[]>();
  for (const r of rows) groups.set(r.group, [...(groups.get(r.group) ?? []), r]);

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">Real enquiries we could not offer yet. No follow-up dates, nobody chases them, and they come back when a person takes them out.</p>
      {demand.length > 0 && (
        <section className="overflow-hidden rounded-lg border">
          <div className="border-b bg-muted/30 px-4 py-2.5"><h2 className="text-sm font-semibold">Where the demand is</h2><p className="text-xs text-muted-foreground">What people asked for that we cannot offer yet, biggest first. Where they are asking for a centre we do not have, this is the case for one.</p></div>
          <table className="w-full text-sm">
            <thead><tr className="text-left text-xs text-muted-foreground"><th className="px-4 py-1.5 font-medium">Where</th><th className="px-2 py-1.5 font-medium">Waiting</th><th className="px-2 py-1.5 font-medium">Seats asked for</th><th className="px-4 py-1.5 font-medium">Longest wait</th></tr></thead>
            <tbody>
              {demand.map((d) => (
                <tr key={d.group} className="border-t"><td className="px-4 py-1.5 font-medium">{d.group}</td><td className="px-2 py-1.5">{d.waiting}</td><td className="px-2 py-1.5">{d.seats || "—"}{d.seatsKnown < d.waiting && d.seats > 0 ? <span className="text-xs text-muted-foreground"> ({d.seatsKnown} of {d.waiting} said)</span> : null}</td><td className="px-4 py-1.5">{d.oldestDays} day{d.oldestDays === 1 ? "" : "s"}</td></tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
      {[...groups].map(([group, list]) => (
        <section key={group} className="overflow-hidden rounded-lg border">
          <div className="flex items-center gap-2 border-b bg-muted/30 px-4 py-2.5">
            <Hourglass className="h-4 w-4 text-amber-600" />
            <h2 className="text-sm font-semibold">{group}</h2>
            <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-bold text-amber-800">{list.length} waiting</span>
          </div>
          <ul>
            {list.map((r) => (
              <li key={r.id} className="space-y-0.5 border-b px-4 py-2.5 last:border-b-0">
                <div className="flex flex-wrap items-baseline gap-x-2.5">
                  <Link href={`/leads/${r.leadId}/activity`} className="font-semibold text-primary hover:underline">{r.name}</Link>
                  {r.want && <span className="text-sm capitalize">{r.want}</span>}
                  <span className="text-xs text-muted-foreground">waiting {r.daysWaiting} day{r.daysWaiting === 1 ? "" : "s"}{r.parkedBy ? ` · kept on file by ${r.parkedBy}` : ""}</span>
                  {r.state === "space_available" && <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-bold text-emerald-800">Space available</span>}
                </div>
                {r.state === "space_available" && r.matchedNote && <div className="text-sm font-medium text-emerald-700">{r.matchedNote}. Open the lead and take it out of Waiting to make an offer.</div>}
                {r.reviewDue && (
                  <div className="flex flex-wrap items-center gap-2 rounded-md border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-sm text-amber-800">
                    <span className="flex-1">Waiting over {reviewDays} days. Still waiting, or close as no response?</span>
                    <Button size="sm" variant="outline" className="h-8 bg-white" onClick={() => review(r.leadId, "keep", "Kept waiting. The clock restarts.")}>Still waiting</Button>
                    <Button size="sm" variant="outline" className="h-8 border-red-200 bg-white text-red-700" onClick={() => window.confirm(`Close ${r.name} as no response?`) && review(r.leadId, "close", "Closed as no response. Nothing was sent to the customer.")}>Close as no response</Button>
                  </div>
                )}
                <div className="text-sm text-muted-foreground">{PARK_REASON_LABELS[r.reason as ParkReason] ?? r.reason}{r.note ? ` · ${r.note}` : ""}{r.lookAgainOn ? ` · look again on ${formatDate(r.lookAgainOn)}` : ""}</div>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
