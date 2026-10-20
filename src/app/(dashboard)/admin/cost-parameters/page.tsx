"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Calculator, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PageBreadcrumb } from "@/components/page-breadcrumb";
import {
  COST_PARAMETER_DEFS,
  inForce,
  type CostParameterDef,
  type CostParameterKey,
  type CostParameterRow,
} from "@/lib/customer-value/cost-parameters";

interface ApiRow extends CostParameterRow {
  set_by_user: { full_name: string | null } | { full_name: string | null }[] | null;
}

interface Location {
  id: string;
  name: string;
}

interface PreviewData {
  weight: number;
  customers: number;
  withMargin: number;
  profitabilityChanged: number;
  counts: { unchanged: number; up: number; down: number; gainedTier: number; lostTier: number };
  tierChanges: Array<{ leadId: string; name: string; from: string | null; to: string | null; overallFrom: number | null; overallTo: number | null }>;
  moreChanges: number;
  warnings: string[];
}

function MarginPreviewCard() {
  const [weight, setWeight] = useState("40");
  const [running, setRunning] = useState(false);
  const [data, setData] = useState<PreviewData | null>(null);

  const run = async () => {
    setRunning(true);
    try {
      const res = await fetch(`/api/admin/customer-value/margin-preview?weight=${encodeURIComponent(weight)}`, { cache: "no-store" });
      if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? "Could not run the preview");
      setData((await res.json()) as PreviewData);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not run the preview");
    } finally {
      setRunning(false);
    }
  };

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Would margin change anyone&apos;s tier?</CardTitle>
        <p className="text-xs text-muted-foreground">
          Margin after variable costs is stored beside each score but is not part of it. This tries giving it a weight inside Profitability and shows who would move. Nothing is saved or changed.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-end gap-2">
          <label className="text-xs text-muted-foreground">
            Weight inside Profitability (others: concessions 50, rent 30, escalation 20)
            <Input value={weight} onChange={(e) => setWeight(e.target.value)} inputMode="numeric" className="mt-1 h-9 w-28" aria-label="Margin weight" />
          </label>
          <Button size="sm" onClick={() => void run()} disabled={running}>{running ? <Loader2 className="h-4 w-4 animate-spin" /> : "Run preview"}</Button>
        </div>
        {data && (
          <div className="space-y-3 text-sm">
            {data.warnings.map((w) => <p key={w} className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-amber-900">{w}</p>)}
            <p>
              {data.withMargin} of {data.customers} customers have stored margin. At weight {data.weight}: <strong>{data.counts.up}</strong> would move up a tier, <strong>{data.counts.down}</strong> down, {data.counts.gainedTier} would gain a tier and {data.counts.lostTier} lose one; {data.counts.unchanged} stay put. Profitability would change for {data.profitabilityChanged}.
            </p>
            {data.tierChanges.length > 0 && (
              <ul className="divide-y rounded-md border">
                {data.tierChanges.map((c) => (
                  <li key={c.leadId} className="flex items-center justify-between gap-3 px-3 py-2">
                    <span className="font-medium">{c.name}</span>
                    <span className="tabular-nums text-muted-foreground">{c.from ?? "no tier"} → <strong className="text-foreground">{c.to ?? "no tier"}</strong> · overall {c.overallFrom === null ? "—" : Math.round(c.overallFrom)} → {c.overallTo === null ? "—" : Math.round(c.overallTo)}</span>
                  </li>
                ))}
                {data.moreChanges > 0 && <li className="px-3 py-2 text-xs text-muted-foreground">and {data.moreChanges} more</li>}
              </ul>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

const GLOBAL = "global";
const todayYmd = () => new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
const fmtDate = (ymd: string) => new Date(`${ymd}T00:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const fmtValue = (def: CostParameterDef, v: number) => (def.unit.startsWith("₹") ? `₹${v.toLocaleString("en-IN")}` : `${v}%`);
const setterName = (r: ApiRow) => (Array.isArray(r.set_by_user) ? r.set_by_user[0]?.full_name : r.set_by_user?.full_name) ?? "someone";

function ParameterRow({
  def,
  rows,
  scope,
  locationId,
  inherited,
  onSaved,
}: {
  def: CostParameterDef;
  rows: ApiRow[];
  scope: "global" | "location";
  locationId: string | null;
  inherited: CostParameterRow | null;
  onSaved: () => void;
}) {
  const today = todayYmd();
  const current = inForce(rows, scope, { locationId }, def.key, today);
  const [value, setValue] = useState(current ? String(current.value) : "");
  const [from, setFrom] = useState(today);
  const [saving, setSaving] = useState(false);
  const [showHistory, setShowHistory] = useState(false);

  const history = rows
    .filter((r) => r.key === def.key && r.scope === scope && (scope === "global" || r.location_id === locationId))
    .sort((a, b) => (a.effective_from === b.effective_from ? (a.created_at < b.created_at ? 1 : -1) : a.effective_from < b.effective_from ? 1 : -1));

  const send = async (next: number | null) => {
    setSaving(true);
    try {
      const res = await fetch("/api/admin/customer-value/cost-parameters", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope, ...(scope === "location" ? { location_id: locationId } : {}), key: def.key, value: next, effective_from: from }),
      });
      if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? "Could not save");
      toast.success(next === null ? `${def.label} cleared` : `${def.label} saved`);
      onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save");
    } finally {
      setSaving(false);
    }
  };

  const save = () => {
    const n = Number(value);
    if (value.trim() === "" || !Number.isFinite(n) || n < 0) {
      toast.error("Enter a number of zero or more, or use Clear");
      return;
    }
    void send(n);
  };

  return (
    <div className="border-b py-4 last:border-0">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-[220px] flex-1">
          <p className="font-medium">{def.label} <span className="font-normal text-muted-foreground">· {def.unit}</span></p>
          {def.help && <p className="text-xs text-muted-foreground">{def.help}</p>}
          <p className="mt-1 text-xs">
            {current ? (
              <span>In force: <strong>{fmtValue(def, Number(current.value))}</strong> since {fmtDate(current.effective_from)}</span>
            ) : scope === "location" && inherited ? (
              <span className="text-muted-foreground">Using the default for all centers: {fmtValue(def, Number(inherited.value))}</span>
            ) : (
              <span className="text-muted-foreground">Not entered, so this cost is left out</span>
            )}
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <label className="text-xs text-muted-foreground">
            New value
            <Input value={value} onChange={(e) => setValue(e.target.value)} inputMode="decimal" className="mt-1 h-9 w-32" aria-label={`${def.label} value`} />
          </label>
          <label className="text-xs text-muted-foreground">
            From
            <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="mt-1 h-9 w-40" aria-label={`${def.label} effective from`} />
          </label>
          <Button size="sm" onClick={save} disabled={saving}>{saving ? <Loader2 className="h-4 w-4 animate-spin" /> : "Save"}</Button>
          {current && <Button size="sm" variant="outline" onClick={() => void send(null)} disabled={saving}>Clear</Button>}
          {history.length > 0 && <Button size="sm" variant="ghost" onClick={() => setShowHistory((s) => !s)}>{showHistory ? "Hide history" : `History (${history.length})`}</Button>}
        </div>
      </div>
      {showHistory && (
        <ul className="mt-3 space-y-1 rounded-md bg-muted/40 p-3 text-xs">
          {history.map((r) => (
            <li key={r.id}>
              {r.value === null ? <Badge variant="secondary">Cleared</Badge> : <strong>{fmtValue(def, Number(r.value))}</strong>} from {fmtDate(r.effective_from)}
              <span className="text-muted-foreground"> · set by {setterName(r)} on {fmtDate(r.created_at.slice(0, 10))}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function CostParametersPage() {
  const [rows, setRows] = useState<ApiRow[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [scopeId, setScopeId] = useState<string>(GLOBAL);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [pRes, lRes] = await Promise.all([
        fetch("/api/admin/customer-value/cost-parameters", { cache: "no-store" }),
        fetch("/api/locations").then((r) => r.json()).catch(() => ({ data: [] })),
      ]);
      if (!pRes.ok) throw new Error(pRes.status === 403 ? "Admins only" : "Could not load the cost settings");
      setRows(((await pRes.json()) as { data: ApiRow[] }).data ?? []);
      setLocations(((lRes.data ?? lRes.locations ?? []) as Location[]).slice().sort((a, b) => a.name.localeCompare(b.name)));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load the cost settings");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const scope = scopeId === GLOBAL ? "global" : "location";
  const locationId = scopeId === GLOBAL ? null : scopeId;
  const today = useMemo(todayYmd, []);

  return (
    <div className="space-y-6">
      <PageBreadcrumb resetTo={{ label: "Cost settings" }} />
      <div className="flex items-start gap-3">
        <Calculator className="mt-1 h-6 w-6 text-muted-foreground" />
        <div>
          <h1 className="text-2xl font-semibold">Customer value: cost settings</h1>
          <p className="text-sm text-muted-foreground">
            The rates behind the cost simulator on each customer&apos;s Value tab. Nothing is assumed: a cost with no value here is left out of the margin. A value applies from its start date, and changing it never rewrites earlier months. A center value overrides the default for that center.
          </p>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <span className="text-sm text-muted-foreground">Applies to</span>
        <Select value={scopeId} onValueChange={setScopeId}>
          <SelectTrigger className="w-64"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value={GLOBAL}>All centers (default)</SelectItem>
            {locations.map((l) => <SelectItem key={l.id} value={l.id}>{l.name}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      <Card>
        <CardHeader className="pb-0"><CardTitle className="text-base">{scopeId === GLOBAL ? "Defaults for all centers" : `${locations.find((l) => l.id === scopeId)?.name ?? "Center"} overrides`}</CardTitle></CardHeader>
        <CardContent>
          {loading ? (
            <p className="py-6 text-sm text-muted-foreground">Loading…</p>
          ) : error ? (
            <div className="flex items-center justify-between py-6">
              <p className="text-sm text-muted-foreground">{error}</p>
              <Button variant="outline" size="sm" onClick={() => { setLoading(true); void load(); }}>Retry</Button>
            </div>
          ) : (
            COST_PARAMETER_DEFS.map((def) => (
              <ParameterRow
                key={`${scopeId}:${def.key}:${rows.length}`}
                def={def}
                rows={rows}
                scope={scope}
                locationId={locationId}
                inherited={scope === "location" ? inForce(rows, "global", {}, def.key as CostParameterKey, today) : null}
                onSaved={() => void load()}
              />
            ))
          )}
        </CardContent>
      </Card>
      <MarginPreviewCard />

      <p className="text-xs text-muted-foreground">A value for one customer (for example their acquisition cost) is set from that customer&apos;s Value tab, and overrides these.</p>
    </div>
  );
}
