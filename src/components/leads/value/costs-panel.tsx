"use client";

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Calculator } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/shared/empty-state";
import { Skeleton } from "@/components/shared/loading-skeleton";
import type { CostParams, CostKey, CostStatus, SimBase, SimResult } from "@/lib/customer-value/cost-simulator";
import { simulate } from "@/lib/customer-value/cost-simulator";
import type { CostParameterScope } from "@/lib/customer-value/cost-parameters";

interface CostsData {
  today: string;
  status: "ok" | "no_center" | "no_figures";
  center: { id: string; name: string } | null;
  base?: SimBase;
  months?: string[];
  params?: CostParams;
  sources?: Partial<Record<keyof CostParams, { scope: CostParameterScope; effective_from: string }>>;
  electricityStatus?: string;
  ticketsLinked?: number;
}

const inr = (v: number) => `${v < 0 ? "−" : ""}₹${Math.abs(Math.round(v)).toLocaleString("en-IN")}`;
const pct = (v: number | null) => (v === null ? "—" : `${(v * 100).toFixed(0)}%`);
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const monthLabel = (ym: string) => `${MONTHS[Number(ym.slice(5, 7)) - 1]} ${ym.slice(2, 4)}`;

const STATUS: Record<CostStatus, { label: string; className: string }> = {
  live: { label: "Live", className: "bg-emerald-100 text-emerald-800" },
  part_live: { label: "Part live", className: "bg-sky-100 text-sky-800" },
  needs_input: { label: "Needs input", className: "bg-amber-100 text-amber-900" },
};

const COLORS: Record<CostKey | "margin", string> = {
  electricity: "#f59e0b", concessions: "#ef4444", staff_time: "#8b5cf6", late_payment: "#ec4899", pantry: "#14b8a6", acquisition: "#6366f1",
  rent_share: "#64748b", housekeeping: "#0ea5e9", maintenance: "#84cc16", front_desk: "#f97316", internet: "#06b6d4", overhead: "#a8a29e", margin: "#059669",
};

function Stat({ label, value, note, tone }: { label: string; value: string; note?: string; tone?: "bad" | "good" }) {
  return (
    <div className="rounded-lg border p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`mt-0.5 text-lg font-semibold tabular-nums ${tone === "bad" ? "text-red-700" : tone === "good" ? "text-emerald-700" : ""}`}>{value}</p>
      {note && <p className="mt-0.5 text-xs text-muted-foreground">{note}</p>}
    </div>
  );
}

function RupeeBar({ result }: { result: SimResult }) {
  const parts = result.whereItGoes.filter((w) => w.amount > 0);
  const total = parts.reduce((n, w) => n + w.amount, 0);
  if (result.revenue <= 0 || total <= 0) return null;
  return (
    <div>
      <div className="flex h-6 w-full overflow-hidden rounded-md border" role="img" aria-label="Where each rupee of revenue goes">
        {parts.map((w) => (
          <div key={w.key} style={{ width: `${(w.amount / total) * 100}%`, backgroundColor: COLORS[w.key] }} title={`${w.label}: ${inr(w.amount)}`} />
        ))}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {parts.map((w) => (
          <span key={w.key} className="flex items-center gap-1.5"><span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: COLORS[w.key] }} />{w.label} {inr(w.amount)}</span>
        ))}
      </div>
      {result.fullyLoadedMargin < 0 && <p className="mt-2 text-xs text-red-700">Costs are {inr(-result.fullyLoadedMargin)} a month more than the customer pays, so there is nothing left over.</p>}
    </div>
  );
}

function Slider({ label, value, min, max, step, onChange, format }: { label: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void; format: (v: number) => string }) {
  return (
    <label className="block text-sm">
      <span className="flex items-center justify-between"><span>{label}</span><span className="font-medium tabular-nums">{format(value)}</span></span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} className="mt-1 w-full accent-violet-600" aria-label={label} />
    </label>
  );
}

