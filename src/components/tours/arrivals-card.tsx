"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { TourReportSheet } from "@/components/tours/tour-report-sheet";
import { useTourArrivalsEnabled } from "@/hooks/use-tour-arrivals";
import { useCurrentUser } from "@/providers/current-user-provider";
import { formatDate } from "@/lib/utils";
import type { ArrivalState } from "@/lib/tour-reports";

interface Arrival {
  id: string;
  leadId: string;
  name: string;
  start: string;
  location: string | null;
  hostName: string | null;
  accompanierId: string | null;
  accompanierName: string | null;
  bookedBy: string | null;
  arrivedAt: string | null;
  state: ArrivalState;
  workspaceType: string | null;
  seats: number | null;
  startDate: string | null;
  quotedPerSeat: number | null;
  extras: string[];
}

const time = (iso: string) => new Date(iso).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: "Asia/Kolkata" });

function Chips({ a }: { a: Arrival }) {
  const chips = [
    a.workspaceType && `${a.workspaceType.replace(/_/g, " ")}${a.seats ? ` · ${a.seats} seats` : ""}`,
    a.startDate && `From ${formatDate(a.startDate)}`,
    a.quotedPerSeat && `Quoted ₹${a.quotedPerSeat.toLocaleString("en-IN")}/seat`,
    ...a.extras.map((e) => e.replace(/_/g, " ")),
  ].filter(Boolean) as string[];
  if (chips.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {chips.map((c) => (
        <span key={c} className="rounded-full bg-muted px-2.5 py-0.5 text-xs capitalize text-slate-700">{c}</span>
      ))}
    </div>
  );
}

/**
 * Today's tours for the person receiving the customers: who is coming and what they need, then
 * Customer arrived or Didn't come, then the visit report. A floor incharge sees the tours at their
 * own centre; nothing else about the lead can be changed from here. Behind the arrivals switch;
 * hidden when there is nothing today.
 */
export function ArrivalsCard() {
  const enabled = useTourArrivalsEnabled();
  const { user } = useCurrentUser();
  const [rows, setRows] = useState<Arrival[] | null>(null);
  const [report, setReport] = useState<Arrival | null>(null);
  const [noteFor, setNoteFor] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    fetch("/api/tours/arrivals")
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => j && setRows(j.data as Arrival[]))
      .catch(() => {});
  }, []);
  useEffect(() => {
    if (!enabled) return;
    load();
    // A customer is marked arrived in one place and reported in another; keep the list fresh.
    const onFocus = () => load();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [enabled, load]);

  if (!enabled || !rows || rows.length === 0) return null;

  const act = async (a: Arrival, body: Record<string, unknown>, done: string) => {
    setBusy(a.id);
    const res = await fetch(`/api/tours/${a.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const json = await res.json().catch(() => ({}));
    setBusy(null);
    if (!res.ok) return void toast.error(json.error ?? "Could not do that");
    toast.success(done);
    load();
  };
  const saveNote = async (a: Arrival) => {
    const res = await fetch(`/api/tours/${a.id}/report`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ accompanier_note: note }) });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) return void toast.error(json.error ?? "Could not save the note");
    toast.success("Note added to the report.");
    setNoteFor(null);
    setNote("");
  };

  const waiting = rows.filter((r) => r.state === "upcoming" || r.state === "here").length;

  return (
    <section className="overflow-hidden rounded-lg border">
      <div className="flex flex-wrap items-center gap-2 border-b bg-muted/30 px-4 py-3">
        <h2 className="text-base font-semibold">Arrivals today</h2>
        <span className="rounded-full border border-blue-200 bg-blue-50 px-2.5 py-0.5 text-xs font-bold text-blue-700">{waiting} to receive</span>
        <p className="min-w-0 flex-1 basis-64 text-sm text-muted-foreground">Customers booked for a tour. Mark them arrived or not, then write the visit report.</p>
      </div>
      <ul>
        {rows.map((a) => (
          <li key={a.id} className="space-y-2 border-b px-4 py-3 last:border-b-0">
            <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
              <Link href={`/leads/${a.leadId}/activity`} className="text-[15px] font-bold text-primary hover:underline">{a.name}</Link>
              <span className="text-sm text-muted-foreground">
                {time(a.start)}{a.location ? ` · ${a.location}` : ""}{a.bookedBy ? ` · booked by ${a.bookedBy}` : ""} · {a.accompanierName ? `accompanied by ${a.accompanierName}` : "no one accompanying"}
              </span>
              {a.state === "upcoming" && <span className="rounded-full border border-blue-200 bg-blue-50 px-2 py-0.5 text-xs font-bold text-blue-700">Upcoming</span>}
              {a.state === "here" && <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-xs font-bold text-emerald-700">Here now{a.arrivedAt ? ` since ${time(a.arrivedAt)}` : ""}</span>}
              {a.state === "reported" && <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-xs font-bold text-emerald-700">Reported ✓</span>}
              {a.state === "no_show" && <span className="rounded-full border border-red-200 bg-red-50 px-2 py-0.5 text-xs font-bold text-red-700">Did not come</span>}
            </div>
            {(a.state === "upcoming" || a.state === "here") && <Chips a={a} />}
            {a.state === "upcoming" && (
              <div className="flex flex-wrap gap-2">
                <Button size="sm" className="h-9" disabled={busy === a.id} onClick={() => act(a, { action: "arrived" }, "Marked as arrived. The people on this tour were told.")}>Customer arrived</Button>
                <Button size="sm" variant="outline" className="h-9 border-red-200 text-red-700" disabled={busy === a.id} onClick={() => window.confirm(`Mark ${a.name} as a no show?`) && act(a, { action: "outcome", outcome: "no_show" }, "Marked as a no show. The person who booked it was told.")}>Didn&apos;t come</Button>
              </div>
            )}
            {a.state === "here" && (
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" className="h-9" onClick={() => setReport(a)}>Write the visit report</Button>
                <span className="text-xs text-muted-foreground">An outcome, a comment and at least one photo.</span>
              </div>
            )}
            {a.state === "reported" && a.accompanierId === user?.id && (
              noteFor === a.id ? (
                <div className="space-y-2">
                  <Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="What you noticed…" rows={3} />
                  <div className="flex gap-2"><Button size="sm" className="h-9" disabled={!note.trim()} onClick={() => saveNote(a)}>Save note</Button><Button size="sm" variant="outline" className="h-9" onClick={() => setNoteFor(null)}>Cancel</Button></div>
                </div>
              ) : (
                <Button size="sm" variant="outline" className="h-9" onClick={() => { setNoteFor(a.id); setNote(""); }}>Add your note on the visit</Button>
              )
            )}
          </li>
        ))}
      </ul>
      {report && (
        <TourReportSheet
          tourId={report.id}
          customer={report.name}
          accompanierName={report.accompanierName}
          open
          onOpenChange={(o) => !o && setReport(null)}
          onDone={() => { setReport(null); load(); }}
        />
      )}
    </section>
  );
}
