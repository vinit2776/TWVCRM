"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Megaphone, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { LEAD_SOURCES, LEAD_SOURCE_LABELS } from "@/lib/constants";
import { istDayKey, dayLabel } from "@/lib/lead-days";
import { daysBetween, promotionResults, promotionsByDay, type InflowDay, type Promotion } from "@/lib/lead-promotions";
import { formatValue } from "@/lib/lead-value";

type PromotionRow = Promotion & { notes?: string | null };

/** Enquiries received per day, with the days a promotion was running shaded, and what each promotion brought. */
export function InflowChart({ days, locationId, canEdit }: { days: number; locationId: string | null; canEdit: boolean }) {
  const today = istDayKey(new Date());
  const range = useMemo(() => {
    const to = today;
    const from = new Date(Date.parse(`${to}T00:00:00Z`) - (days * 2 - 1) * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    return { from, to, shown: daysBetween(from, to).slice(-days) };
  }, [days, today]);

  const [inflow, setInflow] = useState<Record<string, InflowDay | undefined>>({});
  const [promos, setPromos] = useState<PromotionRow[]>([]);
  const [open, setOpen] = useState(false);

  const load = useCallback(() => {
    const loc = locationId ? `&location_id=${locationId}` : "";
    fetch(`/api/leads/inflow?from=${range.from}&to=${range.to}${loc}`)
      .then((r) => r.json())
      .then((j) => setInflow(Object.fromEntries(Object.entries((j.data ?? {}) as Record<string, { total: number; sources: Record<string, number> }>).map(([d, v]) => [d, { day: d, ...v }]))))
      .catch(() => {});
    fetch(`/api/leads/promotions?from=${range.from}&to=${range.to}`)
      .then((r) => r.json())
      .then((j) => setPromos(j.data ?? []))
      .catch(() => {});
  }, [range, locationId]);

  useEffect(() => { load(); }, [load]);

  const byDay = useMemo(() => promotionsByDay(promos, range.shown, today), [promos, range.shown, today]);
  const results = useMemo(() => promotionResults(promos, inflow, today), [promos, inflow, today]);
  const max = Math.max(1, ...range.shown.map((d) => inflow[d]?.total ?? 0));
  const total = range.shown.reduce((a, d) => a + (inflow[d]?.total ?? 0), 0);

  async function remove(id: string) {
    const res = await fetch(`/api/leads/promotions?id=${id}`, { method: "DELETE" });
    if (!res.ok) { toast.error((await res.json().catch(() => ({}))).error || "Could not remove"); return; }
    toast.success("Promotion removed");
    load();
  }

  return (
    <div className="rounded-lg border bg-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="font-semibold">Enquiries coming in <span className="text-xs font-normal text-muted-foreground">{total} in the last {days} days · amber = a promotion was running</span></div>
        {canEdit && <Button size="sm" variant="outline" onClick={() => setOpen(true)}><Megaphone className="mr-1.5 h-4 w-4" />Add promotion</Button>}
      </div>

      <div className="mt-3 flex h-32 items-end gap-px" role="img" aria-label="Enquiries received per day">
        {range.shown.map((d) => {
          const n = inflow[d]?.total ?? 0;
          const running = byDay[d];
          const sources = Object.entries(inflow[d]?.sources ?? {}).map(([s, c]) => `${LEAD_SOURCE_LABELS[s] ?? s} ${c}`).join(", ");
          return (
            <div key={d} className={`relative flex h-full flex-1 items-end ${running ? "bg-amber-100" : ""}`} title={`${dayLabel(d)}: ${n} enquir${n === 1 ? "y" : "ies"}${sources ? ` (${sources})` : ""}${running ? ` · ${running.map((p) => p.name).join(", ")}` : ""}`}>
              <div className="w-full rounded-t bg-primary" style={{ height: `${n === 0 ? 0 : Math.max(4, (n / max) * 100)}%` }} />
            </div>
          );
        })}
      </div>
      <div className="mt-1 flex justify-between text-[11px] text-muted-foreground"><span>{dayLabel(range.shown[0]).replace(/^(Today|Yesterday) · /, "")}</span><span>Today</span></div>

      {results.length > 0 && (
        <div className="mt-4 space-y-1.5 text-sm">
          {promos.map((p) => {
            const r = results.find((x) => x.id === p.id);
            if (!r) return null;
            const delta = r.enquiries - r.before;
            return (
              <div key={p.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-amber-50 px-3 py-1.5">
                <div>
                  <span className="font-medium">{p.name}</span>
                  <span className="text-xs text-muted-foreground"> · {p.source ? LEAD_SOURCE_LABELS[p.source] ?? p.source : "all sources"} · {p.starts_on}{p.ends_on ? ` to ${p.ends_on}` : " onwards"}</span>
                </div>
                <div className="flex items-center gap-3">
                  <span>{r.enquiries} enquiries <span className="text-xs text-muted-foreground">vs {r.before} in the {r.days} days before ({delta >= 0 ? "+" : ""}{delta})</span></span>
                  {r.costPerEnquiry !== null && <span className="text-xs text-muted-foreground">{formatValue(r.costPerEnquiry)} per enquiry</span>}
                  {canEdit && <button type="button" onClick={() => remove(p.id)} aria-label={`Remove ${p.name}`} className="text-muted-foreground hover:text-red-600"><Trash2 className="h-4 w-4" /></button>}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <PromotionDialog open={open} onOpenChange={setOpen} onSaved={load} />
    </div>
  );
}

function PromotionDialog({ open, onOpenChange, onSaved }: { open: boolean; onOpenChange: (o: boolean) => void; onSaved: () => void }) {
  const [name, setName] = useState("");
  const [source, setSource] = useState("");
  const [startsOn, setStartsOn] = useState(istDayKey(new Date()));
  const [endsOn, setEndsOn] = useState("");
  const [spend, setSpend] = useState("");
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    const res = await fetch("/api/leads/promotions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, source: source || null, starts_on: startsOn, ends_on: endsOn || null, spend: spend ? Number(spend) : null }),
    });
    setSaving(false);
    if (!res.ok) { toast.error((await res.json().catch(() => ({}))).error || "Could not save"); return; }
    toast.success("Promotion recorded");
    setName(""); setSource(""); setEndsOn(""); setSpend("");
    onSaved();
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Add a promotion</DialogTitle>
          <DialogDescription>It shows as an amber band on the enquiries chart, with what came in while it ran.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          <label className="block">Name<Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Diwali offer" /></label>
          <label className="block">Source (optional)
            <select value={source} onChange={(e) => setSource(e.target.value)} className="h-9 w-full rounded-md border bg-background px-2">
              <option value="">All sources</option>
              {LEAD_SOURCES.map((s) => <option key={s} value={s}>{LEAD_SOURCE_LABELS[s] ?? s}</option>)}
            </select>
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block">Starts<Input type="date" value={startsOn} onChange={(e) => setStartsOn(e.target.value)} /></label>
            <label className="block">Ends (blank = running)<Input type="date" value={endsOn} onChange={(e) => setEndsOn(e.target.value)} /></label>
          </div>
          <label className="block">Spend in ₹ (optional)<Input type="number" min={0} inputMode="numeric" value={spend} onChange={(e) => setSpend(e.target.value)} /></label>
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={save} disabled={saving || name.trim().length < 2}>{saving ? "Saving…" : "Save"}</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
