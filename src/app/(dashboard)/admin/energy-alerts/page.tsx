"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Zap } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { PageBreadcrumb } from "@/components/page-breadcrumb";
import { REMINDER_LABELS, type ReminderSchedule } from "@/lib/energy-alerts/engine";
import { ACK_REASONS } from "@/lib/energy-alerts/schema";
import type { BacktestResult } from "@/lib/energy-alerts/backtest";

interface Rule {
  id: string; name: string; location_id: string; location: { name: string } | null;
  tolerance_pct: number; min_kw: number; direction: "both" | "high" | "low"; persist_slots: number; recover_slots: number;
  reminder_schedule: ReminderSchedule; daily_cap: number; recipients: string[]; send_resolved: boolean;
  mode: "test" | "live"; enabled: boolean; muted_until: string | null; emails_7d: number; has_open_episode: boolean;
}
interface Loc { id: string; name: string; onegrid_default_device_id: string | null }
interface Ev { id: string; kind: string; status: string; slot_ts: string; subject: string | null }
interface Episode {
  id: string; rule_id: string; direction: number; started_at: string; opened_at: string; closed_at: string | null; status: "open" | "closed";
  peak_dev_pct: number; extra_kwh: number; acked_at: string | null; ack_reason: string | null;
  rule: { name: string; mode: string } | null; location: { name: string } | null; events: Ev[];
}
type Mode = "off" | "dry_run" | "live";
type Form = Omit<Rule, "id" | "location" | "emails_7d" | "has_open_episode" | "muted_until" | "recipients"> & { id: string | null; recipients: string };

const MODE_LABEL: Record<Mode, string> = { off: "Off", dry_run: "Dry run — nothing is emailed", live: "Live — Live rules email" };
const NEW_RULE: Form = {
  id: null, name: "", location_id: "", tolerance_pct: 5, min_kw: 2, direction: "both", persist_slots: 2, recover_slots: 4,
  reminder_schedule: "std", daily_cap: 6, recipients: "", send_resolved: false, mode: "test", enabled: true,
};

const ist = (iso: string) =>
  new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Kolkata" });

const STATUS_BADGE: Record<string, string> = {
  sent: "bg-emerald-50 text-emerald-800 border-emerald-300", test: "bg-amber-50 text-amber-800 border-amber-300",
  held: "bg-slate-50 text-slate-700 border-slate-300", muted: "bg-slate-50 text-slate-700 border-slate-300",
  failed: "bg-red-50 text-red-800 border-red-300", claimed: "bg-slate-50 text-slate-700 border-slate-300",
};
const STATUS_TEXT: Record<string, string> = { sent: "Emailed", test: "Test — not sent", held: "Held (daily cap)", muted: "Muted", failed: "Failed", claimed: "Sending" };

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) } });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || "Request failed");
  return json as T;
}

