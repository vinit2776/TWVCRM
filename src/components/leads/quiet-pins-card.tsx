"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Pin } from "lucide-react";
import { pinLabel } from "@/lib/pin-age";

interface QuietPin {
  id: string;
  first_name: string;
  last_name: string;
  _pin: { daysPinned: number; daysQuiet: number; quiet: boolean; pinnedBy: string | null };
}

/**
 * Pins that have gone quiet: a pin keeps a lead in front of the team and exempts it from going
 * stale, so one nobody has touched for a fortnight is probably forgotten. Listed here so it gets
 * either a next step or an unpin. Admin and manager also see who pinned each. Hidden when none.
 */
export function QuietPinsCard() {
  const [rows, setRows] = useState<QuietPin[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/leads?pinned=true&view=all&limit=100")
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (cancelled || !j) return;
        const quiet = ((j.data ?? []) as QuietPin[]).filter((l) => l._pin?.quiet).sort((a, b) => b._pin.daysQuiet - a._pin.daysQuiet);
        setRows(quiet);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  if (!rows || rows.length === 0) return null;

  return (
    <section className="overflow-hidden rounded-lg border">
      <div className="flex flex-wrap items-center gap-2 border-b bg-muted/30 px-4 py-3">
        <Pin className="h-4 w-4 text-amber-600" />
        <h2 className="text-base font-semibold">Pins that have gone quiet</h2>
        <span className="rounded-full border border-red-200 bg-red-50 px-2.5 py-0.5 text-xs font-bold text-red-700">{rows.length}</span>
        <p className="min-w-0 flex-1 basis-64 text-sm text-muted-foreground">Pinned and untouched for 14 days or more. Do the next thing, or unpin it.</p>
      </div>
      <ul>
        {rows.map((l) => (
          <li key={l.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 border-b px-4 py-2.5 last:border-b-0">
            <Link href={`/leads/${l.id}/activity`} className="font-semibold text-primary hover:underline">{`${l.first_name} ${l.last_name}`.trim()}</Link>
            <span className="text-sm text-red-700">{pinLabel(l._pin).text}</span>
            {l._pin.pinnedBy && <span className="text-sm text-muted-foreground">pinned by {l._pin.pinnedBy}</span>}
          </li>
        ))}
      </ul>
    </section>
  );
}
