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
import {
  VO_RATE_PURPOSES,
  VO_RATE_PURPOSE_COLORS,
  VO_RATE_PURPOSE_LABELS,
  VO_RATE_TERM_OPTIONS,
} from "@/lib/constants";
import { formatCurrency, formatDate } from "@/lib/utils";

export interface RateLocation {
  id: string;
  name: string;
}

interface DirectRateRow {
  id: string;
  purpose: string;
  location_id: string | null;
  guide_fee: number;
  floor_fee: number | null;
  default_term_months: number;
  version: number;
  effective_from: string;
  effective_until: string | null;
  is_current: boolean;
  reason: string | null;
  created_at: string;
}

const ANY = "any";

export function DirectRatesPanel({ locations, canEdit }: { locations: RateLocation[]; canEdit: boolean }) {
  const [rows, setRows] = useState<DirectRateRow[]>([]);
  const [setupMessage, setSetupMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const [purpose, setPurpose] = useState<string>(VO_RATE_PURPOSES[0]);
  const [locationId, setLocationId] = useState<string>(ANY);
  const [guide, setGuide] = useState("");
  const [floor, setFloor] = useState("");
  const [term, setTerm] = useState("12");
  const [reason, setReason] = useState("");

  const locationName = useCallback(
    (id: string | null) => (id ? locations.find((l) => l.id === id)?.name ?? "Unknown location" : "Any location"),
    [locations],
  );

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/vo-rates?history=1", { cache: "no-store" });
      if (!res.ok) throw new Error(res.status === 403 ? "You do not have access to rate cards" : "Could not load rate cards");
      const json = (await res.json()) as { data: DirectRateRow[]; setup?: boolean; message?: string };
      setRows(json.data ?? []);
      setSetupMessage(json.setup === false ? json.message ?? "Rate cards are not set up yet." : null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not load rate cards");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const current = useMemo(() => rows.filter((r) => r.is_current), [rows]);
  const existing = useMemo(
    () => current.find((r) => r.purpose === purpose && (r.location_id ?? ANY) === locationId) ?? null,
    [current, purpose, locationId],
  );

  const edit = (r: DirectRateRow) => {
    setPurpose(r.purpose);
    setLocationId(r.location_id ?? ANY);
    setGuide(String(r.guide_fee));
    setFloor(r.floor_fee === null ? "" : String(r.floor_fee));
    setTerm(String(r.default_term_months));
    setReason("");
  };

  const save = async () => {
    const guideFee = Number(guide);
    const floorFee = floor.trim() === "" ? null : Number(floor);
    if (!Number.isFinite(guideFee) || guideFee < 0) return toast.error("Enter a guide price");
    if (floorFee !== null && (!Number.isFinite(floorFee) || floorFee < 0)) return toast.error("Enter a valid floor price");
    if (floorFee !== null && floorFee > guideFee) return toast.error("The floor cannot be above the guide price");
    if (existing && !reason.trim()) return toast.error("Give a reason for the change");

    setSaving(true);
    try {
      const res = await fetch("/api/admin/vo-rates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          purpose,
          location_id: locationId === ANY ? null : locationId,
          guide_fee: guideFee,
          floor_fee: floorFee,
          default_term_months: Number(term),
          reason: reason.trim() || undefined,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? "Could not save the rate");
      }
      toast.success(existing ? "New version saved" : "Rate added");
      setReason("");
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save the rate");
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading</div>;
  }

  if (setupMessage) {
    return (
      <Card>
        <CardContent className="py-6 text-sm text-muted-foreground">{setupMessage}</CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">Current rates</CardTitle></CardHeader>
        <CardContent>
          {current.length === 0 ? (
            <p className="text-sm text-muted-foreground">No rates set yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    <th className="py-2 pr-4 font-medium">Purpose</th>
                    <th className="py-2 pr-4 font-medium">Location</th>
                    <th className="py-2 pr-4 text-right font-medium">Guide</th>
                    <th className="py-2 pr-4 text-right font-medium">Floor</th>
                    <th className="py-2 pr-4 font-medium">Default term</th>
                    <th className="py-2 pr-4 font-medium">Version</th>
                    <th className="py-2 pr-4 font-medium">Effective from</th>
                    {canEdit && <th className="py-2" />}
                  </tr>
                </thead>
                <tbody>
                  {current.map((r) => (
                    <tr key={r.id} className="border-b last:border-0">
                      <td className="py-2 pr-4"><Badge className={VO_RATE_PURPOSE_COLORS[r.purpose]}>{VO_RATE_PURPOSE_LABELS[r.purpose] ?? r.purpose}</Badge></td>
                      <td className="py-2 pr-4">{locationName(r.location_id)}</td>
                      <td className="py-2 pr-4 text-right">{formatCurrency(r.guide_fee)}</td>
                      <td className="py-2 pr-4 text-right">{r.floor_fee === null ? "None" : formatCurrency(r.floor_fee)}</td>
                      <td className="py-2 pr-4">{r.default_term_months} months</td>
                      <td className="py-2 pr-4">v{r.version}</td>
                      <td className="py-2 pr-4">{formatDate(r.effective_from)}</td>
                      {canEdit && <td className="py-2 text-right"><Button size="sm" variant="outline" onClick={() => edit(r)}>Edit</Button></td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {canEdit ? (
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base">{existing ? "Save a new version" : "Add a rate"}</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <div className="space-y-1.5">
                <Label>Purpose</Label>
                <Select value={purpose} onValueChange={setPurpose}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {VO_RATE_PURPOSES.map((p) => <SelectItem key={p} value={p}>{VO_RATE_PURPOSE_LABELS[p]}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Location</Label>
                <Select value={locationId} onValueChange={setLocationId}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ANY}>Any location</SelectItem>
                    {locations.map((l) => <SelectItem key={l.id} value={l.id}>{l.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Default term</Label>
                <Select value={term} onValueChange={setTerm}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {VO_RATE_TERM_OPTIONS.map((t) => <SelectItem key={t} value={String(t)}>{t} months</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Guide price</Label>
                <Input type="number" min={0} value={guide} onChange={(e) => setGuide(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label>Floor price (optional)</Label>
                <Input type="number" min={0} value={floor} onChange={(e) => setFloor(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label>{existing ? "Reason for change" : "Note (optional)"}</Label>
                <Input value={reason} onChange={(e) => setReason(e.target.value)} />
              </div>
            </div>
            <Button onClick={save} disabled={saving}>
              {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {existing ? "Save new version" : "Add rate"}
            </Button>
          </CardContent>
        </Card>
      ) : (
        <p className="text-sm text-muted-foreground">You can view rates but only admins and managers can change them.</p>
      )}

      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">Change history</CardTitle></CardHeader>
        <CardContent>
          {rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">No changes yet.</p>
          ) : (
            <ul className="divide-y text-sm">
              {rows.slice().sort((a, b) => b.created_at.localeCompare(a.created_at)).map((r) => (
                <li key={r.id} className="py-2">
                  <span className="font-medium">{VO_RATE_PURPOSE_LABELS[r.purpose] ?? r.purpose}</span>
                  {" · "}{locationName(r.location_id)}{" · v"}{r.version}{" · "}
                  {formatCurrency(r.guide_fee)}{r.floor_fee !== null ? ` (floor ${formatCurrency(r.floor_fee)})` : ""}
                  {" · "}{formatDate(r.effective_from)}{r.effective_until ? ` to ${formatDate(r.effective_until)}` : " onward"}
                  {r.reason && <span className="text-muted-foreground">{" · "}{r.reason}</span>}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
