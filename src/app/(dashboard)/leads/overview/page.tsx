"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Settings2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { RateCardDialog } from "@/components/leads/rate-card-dialog";
import { LEAD_SOURCE_LABELS } from "@/lib/constants";
import { VALUE_TIER_LABELS, formatValue, HIGH_VALUE_MONTHLY, WORTH_A_CALL_MONTHLY, HIGH_VALUE_SEATS } from "@/lib/lead-value";
import { formatWait, type Overview, type Bar, type FocusItem } from "@/lib/lead-overview";

const TIER_STYLE = { high: "bg-emerald-100 text-emerald-800", worth_a_call: "bg-amber-100 text-amber-800", passing: "bg-muted text-muted-foreground" } as const;

function Stat({ label, value, sub, tone }: { label: string; value: React.ReactNode; sub?: string; tone?: string }) {
  return (
    <div className="rounded-lg border bg-card p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={`text-2xl font-bold ${tone ?? ""}`}>{value}</div>
      {sub && <div className="text-xs text-muted-foreground">{sub}</div>}
    </div>
  );
}

function Bars({ title, hint, rows, color = "bg-primary" }: { title: string; hint?: string; rows: { key: string; label: string; weight: number; note: string }[]; color?: string }) {
  const max = Math.max(1, ...rows.map((r) => r.weight));
  return (
    <div className="rounded-lg border bg-card p-4">
      <div className="font-semibold">{title} {hint && <span className="text-xs font-normal text-muted-foreground">{hint}</span>}</div>
      <div className="mt-3 space-y-2.5 text-sm">
        {rows.length === 0 && <div className="text-muted-foreground">Nothing in this period.</div>}
        {rows.map((r) => (
          <div key={r.key}>
            {r.label} <span className="text-xs text-muted-foreground">· {r.note}</span>
            <div className={`mt-1 h-2 rounded ${color}`} style={{ width: `${Math.max(3, (r.weight / max) * 100)}%` }} />
          </div>
        ))}
      </div>
    </div>
  );
}

const barRows = (bars: Bar[], note: (b: Bar) => string, weight: (b: Bar) => number) => bars.map((b) => ({ key: b.key, label: b.label, weight: weight(b), note: note(b) }));

function FocusRow({ f }: { f: FocusItem }) {
  return (
    <Link href={`/leads/${f.id}/activity`} className="block rounded-lg border bg-card px-4 py-3 hover:bg-muted/40">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <span className="font-medium">{f.name}</span> <span className="font-mono text-xs text-muted-foreground">#{f.leadNumber} · {LEAD_SOURCE_LABELS[f.source] ?? f.source}</span>
        </div>
        <span className={`shrink-0 rounded px-2 py-0.5 text-sm font-semibold ${TIER_STYLE[f.tier]}`}>
          {f.monthly !== null ? `${f.estimated ? "est. " : ""}${formatValue(f.monthly)} / mo` : VALUE_TIER_LABELS[f.tier]}
        </span>
      </div>
      <div className="text-sm text-muted-foreground">{f.want}{f.location ? ` · ${f.location}` : ""}{f.handler ? ` · ${f.handler}` : ""}</div>
      <div className="mt-0.5 text-sm">
        {f.unclaimedMinutes !== null ? <span className="text-amber-700">▸ Unclaimed for {formatWait(f.unclaimedMinutes)}</span> : f.overdueDays ? <span className="text-red-600">▸ Follow-up {f.overdueDays} day{f.overdueDays === 1 ? "" : "s"} overdue</span> : <span className="text-muted-foreground">▸ Not contacted yet</span>}
        <span className="text-xs text-muted-foreground"> · {f.reasons.join(" · ")}</span>
      </div>
    </Link>
  );
}

