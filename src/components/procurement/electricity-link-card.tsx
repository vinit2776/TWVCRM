"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, Plus, Trash2, Zap } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { formatCurrency } from "@/lib/utils";
import {
  CHARGE_CATEGORIES, CHARGE_LABELS, billMonthOf, checkLinkInput, gridUnits, isUnitCategory, lineAmount, sumLines,
  type ChargeCategory, type LinkLine,
} from "@/lib/electricity-link";

interface LocationOption { id: string; name: string }
interface ConnectionOption { id: string; location_id: string; consumer_number: string | null; onegrid_device_id: string | null }
interface LinkedRecord {
  id: string;
  status: string;
  bill_month: number;
  bill_year: number;
  period_start: string | null;
  period_end: string | null;
  opening_reading: number | null;
  closing_reading: number | null;
  max_demand_kva: number | null;
  billed_pf: number | null;
  locations: { id: string; name: string } | null;
  electricity_bill_lines: Array<{ charge_category: ChargeCategory | null; meter_label: string | null; label: string | null; units: number | null; rate: number | null; amount: number }>;
}
interface Context {
  eligible: boolean;
  reason: string | null;
  link: LinkedRecord | null;
  vendor_name?: string;
  bill?: { id: string; total_amount: number; invoice_number: string | null; invoice_date: string | null };
  locations?: LocationOption[];
  connections?: ConnectionOption[];
}
interface Checks {
  locations: Array<{ location_id: string; location_name: string; observed_kwh: number | null; pct: number | null; status: string }>;
  continuity: { previous_closing: number | null; previous_period_end: string | null; diff: number | null; status: string } | null;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const nOrNull = (s: string) => (s.trim() === "" || !Number.isFinite(Number(s)) ? null : Number(s));
const fmt = (n: number) => n.toLocaleString("en-IN", { maximumFractionDigits: 2 });

interface DraftLine { charge_category: ChargeCategory; meter_label: string; units: string; rate: string; amount: string }
const blankLine = (c: ChargeCategory = "energy"): DraftLine => ({ charge_category: c, meter_label: "", units: "", rate: "", amount: "" });
const toLine = (d: DraftLine): LinkLine => ({ charge_category: d.charge_category, meter_label: d.meter_label || null, units: nOrNull(d.units), rate: nOrNull(d.rate), amount: nOrNull(d.amount) });

/** Shown on an electricity vendor's bill. Renders nothing for any other bill. */
export function ElectricityLinkCard({ vendorBillId, isAdmin, canLink, onChanged }: { vendorBillId: string; isAdmin: boolean; canLink: boolean; onChanged: () => void }) {
  const [ctx, setCtx] = useState<Context | null>(null);
  const [open, setOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/procurement/bills/${vendorBillId}/electricity`);
      if (!res.ok) return setCtx(null);
      setCtx((await res.json()).data as Context);
    } catch {
      setCtx(null);
    }
  }, [vendorBillId]);
  useEffect(() => { load(); }, [load]);

  if (!ctx) return null;
  if (!ctx.eligible && !ctx.link && !ctx.reason) return null;

  const unlink = async () => {
    if (!ctx.link || !window.confirm("Unlink these electricity details? The vendor bill and its payable are not touched.")) return;
    const res = await fetch(`/api/electricity-bills/${ctx.link.id}`, { method: "DELETE" });
    if (!res.ok) return toast.error((await res.json().catch(() => ({}))).error ?? "Could not unlink");
    toast.success("Unlinked");
    await load();
    onChanged();
  };

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base"><Zap className="h-4 w-4" /> Electricity details</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {ctx.link ? (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="secondary">{ctx.link.locations?.name ?? "Location"}</Badge>
              <span>{MONTHS[ctx.link.bill_month - 1]} {ctx.link.bill_year}</span>
              {ctx.link.period_start && ctx.link.period_end && <span className="text-muted-foreground">({ctx.link.period_start} → {ctx.link.period_end})</span>}
              {isAdmin && <Button size="sm" variant="ghost" className="ml-auto text-red-600" onClick={unlink}><Trash2 className="mr-1 h-3.5 w-3.5" /> Unlink</Button>}
            </div>
            <table className="w-full text-xs">
              <tbody>
                {ctx.link.electricity_bill_lines.map((l, i) => (
                  <tr key={i} className="border-t">
                    <td className="py-1">{l.charge_category ? CHARGE_LABELS[l.charge_category] : l.label}</td>
                    <td className="py-1 text-right text-muted-foreground">{l.units != null ? `${fmt(Number(l.units))} × ${fmt(Number(l.rate))}` : ""}</td>
                    <td className="py-1 text-right">{formatCurrency(Number(l.amount))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {(ctx.link.opening_reading != null || ctx.link.max_demand_kva != null || ctx.link.billed_pf != null) && (
              <p className="text-xs text-muted-foreground">
                {ctx.link.opening_reading != null && <>Reading {fmt(Number(ctx.link.opening_reading))} → {fmt(Number(ctx.link.closing_reading))}. </>}
                {ctx.link.max_demand_kva != null && <>Max demand {fmt(Number(ctx.link.max_demand_kva))} kVA. </>}
                {ctx.link.billed_pf != null && <>PF {ctx.link.billed_pf}.</>}
              </p>
            )}
          </>
        ) : ctx.eligible ? (
          <div className="flex flex-wrap items-center gap-3">
            <p className="text-muted-foreground">This is an electricity bill with no location or charge details yet. Adding them lets it be compared with the meter.</p>
            {canLink && <Button size="sm" onClick={() => setOpen(true)}><Plus className="mr-1 h-3.5 w-3.5" /> Add electricity details</Button>}
          </div>
        ) : (
          <p className="text-muted-foreground">{ctx.reason}</p>
        )}
      </CardContent>
      {ctx.eligible && open && <LinkDialog vendorBillId={vendorBillId} ctx={ctx} onClose={() => setOpen(false)} onDone={async () => { setOpen(false); await load(); onChanged(); }} />}
    </Card>
  );
}

function LinkDialog({ vendorBillId, ctx, onClose, onDone }: { vendorBillId: string; ctx: Context; onClose: () => void; onDone: () => void }) {
  const locations = ctx.locations ?? [];
  const total = ctx.bill?.total_amount ?? 0;

  const [locationId, setLocationId] = useState("");
  const [connectionId, setConnectionId] = useState("");
  const [consumer, setConsumer] = useState("");
  const [printedName, setPrintedName] = useState("");
  const [remember, setRemember] = useState(false);
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [opening, setOpening] = useState("");
  const [closing, setClosing] = useState("");
  const [demand, setDemand] = useState("");
  const [pf, setPf] = useState("");
  const [lines, setLines] = useState<DraftLine[]>([blankLine("energy")]);
  const [checks, setChecks] = useState<Checks | null>(null);
  const [saving, setSaving] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  const locConnections = useMemo(() => (ctx.connections ?? []).filter((c) => c.location_id === locationId), [ctx.connections, locationId]);
  // With exactly one connection at the chosen site there is nothing to choose.
  useEffect(() => { setConnectionId(locConnections.length === 1 ? locConnections[0].id : ""); }, [locConnections]);

  const linkLines = useMemo(() => lines.map(toLine), [lines]);
  const input = useMemo(() => ({
    period_start: start, period_end: end,
    opening_reading: nOrNull(opening), closing_reading: nOrNull(closing),
    max_demand_kva: nOrNull(demand), billed_pf: nOrNull(pf), lines: linkLines,
  }), [start, end, opening, closing, demand, pf, linkLines]);
  const check = useMemo(() => checkLinkInput(input, total), [input, total]);
  const linesTotal = sumLines(linkLines);
  const grid = gridUnits(linkLines);
  const month = start && end && end >= start ? billMonthOf(start, end) : null;

  // Objective checks against the meter, once the dates and grid units are known.
  const periodOk = /^\d{4}-\d{2}-\d{2}$/.test(start) && /^\d{4}-\d{2}-\d{2}$/.test(end) && end >= start;
  useEffect(() => {
    if (!periodOk || !(grid > 0)) { setChecks(null); return; }
    const t = setTimeout(async () => {
      const p = new URLSearchParams({ vendor_bill_id: vendorBillId, period_start: start, period_end: end, billed_kwh: String(grid) });
      if (connectionId) p.set("connection_id", connectionId);
      if (locationId) p.set("location_id", locationId);
      if (nOrNull(opening) != null) p.set("opening_reading", String(nOrNull(opening)));
      try {
        const res = await fetch(`/api/electricity-bills/link-checks?${p}`);
        setChecks(res.ok ? ((await res.json()).data as Checks) : null);
      } catch { setChecks(null); }
    }, 400);
    return () => clearTimeout(t);
  }, [periodOk, grid, start, end, connectionId, locationId, opening, vendorBillId]);

  const chosenFit = checks?.locations.find((l) => l.location_id === locationId);
  const betterFit = checks?.locations
    .filter((l) => l.location_id !== locationId && l.status === "fits")
    .sort((a, b) => Math.abs(a.pct ?? 99) - Math.abs(b.pct ?? 99))[0];
  const canSave = !!locationId && check.errors.length === 0 && !saving;

  const setLine = (i: number, patch: Partial<DraftLine>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  const save = async () => {
    setSaving(true);
    setServerError(null);
    try {
      const res = await fetch("/api/electricity-bills/link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          vendor_bill_id: vendorBillId, location_id: locationId, connection_id: connectionId || null,
          period_start: start, period_end: end,
          opening_reading: nOrNull(opening), closing_reading: nOrNull(closing),
          max_demand_kva: nOrNull(demand), billed_pf: nOrNull(pf),
          consumer_number: consumer || null, printed_name: printedName || null,
          remember_name: remember && !!connectionId && !!printedName,
          lines: linkLines,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) { setServerError(json.error ?? "Could not save"); return; }
      for (const w of (json.warnings ?? []) as string[]) toast.warning(w);
      toast.success("Electricity details added");
      onDone();
    } finally { setSaving(false); }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
        <DialogHeader><DialogTitle>Add electricity details</DialogTitle></DialogHeader>
        <p className="text-xs text-muted-foreground">
          {ctx.vendor_name} · {ctx.bill?.invoice_number ?? "bill"} · {formatCurrency(total)}. You choose the location — the bill&apos;s own wording is not used to decide it.
        </p>

        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label>Location *</Label>
            <Select value={locationId} onValueChange={setLocationId}>
              <SelectTrigger><SelectValue placeholder="Choose the location this bill is for" /></SelectTrigger>
              <SelectContent>{locations.map((l) => <SelectItem key={l.id} value={l.id}>{l.name}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div>
            <Label>Connection</Label>
            <Select value={connectionId} onValueChange={setConnectionId} disabled={locConnections.length === 0}>
              <SelectTrigger><SelectValue placeholder={locConnections.length === 0 ? "None set up at this location" : "Choose a connection"} /></SelectTrigger>
              <SelectContent>{locConnections.map((c) => <SelectItem key={c.id} value={c.id}>{c.consumer_number ?? "No consumer number"}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div><Label>Consumer number on the bill</Label><Input value={consumer} onChange={(e) => setConsumer(e.target.value)} /></div>
          <div>
            <Label>Name printed on the bill</Label>
            <Input value={printedName} onChange={(e) => setPrintedName(e.target.value)} />
            {connectionId && printedName && (
              <label className="mt-1 flex items-center gap-1.5 text-xs"><input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} /> Remember this wording for this connection</label>
            )}
          </div>
          <div><Label>Billing period from *</Label><Input type="date" value={start} onChange={(e) => setStart(e.target.value)} /></div>
          <div><Label>Billing period to *</Label><Input type="date" value={end} onChange={(e) => setEnd(e.target.value)} /></div>
        </div>
        {month && <p className="text-xs text-muted-foreground">Counts as <strong>{MONTHS[month.month - 1]} {month.year}</strong> (the month holding most of the period).</p>}

        <div className="space-y-2">
          <Label>Charges</Label>
          {lines.map((l, i) => (
            <div key={i} className="grid grid-cols-12 items-center gap-2">
              <div className="col-span-4">
                <Select value={l.charge_category} onValueChange={(v) => setLine(i, { charge_category: v as ChargeCategory })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>{CHARGE_CATEGORIES.map((c) => <SelectItem key={c} value={c}>{CHARGE_LABELS[c]}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              {isUnitCategory(l.charge_category) ? (
                <>
                  <Input className="col-span-2" placeholder="Units" inputMode="decimal" value={l.units} onChange={(e) => setLine(i, { units: e.target.value })} />
                  <Input className="col-span-2" placeholder="Rate" inputMode="decimal" value={l.rate} onChange={(e) => setLine(i, { rate: e.target.value })} />
                </>
              ) : (
                <Input className="col-span-4" placeholder="Amount (negative for a rebate)" inputMode="decimal" value={l.amount} onChange={(e) => setLine(i, { amount: e.target.value })} />
              )}
              <span className="col-span-3 text-right text-sm">{lineAmount(toLine(l)) != null ? formatCurrency(lineAmount(toLine(l)) as number) : "—"}</span>
              <Button type="button" size="icon" variant="ghost" className="col-span-1" disabled={lines.length === 1} onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}><Trash2 className="h-3.5 w-3.5" /></Button>
            </div>
          ))}
          <Button type="button" size="sm" variant="outline" onClick={() => setLines((ls) => [...ls, blankLine("other")])}><Plus className="mr-1 h-3.5 w-3.5" /> Add line</Button>
          <p className={`text-sm ${Math.abs(linesTotal - total) <= 1 ? "text-green-700" : "text-amber-700"}`}>
            Lines {formatCurrency(linesTotal)} · vendor bill {formatCurrency(total)} {Math.abs(linesTotal - total) <= 1 ? <CheckCircle2 className="inline h-3.5 w-3.5" /> : `(${formatCurrency(Math.abs(linesTotal - total))} ${linesTotal > total ? "over" : "short"})`}
          </p>
        </div>

        <div className="grid gap-3 sm:grid-cols-4">
          <div><Label>Opening reading</Label><Input inputMode="decimal" value={opening} onChange={(e) => setOpening(e.target.value)} /></div>
          <div><Label>Closing reading</Label><Input inputMode="decimal" value={closing} onChange={(e) => setClosing(e.target.value)} /></div>
          <div><Label>Max demand (kVA)</Label><Input inputMode="decimal" value={demand} onChange={(e) => setDemand(e.target.value)} /></div>
          <div><Label>Billed PF</Label><Input inputMode="decimal" value={pf} onChange={(e) => setPf(e.target.value)} /></div>
        </div>

        {(chosenFit || checks?.continuity) && (
          <div className="space-y-1 rounded-md border bg-muted/30 p-3 text-sm">
            {chosenFit && chosenFit.observed_kwh != null && (
              <p className={chosenFit.status === "fits" ? "text-green-700" : "text-amber-700"}>
                Billed {fmt(grid)} kWh · the meter at {chosenFit.location_name} recorded {fmt(chosenFit.observed_kwh)} kWh over these dates ({chosenFit.pct! > 0 ? "+" : ""}{chosenFit.pct}%).
              </p>
            )}
            {chosenFit && chosenFit.status === "off" && betterFit && (
              <p className="flex items-start gap-1.5 text-amber-800"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> These units fit {betterFit.location_name} ({betterFit.pct! > 0 ? "+" : ""}{betterFit.pct}%) far better than {chosenFit.location_name}. Check you chose the right location. This is only a warning — your choice stands.</p>
            )}
            {checks?.continuity && checks.continuity.status === "continues" && <p className="text-green-700">Opening reading follows on from the previous bill (closing {fmt(checks.continuity.previous_closing!)}).</p>}
            {checks?.continuity && (checks.continuity.status === "gap" || checks.continuity.status === "overlap") && (
              <p className="text-amber-800">Opening reading is {fmt(Math.abs(checks.continuity.diff!))} {checks.continuity.status === "gap" ? "above" : "below"} the previous bill&apos;s closing reading ({fmt(checks.continuity.previous_closing!)}) — {checks.continuity.status === "gap" ? "a bill in between may be missing, or this is the wrong connection." : "the periods overlap, or this is not the next bill."}</p>
            )}
          </div>
        )}

        {(check.errors.length > 0 && (start || lines.some((l) => l.units || l.amount))) && (
          <ul className="space-y-0.5 text-sm text-red-700">{check.errors.map((e) => <li key={e}>• {e}</li>)}</ul>
        )}
        {check.warnings.length > 0 && <ul className="space-y-0.5 text-sm text-amber-700">{check.warnings.map((w) => <li key={w}>• {w}</li>)}</ul>}
        {serverError && <p className="text-sm text-red-700">{serverError}</p>}

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={!canSave} onClick={save}>{saving ? "Saving…" : "Save electricity details"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