export function CostsPanel({ leadId }: { leadId: string }) {
  const [data, setData] = useState<CostsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [seats, setSeats] = useState<number | null>(null);
  const [rent, setRent] = useState<number | null>(null);
  const [acq, setAcq] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/leads/${leadId}/value/costs`, { cache: "no-store" });
      if (!res.ok) throw new Error(res.status === 403 ? "Admins only" : "Could not load costs");
      setData((await res.json()) as CostsData);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load costs");
    } finally {
      setLoading(false);
    }
  }, [leadId]);

  useEffect(() => {
    void load();
  }, [load]);

  const base = data?.base;
  const params = data?.params;
  const current = useMemo(() => (base && params ? simulate(base, params) : null), [base, params]);
  const whatIf = useMemo(() => (base && params ? simulate(base, params, { seats: seats ?? undefined, rentPerSeat: rent ?? undefined }) : null), [base, params, seats, rent]);
  const changed = seats !== null || rent !== null;

  const saveAcquisition = async () => {
    const value = Number(acq);
    if (acq.trim() === "" || !Number.isFinite(value) || value < 0) {
      toast.error("Enter an amount of zero or more");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch("/api/admin/customer-value/cost-parameters", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope: "lead", lead_id: leadId, key: "acquisition_cost", value, effective_from: data?.today }),
      });
      if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? "Could not save");
      toast.success("Acquisition cost saved for this customer");
      setAcq("");
      void load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save");
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-20" />
        <Skeleton className="h-24" />
        <Skeleton className="h-56" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <Card>
        <CardContent className="flex items-center justify-between gap-4 py-6">
          <p className="text-sm text-muted-foreground">{error ?? "Could not load costs"}</p>
          <Button variant="outline" size="sm" onClick={() => void load()}>Retry</Button>
        </CardContent>
      </Card>
    );
  }

  if (data.status !== "ok" || !base || !params || !current || !whatIf) {
    return (
      <Card>
        <CardContent>
          <EmptyState
            icon={Calculator}
            title={data.status === "no_center" ? "No center yet" : "Not enough figures yet"}
            description={data.status === "no_center" ? "This customer has no contract at a center, so there is nothing to cost." : "The simulator needs at least one completed month of figures with seats on a contract. They are computed each night, or use Recompute above."}
          />
        </CardContent>
      </Card>
    );
  }

  const shown = changed ? whatIf : current;
  const delta = (a: number, b: number) => (a === b ? null : `${a > b ? "+" : "−"}${inr(Math.abs(a - b))}`);
  const maxSeats = Math.max(40, Math.round(base.seats * 3));
  const rentNow = current.rentPerSeat;
  const acquisitionSource = data.sources?.acquisitionCost;
  const missing = shown.lines.filter((l) => l.status === "needs_input");

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">
        Monthly averages over {base.months} completed month{base.months === 1 ? "" : "s"} ({data.months?.map(monthLabel).join(", ")}) at {data.center?.name}. These are estimates: every rate that is not measured is one you entered.
      </p>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Revenue a month" value={inr(shown.revenue)} note={changed ? `${delta(shown.revenue, current.revenue) ?? "same as now"} against now` : "Rent and usage, before GST"} />
        <Stat label="Margin after variable costs" value={inr(shown.marginAfterVariable)} note={`${pct(shown.marginAfterVariablePct)} of revenue${changed ? ` · ${delta(shown.marginAfterVariable, current.marginAfterVariable) ?? "same as now"}` : ""}`} tone={shown.marginAfterVariable < 0 ? "bad" : undefined} />
        <Stat label="Fully-loaded margin (estimate)" value={inr(shown.fullyLoadedMargin)} note={`${pct(shown.fullyLoadedPct)} of revenue${changed ? ` · ${delta(shown.fullyLoadedMargin, current.fullyLoadedMargin) ?? "same as now"}` : ""}`} tone={shown.fullyLoadedMargin < 0 ? "bad" : undefined} />
        <Stat
          label="Break-even rent per seat"
          value={shown.breakEvenFullyLoaded === null ? "—" : inr(shown.breakEvenFullyLoaded)}
          note={shown.rentPerSeat === null ? "Rent per seat is not known for this contract" : `${changed ? "Offered" : "Pays"} ${inr(shown.rentPerSeat)}${changed ? "" : " now"}${shown.breakEvenAfterVariable !== null ? ` · covers variable costs from ${inr(shown.breakEvenAfterVariable)}` : ""}`}
        />
      </div>

      <div className={`rounded-md border px-3 py-2 text-sm ${shown.confidence !== null && shown.confidence < 0.5 ? "border-amber-300 bg-amber-50 text-amber-900" : "bg-muted/40"}`}>
        {shown.confidence === null ? "Nothing is costed yet." : `${pct(shown.confidence)} of the cost counted here rests on measured data.`}
        {missing.length > 0 && (
          <>
            {" "}{missing.length} cost line{missing.length === 1 ? " is" : "s are"} not included: {missing.map((l) => l.label.charAt(0).toLowerCase() + l.label.slice(1)).join(", ")}.{" "}
            <Link href="/admin/cost-parameters" className="font-medium underline">Enter rates</Link>
          </>
        )}
      </div>

      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">Where each rupee goes</CardTitle></CardHeader>
        <CardContent><RupeeBar result={shown} /></CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Try a different offer</CardTitle>
          <p className="text-xs text-muted-foreground">Seats scale electricity, rent share and per-seat costs. Ticket time, acquisition and concessions stay as they are.</p>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 md:grid-cols-2">
            <Slider label="Seats" value={seats ?? Math.round(base.seats)} min={1} max={maxSeats} step={1} onChange={setSeats} format={(v) => String(v)} />
            {rentNow !== null ? (
              <Slider label="Rent per seat" value={rent ?? Math.round(rentNow)} min={0} max={Math.max(5000, Math.round(rentNow * 2))} step={100} onChange={setRent} format={inr} />
            ) : (
              <p className="text-sm text-muted-foreground">Rent per seat is not known for this contract, so only seats can be changed.</p>
            )}
          </div>
          {changed && <Button size="sm" variant="outline" onClick={() => { setSeats(null); setRent(null); }}>Reset to now</Button>}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">Cost lines</CardTitle></CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full min-w-[560px] text-sm">
            <thead>
              <tr className="border-b text-left text-xs text-muted-foreground">
                <th className="py-2 pr-3 font-medium">Line</th>
                <th className="py-2 pr-3 font-medium">Status</th>
                <th className="py-2 text-right font-medium">A month</th>
              </tr>
            </thead>
            <tbody>
              {(["variable", "fixed"] as const).map((group) => (
                <Fragment key={group}>
                  <tr><td colSpan={3} className="pt-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">{group === "variable" ? "Variable costs" : "Fixed costs"}</td></tr>
                  {shown.lines.filter((l) => l.group === group).map((l) => (
                    <tr key={l.key} className="border-b last:border-0">
                      <td className="py-2 pr-3">
                        {l.label}
                        {l.reason && <div className="text-xs text-muted-foreground">{l.reason}</div>}
                      </td>
                      <td className="py-2 pr-3"><Badge variant="secondary" className={`whitespace-nowrap ${STATUS[l.status].className}`}>{STATUS[l.status].label}</Badge></td>
                      <td className="py-2 text-right tabular-nums">{l.status === "needs_input" ? "—" : inr(l.amount)}</td>
                    </tr>
                  ))}
                </Fragment>
              ))}
            </tbody>
          </table>
          <p className="mt-3 text-xs text-muted-foreground">
            Live: measured. Part live: a measured quantity times a rate someone entered. Needs input: left out until its rate is entered or its measurement exists.
            {data.electricityStatus && data.electricityStatus !== "ok" ? " Electricity is not measurable at this center yet (see the Electricity tab)." : ""}
            {(data.ticketsLinked ?? 0) === 0 ? " Staff time stays out until a ticket is tied to this customer." : ""}
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Set for this customer</CardTitle>
          <p className="text-xs text-muted-foreground">
            Acquisition cost: commission or spend to win this customer, spread over their tenure.
            {acquisitionSource ? ` Now ${inr(params.acquisitionCost ?? 0)} (${acquisitionSource.scope === "lead" ? "set for this customer" : acquisitionSource.scope === "location" ? "center default" : "default for all centers"}).` : " Not entered."}
          </p>
        </CardHeader>
        <CardContent className="flex flex-wrap items-end gap-2">
          <label className="text-xs text-muted-foreground">
            Amount (₹, one-off)
            <Input value={acq} onChange={(e) => setAcq(e.target.value)} inputMode="decimal" className="mt-1 h-9 w-40" aria-label="Acquisition cost for this customer" />
          </label>
          <Button size="sm" onClick={() => void saveAcquisition()} disabled={saving}>Save for this customer</Button>
          <span className="text-xs text-muted-foreground">Other rates are set in <Link href="/admin/cost-parameters" className="underline">Value Cost Settings</Link>.</span>
        </CardContent>
      </Card>
    </div>
  );
}