export default function EnergyAlertsPage() {
  const [rules, setRules] = useState<Rule[]>([]);
  const [locations, setLocations] = useState<Loc[]>([]);
  const [mode, setMode] = useState<Mode>("dry_run");
  const [canManage, setCanManage] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [episodes, setEpisodes] = useState<Episode[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState<Form | null>(null);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [reasons, setReasons] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    try {
      const [r, e] = await Promise.all([
        api<{ rules: Rule[]; locations: Loc[]; mode: Mode; canManage: boolean; isAdmin: boolean }>("/api/energy-alerts/rules"),
        api<{ data: Episode[] }>("/api/energy-alerts/episodes"),
      ]);
      setRules(r.rules); setLocations(r.locations); setMode(r.mode); setCanManage(r.canManage); setIsAdmin(r.isAdmin); setEpisodes(e.data);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load energy alerts");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const openEpisodes = episodes.filter((e) => e.status === "open" && !e.acked_at).length;

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => (f ? { ...f, [k]: v } : f));
  const startEdit = (r: Rule) => setForm({ ...r, recipients: r.recipients.join(", ") });

  async function save() {
    if (!form) return;
    setSaving(true);
    try {
      const { id, ...rest } = form;
      const body = JSON.stringify(rest);
      if (id) await api(`/api/energy-alerts/rules/${id}`, { method: "PATCH", body });
      else await api("/api/energy-alerts/rules", { method: "POST", body });
      toast.success(form.mode === "test" ? "Saved in test mode — it records alerts but emails nobody." : "Saved.");
      setForm(null);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save");
    } finally {
      setSaving(false);
    }
  }

  async function act(key: string, fn: () => Promise<unknown>, ok: string) {
    setBusy(key);
    try { await fn(); toast.success(ok); await load(); }
    catch (err) { toast.error(err instanceof Error ? err.message : "Failed"); }
    finally { setBusy(null); }
  }

  const checkNow = (r: Rule) => act(`run-${r.id}`, async () => {
    const res = await api<{ data: { mode: Mode; rules: { slotsProcessed: number; note?: string; error?: string; outcomes: { status: string }[] }[] } }>(
      "/api/energy-alerts/run", { method: "POST", body: JSON.stringify({ rule_id: r.id }) });
    const s = res.data.rules[0];
    if (s?.error) throw new Error(s.error);
    toast.message(s ? `${s.slotsProcessed} new slot(s) judged, ${s.outcomes.length} alert decision(s).${s.note ? " " + s.note : ""}` : "Nothing to check (mode is off).");
  }, "Check complete");

  if (loading) return <div className="p-8 flex justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>;

  return (
    <div className="space-y-6 p-4 md:p-6">
      <PageBreadcrumb resetTo={{ label: "Energy alerts" }} />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold flex items-center gap-2"><Zap className="h-5 w-5" /> Energy alerts</h1>
          <p className="text-sm text-muted-foreground max-w-2xl">
            Compares each 15-minute slot with what is usual for that slot and emails when it strays past your tolerance.
            A deviation that carries on is one alert, not one per slot.
          </p>
        </div>
        {canManage && <Button onClick={() => setForm({ ...NEW_RULE, location_id: locations[0]?.id ?? "" })}>+ New rule</Button>}
      </div>

      <Card className={mode === "live" ? "border-emerald-300" : "border-amber-300"}>
        <CardContent className="py-3 flex flex-wrap items-center justify-between gap-3 text-sm">
          <span>
            <b>Global mode: {MODE_LABEL[mode]}.</b>{" "}
            {mode === "live" ? "A rule set to Live will email its recipients." : "Even a rule set to Live will not email anyone until this is Live."}
          </span>
          {isAdmin && (
            <Select value={mode} onValueChange={(v) => act("mode", () => api("/api/energy-alerts/mode", { method: "PUT", body: JSON.stringify({ mode: v }) }), `Mode: ${MODE_LABEL[v as Mode]}`)}>
              <SelectTrigger className="w-64"><SelectValue /></SelectTrigger>
              <SelectContent>{(Object.keys(MODE_LABEL) as Mode[]).map((m) => <SelectItem key={m} value={m}>{MODE_LABEL[m]}</SelectItem>)}</SelectContent>
            </Select>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">Rules</CardTitle></CardHeader>
        <CardContent>
          {rules.length === 0 ? (
            <p className="text-sm text-muted-foreground">No rules yet.{canManage ? " Create one — it starts in test mode." : ""}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className="text-left text-xs text-muted-foreground border-b">
                  <th className="py-2 pr-3">Rule</th><th className="pr-3">Location</th><th className="pr-3">Tolerance</th><th className="pr-3">Mode</th>
                  <th className="pr-3">Emails 7d</th><th className="pr-3">On</th><th />
                </tr></thead>
                <tbody>
                  {rules.map((r) => (
                    <tr key={r.id} className="border-b last:border-0">
                      <td className="py-2 pr-3">
                        <div className="font-medium">{r.name}</div>
                        <div className="text-xs text-muted-foreground">
                          ±{r.tolerance_pct}% and ≥{r.min_kw} kW for {r.persist_slots * 15} min
                          {r.has_open_episode && <Badge variant="outline" className="ml-2 bg-red-50 text-red-800 border-red-300">Open</Badge>}
                          {r.muted_until && new Date(r.muted_until) > new Date() && <Badge variant="outline" className="ml-2">Muted until {ist(r.muted_until)}</Badge>}
                        </div>
                      </td>
                      <td className="pr-3">{r.location?.name ?? "—"}</td>
                      <td className="pr-3">±{r.tolerance_pct}%</td>
                      <td className="pr-3"><Badge variant="outline" className={r.mode === "live" ? STATUS_BADGE.sent : STATUS_BADGE.test}>{r.mode === "live" ? "Live" : "Test"}</Badge></td>
                      <td className="pr-3 tabular-nums">{r.emails_7d}</td>
                      <td className="pr-3">
                        <Switch checked={r.enabled} disabled={!canManage} aria-label={`Enable ${r.name}`}
                          onCheckedChange={(v) => act(`en-${r.id}`, () => api(`/api/energy-alerts/rules/${r.id}`, { method: "PATCH", body: JSON.stringify({ enabled: v }) }), v ? "Rule on" : "Rule off")} />
                      </td>
                      <td className="text-right whitespace-nowrap">
                        {canManage && <>
                          <Button size="sm" variant="outline" disabled={busy === `run-${r.id}`} onClick={() => checkNow(r)}>
                            {busy === `run-${r.id}` ? <Loader2 className="h-3 w-3 animate-spin" /> : "Check now"}</Button>{" "}
                          <Button size="sm" variant="outline" onClick={() => startEdit(r)}>Edit</Button>{" "}
                          <Button size="sm" variant="outline" onClick={() => {
                            if (window.confirm(`Delete “${r.name}” and its alert history?`)) act(`del-${r.id}`, () => api(`/api/energy-alerts/rules/${r.id}`, { method: "DELETE" }), "Rule deleted");
                          }}>Delete</Button>
                        </>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {form && <RuleEditor form={form} set={set} locations={locations} saving={saving} onSave={save} onCancel={() => setForm(null)} />}

      <Card>
        <CardHeader><CardTitle className="text-base">Inbox {openEpisodes > 0 && <Badge className="ml-2">{openEpisodes} need attention</Badge>}</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          {episodes.length === 0 && <p className="text-sm text-muted-foreground">No alert episodes yet. They appear here when a rule finds a deviation that lasts.</p>}
          {episodes.map((ep) => {
            const reason = reasons[ep.id] ?? ACK_REASONS[0];
            const sign = ep.direction > 0 ? "+" : "−";
            return (
              <div key={ep.id} className="rounded-md border p-3 text-sm space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <b>{ep.location?.name ?? "Location"} {sign}{Number(ep.peak_dev_pct).toFixed(0)}% peak</b>
                    <span className="text-muted-foreground"> · {ep.rule?.name}</span>
                  </div>
                  {ep.status === "closed"
                    ? <Badge variant="outline" className={STATUS_BADGE.sent}>Back to normal</Badge>
                    : ep.acked_at ? <Badge variant="outline">Acknowledged</Badge>
                    : <Badge variant="outline" className="bg-red-50 text-red-800 border-red-300">Open</Badge>}
                </div>
                <div className="text-xs text-muted-foreground">
                  {ist(ep.started_at)} → {ep.closed_at ? ist(ep.closed_at) : "now"} · about {Number(ep.extra_kwh).toFixed(0)} kWh extra
                  {ep.ack_reason && <> · Reason: {ep.ack_reason}</>}
                </div>
                {ep.events.length > 0 && (
                  <ul className="text-xs space-y-1">
                    {ep.events.slice().sort((a, b) => a.slot_ts.localeCompare(b.slot_ts)).map((ev) => (
                      <li key={ev.id} className="flex flex-wrap items-center gap-2">
                        <span className="text-muted-foreground w-24">{ist(ev.slot_ts)}</span>
                        <Badge variant="outline" className={STATUS_BADGE[ev.status]}>{STATUS_TEXT[ev.status] ?? ev.status}</Badge>
                        <span>{ev.subject}</span>
                      </li>
                    ))}
                  </ul>
                )}
                {canManage && ep.status === "open" && !ep.acked_at && (
                  <div className="flex flex-wrap items-center gap-2 pt-1">
                    <Select value={reason} onValueChange={(v) => setReasons((m) => ({ ...m, [ep.id]: v }))}>
                      <SelectTrigger className="w-52 h-8"><SelectValue /></SelectTrigger>
                      <SelectContent>{ACK_REASONS.map((r) => <SelectItem key={r} value={r}>{r}</SelectItem>)}</SelectContent>
                    </Select>
                    <Button size="sm" disabled={busy === `ack-${ep.id}`} onClick={() => act(`ack-${ep.id}`, () => api(`/api/energy-alerts/episodes/${ep.id}/acknowledge`, { method: "POST", body: JSON.stringify({ reason }) }), "Acknowledged")}>Acknowledge</Button>
                    <Button size="sm" variant="outline" onClick={() => act(`mute-${ep.id}`, () => api(`/api/energy-alerts/rules/${ep.rule_id}/mute`, { method: "POST", body: JSON.stringify({ hours: 4 }) }), "Rule muted for 4 hours")}>Mute rule 4h</Button>
                  </div>
                )}
              </div>
            );
          })}
        </CardContent>
      </Card>
    </div>
  );
}

function RuleEditor({ form, set, locations, saving, onSave, onCancel }: {
  form: Form; set: <K extends keyof Form>(k: K, v: Form[K]) => void; locations: Loc[]; saving: boolean; onSave: () => void; onCancel: () => void;
}) {
  const [bt, setBt] = useState<BacktestResult | null>(null);
  const [btErr, setBtErr] = useState<string | null>(null);
  const [btBusy, setBtBusy] = useState(false);
  const seq = useRef(0);

  const key = useMemo(
    () => [form.location_id, form.tolerance_pct, form.min_kw, form.direction, form.persist_slots, form.recover_slots, form.reminder_schedule, form.daily_cap].join("|"),
    [form.location_id, form.tolerance_pct, form.min_kw, form.direction, form.persist_slots, form.recover_slots, form.reminder_schedule, form.daily_cap]);

  useEffect(() => {
    if (!form.location_id) return;
    const mine = ++seq.current;
    setBtBusy(true);
    const t = setTimeout(async () => {
      try {
        const res = await api<{ data: BacktestResult }>("/api/energy-alerts/backtest", {
          method: "POST",
          body: JSON.stringify({ location_id: form.location_id, tolerance_pct: form.tolerance_pct, min_kw: form.min_kw, direction: form.direction,
            persist_slots: form.persist_slots, recover_slots: form.recover_slots, reminder_schedule: form.reminder_schedule, daily_cap: form.daily_cap }),
        });
        if (mine === seq.current) { setBt(res.data); setBtErr(null); }
      } catch (err) {
        if (mine === seq.current) { setBt(null); setBtErr(err instanceof Error ? err.message : "Could not check against history"); }
      } finally {
        if (mine === seq.current) setBtBusy(false);
      }
    }, 400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` captures exactly the inputs the check depends on
  }, [key]);

  const dirText = form.direction === "both" ? "away from" : form.direction === "high" ? "above" : "below";
  const perDay = bt && bt.days > 0 ? bt.emails / bt.days : null;
  const loc = locations.find((l) => l.id === form.location_id);

  return (
    <Card>
      <CardHeader><CardTitle className="text-base">{form.id ? "Edit rule" : "New rule"}</CardTitle></CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-4 md:grid-cols-2">
          <div><Label>Rule name</Label><Input value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="e.g. Perungudi slot deviation" /></div>
          <div><Label>Location</Label>
            <Select value={form.location_id} onValueChange={(v) => set("location_id", v)}>
              <SelectTrigger><SelectValue placeholder="Choose a location" /></SelectTrigger>
              <SelectContent>{locations.map((l) => <SelectItem key={l.id} value={l.id}>{l.name}{l.onegrid_default_device_id ? "" : " (no meter chosen)"}</SelectItem>)}</SelectContent>
            </Select>
            {locations.length === 0 && <p className="text-xs text-muted-foreground mt-1">No location has OneGrid enabled yet.</p>}
            {loc && !loc.onegrid_default_device_id && <p className="text-xs text-red-700 mt-1">Choose this location&apos;s default meter on the Locations page first; without it nothing can be judged.</p>}
          </div>
          <div><Label>Tolerance: ±{form.tolerance_pct}%</Label>
            <input type="range" className="w-full accent-[#015E65]" min={2} max={30} value={form.tolerance_pct} onChange={(e) => set("tolerance_pct", +e.target.value)} />
            <p className="text-xs text-muted-foreground">How far from usual is still fine.</p></div>
          <div><Label>Ignore swings smaller than: {form.min_kw} kW</Label>
            <input type="range" className="w-full accent-[#015E65]" min={0} max={8} step={0.5} value={form.min_kw} onChange={(e) => set("min_kw", +e.target.value)} />
            <p className="text-xs text-muted-foreground">Stops a few percent of a small night load from firing.</p></div>
          <div><Label>Alert when usage is</Label>
            <Select value={form.direction} onValueChange={(v) => set("direction", v as Form["direction"])}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="both">Too high or too low</SelectItem><SelectItem value="high">Too high only</SelectItem><SelectItem value="low">Too low only</SelectItem></SelectContent>
            </Select></div>
          <div><Label>Must last for</Label>
            <Select value={String(form.persist_slots)} onValueChange={(v) => set("persist_slots", +v)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>{[1, 2, 3, 4].map((n) => <SelectItem key={n} value={String(n)}>{n} slot{n > 1 ? "s" : ""} in a row ({n * 15} min)</SelectItem>)}</SelectContent>
            </Select></div>
          <div><Label>Counts as fixed after</Label>
            <Select value={String(form.recover_slots)} onValueChange={(v) => set("recover_slots", +v)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>{[2, 4, 8].map((n) => <SelectItem key={n} value={String(n)}>{n * 15} min back to normal</SelectItem>)}</SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">&ldquo;Normal&rdquo; = well inside tolerance (under 60% of it). Dips in between don&apos;t close the alert.</p></div>
          <div><Label>Reminders while still not fixed</Label>
            <Select value={form.reminder_schedule} onValueChange={(v) => set("reminder_schedule", v as ReminderSchedule)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>{(Object.keys(REMINDER_LABELS) as ReminderSchedule[]).map((k) => <SelectItem key={k} value={k}>{REMINDER_LABELS[k]}</SelectItem>)}</SelectContent>
            </Select></div>
          <div><Label>Max emails per day from this rule</Label>
            <Select value={String(form.daily_cap)} onValueChange={(v) => set("daily_cap", +v)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>{[3, 6, 12].map((n) => <SelectItem key={n} value={String(n)}>{n}</SelectItem>)}</SelectContent>
            </Select></div>
          <div className="md:col-span-2"><Label>Send emails to</Label>
            <Input value={form.recipients} onChange={(e) => set("recipients", e.target.value)} placeholder="facility@…, vinit@…" />
            <p className="text-xs text-muted-foreground">Staff addresses, comma separated (max 10).</p></div>
          <div className="flex items-center gap-2"><Switch checked={form.send_resolved} onCheckedChange={(v) => set("send_resolved", v)} aria-label="Send resolved email" /><Label className="m-0">Also send a short &ldquo;resolved&rdquo; email</Label></div>
          <div className="flex items-center gap-2"><Switch checked={form.mode === "live"} onCheckedChange={(v) => set("mode", v ? "live" : "test")} aria-label="Live mode" />
            <Label className="m-0">{form.mode === "live" ? "Live — emails the recipients (when global mode is Live)" : "Test — records alerts, emails nobody"}</Label></div>
        </div>

        <div className="rounded-md bg-muted/50 p-3 text-sm">
          <b>In plain words:</b> email <b>{form.recipients || "nobody yet"}</b> when <b>{loc?.name ?? "the location"}</b> runs more than <b>{form.tolerance_pct}%</b> (and at
          least <b>{form.min_kw} kW</b>) {dirText} its usual for that slot, for <b>{form.persist_slots * 15} minutes</b> in a row. Then stay quiet: reminders {REMINDER_LABELS[form.reminder_schedule]},
          fixed after <b>{form.recover_slots * 15} minutes</b> back to normal, at most <b>{form.daily_cap}</b> emails a day. {form.mode === "test" ? <b>Test mode: nothing is sent.</b> : <b>Live.</b>}
        </div>

        <div className="rounded-md border p-3">
          <div className="text-sm font-medium mb-2 flex items-center gap-2">What this would have done over the last 14 days {btBusy && <Loader2 className="h-3 w-3 animate-spin" />}</div>
          {btErr && <p className="text-sm text-red-700">{btErr}</p>}
          {!btErr && bt && bt.days === 0 && <p className="text-sm text-muted-foreground">Not enough ledger history for this location yet to check against.</p>}
          {!btErr && bt && bt.days > 0 && (
            <>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                {[
                  [bt.outSlots, "emails if every out-of-band slot sent one"],
                  [bt.episodes, "distinct problems (episodes)"],
                  [bt.emails, "emails with these protections"],
                  [perDay != null ? perDay.toFixed(1) : "–", `emails per day (over ${bt.days} days)`],
                ].map(([n, label]) => (
                  <div key={String(label)} className="rounded border p-2"><div className="text-2xl font-semibold tabular-nums">{n}</div><div className="text-xs text-muted-foreground">{label}</div></div>
                ))}
              </div>
              <p className="text-xs text-muted-foreground mt-2">
                {perDay != null && perDay > 2 ? "That is a lot of email. Try a wider tolerance, a higher kW floor, or a longer “must last for”."
                  : perDay != null && perDay < 0.2 ? "Very quiet. To hear about smaller drifts, tighten the tolerance."
                  : "A sensible volume."}
              </p>
            </>
          )}
        </div>

        <div className="flex gap-2">
          <Button onClick={onSave} disabled={saving || !form.name.trim() || !form.location_id}>{saving ? <Loader2 className="h-4 w-4 animate-spin" /> : "Save rule"}</Button>
          <Button variant="outline" onClick={onCancel}>Cancel</Button>
        </div>
      </CardContent>
    </Card>
  );
}
