"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Hourglass } from "lucide-react";
import { PARK_REASON_LABELS, type ParkReason } from "@/lib/space-parking";
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
}

/**
 * Real enquiries we could not offer yet: no follow-up dates and nobody chases them. Grouped by what
 * is missing (a centre that is not open, an area, no space of that size) with the oldest wait first.
 * Open one to take it out once space is available. Reports its count to the navigation.
 */
export function WaitingForSpaceView({ onCount }: { onCount?: (n: number) => void }) {
  const [rows, setRows] = useState<WaitingRow[] | null>(null);
  const [enabled, setEnabled] = useState(true);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/leads/waiting-for-space")
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (cancelled || !j) return;
        setEnabled(!!j.enabled);
        setRows(j.rows as WaitingRow[]);
        onCount?.(j.total as number);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [onCount]);

  if (rows === null) return <p className="py-8 text-sm text-muted-foreground">Loading…</p>;
  if (!enabled) return <p className="py-8 text-sm text-muted-foreground">Waiting for space is not switched on yet.</p>;
  if (rows.length === 0) return <p className="py-8 text-center text-sm text-muted-foreground">Nobody is waiting for space.</p>;

  const groups = new Map<string, WaitingRow[]>();
  for (const r of rows) groups.set(r.group, [...(groups.get(r.group) ?? []), r]);

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">Real enquiries we could not offer yet. No follow-up dates, nobody chases them, and they come back when a person takes them out.</p>
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
                <div className="text-sm text-muted-foreground">{PARK_REASON_LABELS[r.reason as ParkReason] ?? r.reason}{r.note ? ` · ${r.note}` : ""}{r.lookAgainOn ? ` · look again on ${formatDate(r.lookAgainOn)}` : ""}</div>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
