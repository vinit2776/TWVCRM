"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { VO_RATE_PURPOSES, VO_RATE_PURPOSE_COLORS, VO_RATE_PURPOSE_LABELS } from "@/lib/constants";
import { formatCurrency, formatDate } from "@/lib/utils";
import type { RateLocation } from "@/components/admin/vo-rates/direct-rates-panel";

export interface RateAggregator {
  id: string;
  name: string;
}

interface AggRateRow {
  id: string;
  purpose: string;
  location_id: string | null;
  pricing_type: "open" | "fixed";
  share_percent: number | null;
  min_customer_price: number | null;
  fixed_rate: number | null;
  version: number;
  effective_from: string;
  effective_until: string | null;
  is_current: boolean;
  reason: string | null;
}

const ANY = "any";
const BLANK = "blank";

export function AggregatorRatesPanel({
  aggregators,
  locations,
  canEdit,
}: {
  aggregators: RateAggregator[];
  locations: RateLocation[];
  canEdit: boolean;
}) {
  const [aggregatorId, setAggregatorId] = useState(aggregators[0]?.id ?? "");
  const [rows, setRows] = useState<AggRateRow[]>([]);
  const [setupMessage, setSetupMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [copyFrom, setCopyFrom] = useState(BLANK);

  const [purpose, setPurpose] = useState<string>(VO_RATE_PURPOSES[0]);
  const [locationId, setLocationId] = useState(ANY);
  const [pricingType, setPricingType] = useState<"open" | "fixed">("open");
  const [share, setShare] = useState("");
  const [minPrice, setMinPrice] = useState("");
  const [fixedRate, setFixedRate] = useState("");
  const [reason, setReason] = useState("");

  const locationName = useCallback(
    (id: string | null) => (id ? locations.find((l) => l.id === id)?.name ?? "Unknown location" : "Any location"),
    [locations],
  );

  const load = useCallback(async () => {
    if (!aggregatorId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const res = await fetch(`/api/admin/vo-aggregator-rates?aggregator_id=${aggregatorId}&history=1`, { cache: "no-store" });
      if (!res.ok) throw new Error(res.status === 403 ? "You do not have access to rate cards" : "Could not load the card");
      const json = (await res.json()) as { data: AggRateRow[]; setup?: boolean; message?: string };
      setRows(json.data ?? []);
      setSetupMessage(json.setup === false ? json.message ?? "Rate cards are not set up yet." : null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not load the card");
    } finally {
      setLoading(false);
    }
  }, [aggregatorId]);

  useEffect(() => {
    void load();
  }, [load]);

  const current = useMemo(() => rows.filter((r) => r.is_current), [rows]);
  const history = useMemo(() => rows.filter((r) => !r.is_current), [rows]);

  const post = async (payload: Record<string, unknown>, okMessage: string) => {
    setSaving(true);
    try {
      const res = await fetch("/api/admin/vo-aggregator-rates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? "Could not save");
      }
      toast.success(okMessage);
      setReason("");
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save");
    } finally {
      setSaving(false);
    }
  };

  const startCard = () =>
    post(
      { action: "add_card", aggregator_id: aggregatorId, ...(copyFrom !== BLANK ? { copy_from_aggregator_id: copyFrom } : {}) },
      copyFrom === BLANK ? "Blank card started" : "Card copied",
    );

  const saveRow = () =>
    post(
      {
        aggregator_id: aggregatorId,
        purpose,
        location_id: locationId === ANY ? null : locationId,
        pricing_type: pricingType,
        share_percent: pricingType === "open" && share.trim() !== "" ? Number(share) : null,
        min_customer_price: pricingType === "open" && minPrice.trim() !== "" ? Number(minPrice) : null,
        fixed_rate: pricingType === "fixed" && fixedRate.trim() !== "" ? Number(fixedRate) : null,
        reason: reason.trim() || undefined,
      },
      "Rate saved as a new version",
    );

  const edit = (r: AggRateRow) => {
    setPurpose(r.purpose);
    setLocationId(r.location_id ?? ANY);
    setPricingType(r.pricing_type);
    setShare(r.share_percent === null ? "" : String(r.share_percent));
    setMinPrice(r.min_customer_price === null ? "" : String(r.min_customer_price));
    setFixedRate(r.fixed_rate === null ? "" : String(r.fixed_rate));
    setReason("");
  };

  const describe = (r: AggRateRow) =>
    r.pricing_type === "fixed"
      ? `Fixed ${formatCurrency(r.fixed_rate ?? 0)}`
      : `Open, we take ${r.share_percent}%${r.min_customer_price !== null ? `, minimum customer price ${formatCurrency(r.min_customer_price)}` : ""}`;

  if (aggregators.length === 0) return <p className="text-sm text-muted-foreground">No aggregators yet.</p>;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <span className="text-sm text-muted-foreground">Aggregator</span>
        <Select value={aggregatorId} onValueChange={setAggregatorId}>
          <SelectTrigger className="w-72"><SelectValue /></SelectTrigger>
          <SelectContent>{aggregators.map((a) => <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>)}</SelectContent>
        </Select>
      </div>

      {setupMessage && <Card><CardContent className="pt-6 text-sm">{setupMessage}</CardContent></Card>}

      {loading ? (
        <Loader2 className="h-5 w-5 animate-spin" />
      ) : (
        <>
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-base">Current card</CardTitle></CardHeader>
            <CardContent className="space-y-2">
              {current.length === 0 && (
                <div className="space-y-3">
                  <p className="text-sm text-muted-foreground">This aggregator has no custom card yet.</p>
                  {canEdit && !setupMessage && (
                    <div className="flex flex-wrap items-center gap-3">
                      <Select value={copyFrom} onValueChange={setCopyFrom}>
                        <SelectTrigger className="w-72"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value={BLANK}>Start blank</SelectItem>
                          {aggregators.filter((a) => a.id !== aggregatorId).map((a) => (
                            <SelectItem key={a.id} value={a.id}>Copy from {a.name}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Button onClick={startCard} disabled={saving}>Add card</Button>
                    </div>
                  )}
                </div>
              )}
              {current.map((r) => (
                <div key={r.id} className="flex flex-wrap items-center gap-3 border-b py-2 text-sm last:border-0">
                  <Badge className={VO_RATE_PURPOSE_COLORS[r.purpose]}>{VO_RATE_PURPOSE_LABELS[r.purpose] ?? r.purpose}</Badge>
                  <span className="w-40">{locationName(r.location_id)}</span>
                  <span>{describe(r)}</span>
                  <span className="text-muted-foreground">v{r.version}, from {formatDate(r.effective_from)}</span>
                  {canEdit && <Button size="sm" variant="outline" className="ml-auto" onClick={() => edit(r)}>Edit</Button>}
                </div>
              ))}
            </CardContent>
          </Card>

          {canEdit && !setupMessage && (
            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-base">Add or change a row</CardTitle></CardHeader>
              <CardContent className="grid gap-3 sm:grid-cols-3">
                <div className="space-y-1">
                  <Label>Purpose</Label>
                  <Select value={purpose} onValueChange={setPurpose}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>{VO_RATE_PURPOSES.map((p) => <SelectItem key={p} value={p}>{VO_RATE_PURPOSE_LABELS[p]}</SelectItem>)}</SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label>Location</Label>
                  <Select value={locationId} onValueChange={setLocationId}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value={ANY}>Any location</SelectItem>
                      {locations.map((l) => <SelectItem key={l.id} value={l.id}>{l.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label>Pricing</Label>
                  <Select value={pricingType} onValueChange={(v) => setPricingType(v as "open" | "fixed")}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="open">Open (our share of their price)</SelectItem>
                      <SelectItem value="fixed">Fixed rate</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                {pricingType === "open" ? (
                  <>
                    <div className="space-y-1"><Label>Our share (%)</Label><Input type="number" min={1} max={99} value={share} onChange={(e) => setShare(e.target.value)} /></div>
                    <div className="space-y-1"><Label>Minimum customer price (optional)</Label><Input type="number" min={0} value={minPrice} onChange={(e) => setMinPrice(e.target.value)} /></div>
                  </>
                ) : (
                  <div className="space-y-1"><Label>Fixed rate</Label><Input type="number" min={0} value={fixedRate} onChange={(e) => setFixedRate(e.target.value)} /></div>
                )}
                <div className="space-y-1"><Label>Reason (required when changing)</Label><Input value={reason} onChange={(e) => setReason(e.target.value)} /></div>
                <div className="sm:col-span-3"><Button onClick={saveRow} disabled={saving}>{saving ? "Saving..." : "Save new version"}</Button></div>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-base">Change history</CardTitle></CardHeader>
            <CardContent className="space-y-2">
              {history.length === 0 && <p className="text-sm text-muted-foreground">No earlier versions.</p>}
              {history.map((r) => (
                <div key={r.id} className="flex flex-wrap gap-3 border-b py-2 text-sm last:border-0">
                  <span>{VO_RATE_PURPOSE_LABELS[r.purpose] ?? r.purpose}</span>
                  <span>{locationName(r.location_id)}</span>
                  <span>v{r.version}: {describe(r)}</span>
                  <span className="text-muted-foreground">{formatDate(r.effective_from)} to {r.effective_until ? formatDate(r.effective_until) : "now"}</span>
                  {r.reason && <span className="text-muted-foreground">{r.reason}</span>}
                </div>
              ))}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
