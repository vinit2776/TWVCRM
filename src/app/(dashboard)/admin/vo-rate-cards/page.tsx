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
import { PageBreadcrumb } from "@/components/page-breadcrumb";
import { VO_RATE_PURPOSES, VO_RATE_PURPOSE_COLORS, VO_RATE_PURPOSE_LABELS, VO_RATE_TERM_OPTIONS } from "@/lib/constants";
import { formatCurrency, formatDate } from "@/lib/utils";

interface RateRow {
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
}

interface Location {
  id: string;
  name: string;
}

const ANY = "any";

export default function VoRateCardsPage() {
  const [rows, setRows] = useState<RateRow[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [role, setRole] = useState<string | null>(null);
  const [setup, setSetup] = useState(true);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const [purpose, setPurpose] = useState<string>(VO_RATE_PURPOSES[0]);
  const [locationId, setLocationId] = useState<string>(ANY);
  const [guide, setGuide] = useState("");
  const [floor, setFloor] = useState("");
  const [term, setTerm] = useState("12");
  const [reason, setReason] = useState("");

  const canEdit = role === "admin" || role === "manager";
  const locName = useCallback(
    (id: string | null) => (id ? locations.find((l) => l.id === id)?.name ?? "Unknown" : "Any location"),
    [locations],
  );

  const load = useCallback(async () => {
    try {
      const [rRes, lRes, me] = await Promise.all([
        fetch("/api/admin/vo-rates?history=1", { cache: "no-store" }),
        fetch("/api/locations").then((r) => r.json()).catch(() => ({ data: [] })),
        fetch("/api/me").then((r) => r.json()).catch(() => null),
      ]);
      if (!rRes.ok) throw new Error(rRes.status === 403 ? "You do not have access to rate cards" : "Could not load rate cards");
      const body = (await rRes.json()) as { data: RateRow[]; setup?: boolean };
      setRows(body.data ?? []);
      setSetup(body.setup !== false);
      setLocations(((lRes.data ?? lRes.locations ?? []) as Location[]).slice().sort((a, b) => a.name.localeCompare(b.name)));
      setRole(me?.role ?? null);
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
  const history = useMemo(() => rows.filter((r) => !r.is_current), [rows]);

  const edit = (r: RateRow) => {
    setPurpose(r.purpose);
    setLocationId(r.location_id ?? ANY);
    setGuide(String(r.guide_fee));
    setFloor(r.floor_fee === null ? "" : String(r.floor_fee));
    setTerm(String(r.default_term_months));
    setReason("");
  };

  const save = async () => {
    setSaving(true);
    try {
      const res = await fetch("/api/admin/vo-rates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          purpose,
          location_id: locationId === ANY ? null : locationId,
          guide_fee: Number(guide),
          floor_fee: floor.trim() === "" ? null : Number(floor),
          default_term_months: Number(term),
          reason: reason.trim() || undefined,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? "Could not save the rate");
      }
      toast.success("Rate saved as a new version");
      setReason("");
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save the rate");
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <Loader2 className="h-5 w-5 animate-spin" />;

  return (
    <div className="space-y-6">
      <PageBreadcrumb resetTo={{ label: "VO rate cards" }} />
      <div>
        <h1 className="text-2xl font-semibold">Virtual Office rate cards</h1>
        <p className="text-sm text-muted-foreground">
          Guide and floor prices for direct customers. Up to 12 months the rate is the fee for the term; for 24, 36 and 48 months it is the annual rate. An edit saves a new version and keeps the old one in the history.
        </p>
      </div>

      {!setup && (
        <Card><CardContent className="pt-6 text-sm">Rate cards are not set up yet. The database migration has not been applied.</CardContent></Card>
      )}

      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">Current rates</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          {current.length === 0 && <p className="text-sm text-muted-foreground">No rates yet.</p>}
          {current.map((r) => (
            <div key={r.id} className="flex flex-wrap items-center gap-3 border-b py-2 text-sm last:border-0">
              <Badge className={VO_RATE_PURPOSE_COLORS[r.purpose]}>{VO_RATE_PURPOSE_LABELS[r.purpose] ?? r.purpose}</Badge>
              <span className="w-40">{locName(r.location_id)}</span>
              <span>Guide {formatCurrency(r.guide_fee)}</span>
              <span>Floor {r.floor_fee === null ? "none" : formatCurrency(r.floor_fee)}</span>
              <span>{r.default_term_months} months</span>
              <span className="text-muted-foreground">v{r.version}, from {formatDate(r.effective_from)}</span>
              {canEdit && <Button size="sm" variant="outline" className="ml-auto" onClick={() => edit(r)}>Edit</Button>}
            </div>
          ))}
        </CardContent>
      </Card>

      {canEdit && setup && (
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base">Add or change a rate</CardTitle></CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1">
              <Label>Purpose</Label>
              <Select value={purpose} onValueChange={setPurpose}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {VO_RATE_PURPOSES.map((p) => <SelectItem key={p} value={p}>{VO_RATE_PURPOSE_LABELS[p]}</SelectItem>)}
                </SelectContent>
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
              <Label>Default term</Label>
              <Select value={term} onValueChange={setTerm}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {VO_RATE_TERM_OPTIONS.map((t) => <SelectItem key={t} value={String(t)}>{t} months</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1"><Label>Guide fee</Label><Input type="number" min={0} value={guide} onChange={(e) => setGuide(e.target.value)} /></div>
            <div className="space-y-1"><Label>Floor fee (optional)</Label><Input type="number" min={0} value={floor} onChange={(e) => setFloor(e.target.value)} /></div>
            <div className="space-y-1"><Label>Reason (required when changing)</Label><Input value={reason} onChange={(e) => setReason(e.target.value)} /></div>
            <div className="sm:col-span-3">
              <Button onClick={save} disabled={saving || guide.trim() === ""}>{saving ? "Saving..." : "Save new version"}</Button>
            </div>
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
              <span>{locName(r.location_id)}</span>
              <span>v{r.version}: {formatCurrency(r.guide_fee)} / {r.floor_fee === null ? "no floor" : formatCurrency(r.floor_fee)}</span>
              <span className="text-muted-foreground">{formatDate(r.effective_from)} to {r.effective_until ? formatDate(r.effective_until) : "now"}</span>
              {r.reason && <span className="text-muted-foreground">{r.reason}</span>}
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
