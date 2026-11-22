"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Eye } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

interface Item { id: string; leadId: string; name: string; addedBy: string | null; reason: string; daysLeft: number }

/**
 * Leads Home: what colleagues asked this person to keep an eye on. Nothing to do; Got it or Not for
 * me takes it off the list (the person who asked sees the answer on the lead), and it clears itself
 * after 14 days. Hidden when nothing is waiting or the switch is off.
 */
export function KeptInformedCard() {
  const [rows, setRows] = useState<Item[] | null>(null);
  const load = useCallback(() => {
    fetch("/api/leads/kept-informed").then((r) => (r.ok ? r.json() : null)).then((j) => j && setRows(j.rows ?? [])).catch(() => {});
  }, []);
  useEffect(load, [load]);

  const answer = async (it: Item, a: "got_it" | "not_for_me") => {
    const res = await fetch(`/api/leads/${it.leadId}/watchers`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ answer: a }) });
    if (!res.ok) return void toast.error((await res.json().catch(() => ({}))).error ?? "Could not do that");
    toast.success(a === "got_it" ? "Marked as seen." : "Noted: you’re not the right person.");
    load();
  };

  if (!rows || rows.length === 0) return null;
  return (
    <section className="overflow-hidden rounded-lg border">
      <div className="flex flex-wrap items-center gap-2 border-b bg-muted/30 px-4 py-3">
        <Eye className="h-4 w-4 text-indigo-600" />
        <h2 className="text-base font-semibold">Kept informed</h2>
        <span className="rounded-full border border-indigo-200 bg-indigo-50 px-2.5 py-0.5 text-xs font-bold text-indigo-800">{rows.length}</span>
        <p className="min-w-0 flex-1 basis-64 text-sm text-muted-foreground">Colleagues asked you to keep an eye on these. You have nothing to do. Tap Got it when you have seen it.</p>
      </div>
      <ul>
        {rows.map((it) => (
          <li key={it.id} className="space-y-1.5 border-b px-4 py-3 last:border-b-0">
            <div className="flex flex-wrap items-baseline gap-x-3">
              <Link href={`/leads/${it.leadId}/activity`} className="font-semibold text-primary hover:underline">{it.name}</Link>
              <span className="text-xs text-muted-foreground">Clears itself in {it.daysLeft} day{it.daysLeft === 1 ? "" : "s"}</span>
            </div>
            <div className="rounded-md border border-indigo-200 bg-indigo-50 px-2.5 py-1 text-sm text-indigo-800">{it.addedBy ?? "Someone"} kept you informed: {it.reason}</div>
            <div className="flex gap-2">
              <Button size="sm" onClick={() => answer(it, "got_it")}>Got it</Button>
              <Button size="sm" variant="outline" onClick={() => answer(it, "not_for_me")}>Not for me</Button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