export default function LeadsOverviewPage() {
  const [location, setLocation] = useState("all");
  const [days, setDays] = useState(30);
  const [data, setData] = useState<{ data: Overview; locations: { id: string; name: string }[]; truncated: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [role, setRole] = useState<string | null>(null);
  const [rateOpen, setRateOpen] = useState(false);

  const load = useCallback(() => {
    setError(null);
    fetch(`/api/leads/overview?location=${location}&days=${days}`)
      .then(async (r) => { const j = await r.json(); if (!r.ok) throw new Error(j.error || "Failed to load"); return j; })
      .then(setData)
      .catch((e) => setError(e.message));
  }, [location, days]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { fetch("/api/me").then((r) => r.json()).then((j) => setRole(j.role ?? null)).catch(() => {}); }, []);

  const o = data?.data;
  const p = o?.profile;
  const canEditRates = role === "admin" || role === "manager";
  const locName = data?.locations.find((l) => l.id === location)?.name;

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <Link href="/leads" className="text-sm text-muted-foreground hover:underline">← Leads</Link>
          <h1 className="text-2xl font-bold">Leads overview</h1>
          <p className="text-sm text-muted-foreground">Value is an estimate: seats × price per seat per month. Estimates from our rate card are marked “est.”</p>
        </div>
        {canEditRates && <Button variant="outline" onClick={() => setRateOpen(true)}><Settings2 className="mr-2 h-4 w-4" />Rate card</Button>}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-muted-foreground">Location</span>
        {[{ id: "all", name: "All locations" }, ...(data?.locations ?? [])].map((l) => (
          <button key={l.id} type="button" onClick={() => setLocation(l.id)} className={`rounded-full border px-3 py-1 text-sm ${location === l.id ? "border-primary bg-primary text-primary-foreground" : "hover:bg-muted"}`}>{l.name}</button>
        ))}
        <select value={days} onChange={(e) => setDays(Number(e.target.value))} className="ml-auto h-9 rounded-md border bg-background px-2 text-sm">
          <option value={7}>Last 7 days</option><option value={30}>Last 30 days</option><option value={90}>Last 90 days</option>
        </select>
      </div>

      {error && <div className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-700">{error}</div>}
      {!o && !error && <div className="text-sm text-muted-foreground">Loading…</div>}
      {data?.truncated && <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm">Very many leads in this range, so the figures cover the most recent ones only.</div>}

      {o && (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat label="Act now" value={o.cards.actNow} sub="high-value, not yet contacted, unclaimed or overdue" tone="text-red-600" />
            <Stat label="Pipeline on the table" value={<>{formatValue(o.cards.pipeline)}<span className="text-sm font-normal text-muted-foreground"> /mo</span></>} sub="estimated, open leads" />
            <Stat label="Waiting to be claimed" value={o.cards.waiting} sub={o.cards.oldestWaitingMinutes !== null ? `oldest ${formatWait(o.cards.oldestWaitingMinutes)}` : "nobody waiting"} tone="text-amber-700" />
            <Stat label="Passing enquiries" value={o.cards.passing} sub="low value, handle in bulk" tone="text-muted-foreground" />
          </div>

          <div>
            <h2 className="mb-2 font-semibold">Focus: act now, biggest first</h2>
            <div className="space-y-2">
              {o.focus.length === 0 && <div className="rounded-lg border bg-card p-4 text-sm text-muted-foreground">Nothing high-value is waiting. Good.</div>}
              {o.focus.map((f) => <FocusRow key={f.id} f={f} />)}
            </div>
          </div>

          {!p && (
            <div className="grid gap-3 md:grid-cols-2">
              <Bars title="By location" hint="enquiries · est. value" rows={barRows(o.byLocation, (b) => `${b.count} · ${formatValue(b.value)}`, (b) => b.value || b.count)} />
              <Bars title="By source" hint="average value per enquiry" color="bg-emerald-500" rows={barRows(o.bySource, (b) => (b.avg !== null ? formatValue(b.avg) : "no value"), (b) => b.avg ?? 0)} />
            </div>
          )}

          {p && (
            <>
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-card p-4">
                <div>
                  <div className="text-lg font-bold">{locName} · profile</div>
                  <div className="text-xs text-muted-foreground">Last {days} days · leads that named this location</div>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                <Stat label="Enquiries" value={p.enquiries} sub={`${p.enquiries - p.previous >= 0 ? "+" : ""}${p.enquiries - p.previous} vs previous ${days} days`} />
                <Stat label="Avg budget / seat" value={p.avgBudget !== null ? `₹${p.avgBudget.toLocaleString("en-IN")}` : "—"} sub={p.ourRate ? `our rate ₹${p.ourRate.toLocaleString("en-IN")}` : "set the rate card to compare"} />
                <Stat label="Median first response" value={formatWait(p.medianResponseMinutes)} sub={`${p.waitingNow} waiting now`} />
                <Stat label="Became customers" value={<>{p.won} <span className="text-sm font-normal text-muted-foreground">of {p.enquiries}</span></>} sub={`${p.stillOpen} still open`} />
              </div>
              {p.insights.length > 0 && (
                <div className="rounded-lg border border-l-4 border-l-primary bg-card p-4">
                  <div className="font-semibold">What this location is telling you</div>
                  <ul className="mt-1 list-disc space-y-1 pl-5 text-sm">{p.insights.map((i) => <li key={i.text}>{i.text}</li>)}</ul>
                </div>
              )}
              <div className="grid gap-3 md:grid-cols-2">
                <Bars title="What kind of seats" hint="share of enquiries · share of value" rows={p.types.map((t) => ({ key: t.key, label: t.label, weight: t.countShare, note: `${t.countShare}% · ${t.valueShare}% of value` }))} />
                <Bars title="How many seats" hint="share of enquiries" rows={p.seatBands.map((b) => ({ key: b.key, label: b.label, weight: b.share, note: `${b.share}%` }))} />
                <Bars title={p.ourRate ? `Budget per seat vs our rate (₹${p.ourRate.toLocaleString("en-IN")})` : "Budget per seat"} hint={p.budgetBase ? `based on the ${p.budgetBase} of ${p.enquiries} who gave a budget` : undefined} color="bg-amber-500" rows={p.budgetBuckets.map((b) => ({ key: b.key, label: b.label, weight: b.share, note: `${b.share}%` }))} />
                <div className="rounded-lg border bg-card p-4">
                  <div className="font-semibold">Requests received <span className="text-xs font-normal text-muted-foreground">grouped from what they wrote</span></div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {p.requests.length === 0 && <span className="text-sm text-muted-foreground">None recorded.</span>}
                    {p.requests.map((r) => <span key={r.key} className="rounded-full border px-3 py-1 text-sm">{r.label} · {r.count}</span>)}
                  </div>
                </div>
              </div>
              <div className="overflow-x-auto rounded-lg border bg-card p-4">
                <div className="font-semibold">Where they came from</div>
                <table className="mt-2 w-full text-sm">
                  <thead><tr className="text-left text-xs text-muted-foreground"><th className="py-1.5">Source</th><th>Enquiries</th><th>Avg value</th><th>Became customers</th><th>Usually asks for</th></tr></thead>
                  <tbody>
                    {p.sources.map((s) => (
                      <tr key={s.key} className="border-t"><td className="py-2">{s.label}</td><td>{s.count}</td><td>{s.avg !== null ? formatValue(s.avg) : "—"}</td><td>{s.won}</td><td>{s.usuallyAsks}</td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          <div className="rounded-lg border bg-card p-4 text-sm">
            <div className="mb-2 font-semibold">How an enquiry is tiered</div>
            <div><span className={`rounded px-1.5 py-0.5 text-xs font-semibold ${TIER_STYLE.high}`}>High value</span> about ₹{HIGH_VALUE_MONTHLY.toLocaleString("en-IN")} a month or more, <i>or</i> {HIGH_VALUE_SEATS}+ seats, <i>or</i> an office with a company starting within 8 weeks</div>
            <div className="mt-1.5"><span className={`rounded px-1.5 py-0.5 text-xs font-semibold ${TIER_STYLE.worth_a_call}`}>Worth a call</span> about ₹{WORTH_A_CALL_MONTHLY.toLocaleString("en-IN")} – {HIGH_VALUE_MONTHLY.toLocaleString("en-IN")} a month</div>
            <div className="mt-1.5"><span className={`rounded px-1.5 py-0.5 text-xs font-semibold ${TIER_STYLE.passing}`}>Passing</span> under ₹{WORTH_A_CALL_MONTHLY.toLocaleString("en-IN")}, no seats or price known, or 1–2 virtual or hot desks</div>
            <p className="mt-2 text-xs text-muted-foreground">The reason behind each tier is shown on the card, so nobody has to trust a hidden score.</p>
          </div>
        </>
      )}

      <RateCardDialog open={rateOpen} onOpenChange={setRateOpen} locations={data?.locations ?? []} locationId={location === "all" ? null : location} onSaved={load} />
    </div>
  );
}
