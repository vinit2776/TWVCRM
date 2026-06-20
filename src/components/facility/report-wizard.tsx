"use client";
/**
 * Mobile-first 3-step wizard for reporting a facility issue.
 *
 * Step 1 — Where?  Optional asset search (auto-fills location+scope) OR pick location manually
 * Step 2 — What?   Pick scope (7 buttons) → priority → title + description + photo
 * Step 3 — Who?    Reporter contact
 */

import { useEffect, useMemo, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  ChevronLeft, ChevronRight, Loader2, MapPin, AlertTriangle, Check,
  Search, X, Wifi, ThermometerSun, Droplets, Zap, Sparkles, ShieldAlert, HelpCircle,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { PRIORITY_LIST, PRIORITY_STYLES, REPORTED_VIA_LABEL, SCOPE_LABEL } from "@/lib/facility-ui";
import { FacilityPhotoUpload, type FacilityUploadedPhoto } from "@/components/facility/photo-upload";
import type {
  FacilityAsset, FacilityIssuePriority, FacilityReportedVia, FacilityScope,
} from "@/types";

interface Location { id: string; name: string; code: string }
interface Floor { id: string; name: string; floor_number?: number | null }
interface SpaceUnit { id: string; name: string; code: string; floor_id?: string | null }

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaults?: {
    location_id?: string;
    floor_id?: string;
    space_unit_id?: string;
    asset_id?: string;
    scope?: FacilityScope;
    priority?: FacilityIssuePriority;
  };
  onCreated?: (issue: { id: string; issue_number: string }) => void;
}

type Step = 1 | 2 | 3;

const VIAS: FacilityReportedVia[] = ["walk_in", "phone", "whatsapp", "email", "proactive"];

const SCOPE_ORDER: FacilityScope[] = ["it", "hvac", "electrical", "plumbing", "housekeeping", "security", "other", "facility"];

const SCOPE_ICONS: Record<FacilityScope, typeof Wifi> = {
  it: Wifi, hvac: ThermometerSun, plumbing: Droplets,
  electrical: Zap, housekeeping: Sparkles, security: ShieldAlert, other: HelpCircle, facility: HelpCircle,
};

export function FacilityReportWizard({ open, onOpenChange, defaults, onCreated }: Props) {
  const router = useRouter();

  const [step, setStep] = useState<Step>(1);
  const [submitting, setSubmitting] = useState(false);

  // data caches
  const [locations, setLocations] = useState<Location[]>([]);
  const [floors, setFloors] = useState<Floor[]>([]);
  const [spaceUnits, setSpaceUnits] = useState<SpaceUnit[]>([]);

  // form values
  const [locationId, setLocationId] = useState("");
  const [floorId, setFloorId] = useState("");
  const [spaceUnitId, setSpaceUnitId] = useState("");
  const [assetId, setAssetId] = useState("");
  const [selectedAsset, setSelectedAsset] = useState<FacilityAsset | null>(null);
  const [scope, setScope] = useState<FacilityScope>("it");
  const [priority, setPriority] = useState<FacilityIssuePriority>("medium");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [reportedVia, setReportedVia] = useState<FacilityReportedVia>("walk_in");
  const [reporterName, setReporterName] = useState("");
  const [reporterPhone, setReporterPhone] = useState("");
  const [reporterEmail, setReporterEmail] = useState("");
  const [photos, setPhotos] = useState<FacilityUploadedPhoto[]>([]);

  // asset search
  const [assetQuery, setAssetQuery] = useState("");
  const [assetResults, setAssetResults] = useState<FacilityAsset[]>([]);
  const [assetSearching, setAssetSearching] = useState(false);

  // prefilled = caller already knows location + scope (e.g. asset page)
  const prefilled = !!(defaults?.location_id && defaults?.scope);

  // initial load
  useEffect(() => {
    if (!open) return;
    setStep(prefilled ? 2 : 1);
    setPhotos([]);
    setTitle("");
    setDescription("");
    setReportedVia("walk_in");
    setReporterName("");
    setReporterPhone("");
    setReporterEmail("");
    setPriority(defaults?.priority || "medium");
    setLocationId(defaults?.location_id || "");
    setFloorId(defaults?.floor_id || "");
    setSpaceUnitId(defaults?.space_unit_id || "");
    setAssetId(defaults?.asset_id || "");
    setScope(defaults?.scope || "it");
    setSelectedAsset(null);
    setAssetQuery("");
    setAssetResults([]);

    fetch("/api/locations?is_active=true").then((r) => r.json()).then((j) => setLocations(j.data || []));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // load floors + units when location changes
  useEffect(() => {
    if (!locationId) { setFloors([]); setSpaceUnits([]); return; }
    (async () => {
      const [flRes, suRes] = await Promise.all([
        fetch(`/api/locations/${locationId}/floors`).then((r) => r.json()),
        fetch(`/api/locations/${locationId}/space-units?is_active=true`).then((r) => r.json()),
      ]);
      setFloors(flRes.data || []);
      setSpaceUnits(suRes.data || []);
    })();
  }, [locationId]);

  const filteredUnits = useMemo(
    () => floorId ? spaceUnits.filter((u) => u.floor_id === floorId) : spaceUnits,
    [spaceUnits, floorId],
  );

  // asset search debounce
  useEffect(() => {
    if (assetQuery.length < 2) { setAssetResults([]); return; }
    setAssetSearching(true);
    const t = setTimeout(async () => {
      const res = await fetch(`/api/facility/assets?search=${encodeURIComponent(assetQuery)}&status=active`);
      const json = await res.json();
      setAssetResults(json.data || []);
      setAssetSearching(false);
    }, 300);
    return () => clearTimeout(t);
  }, [assetQuery]);

  const selectAsset = useCallback((asset: FacilityAsset) => {
    setSelectedAsset(asset);
    setAssetId(asset.id);
    setLocationId(asset.location_id);
    setFloorId(asset.floor_id || "");
    setSpaceUnitId(asset.space_unit_id || "");
    if (asset.category?.scope) setScope(asset.category.scope as FacilityScope);
    setAssetQuery("");
    setAssetResults([]);
  }, []);

  const clearAsset = useCallback(() => {
    setSelectedAsset(null);
    setAssetId("");
    setLocationId("");
    setFloorId("");
    setSpaceUnitId("");
  }, []);

  // validation
  const canNext1 = !!locationId;
  const canNext2 = !!scope && title.trim().length >= 3;
  const canSubmit = canNext1 && canNext2;

  // submit
  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      const res = await fetch("/api/facility/issues", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          scope,
          location_id: locationId,
          floor_id: floorId || null,
          space_unit_id: spaceUnitId || null,
          asset_id: assetId || null,
          title: title.trim(),
          description: description.trim() || null,
          priority,
          reported_via: reportedVia,
          reporter_name: reporterName.trim() || null,
          reporter_email: reporterEmail.trim() || null,
          reporter_phone: reporterPhone.trim() || null,
          attachments: photos.map((p) => ({
            file_url: p.file_url, file_path: p.file_path,
            file_type: p.file_type, caption: p.caption ?? null,
          })),
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to create issue");

      toast.success(`Issue ${json.data.issue_number} created`);
      onOpenChange(false);
      onCreated?.({ id: json.data.id, issue_number: json.data.issue_number });
      router.push(`/facility/issues/${json.data.id}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to create issue");
    } finally {
      setSubmitting(false);
    }
  };

  // ── Step 1: Where ──────────────────────────────────────────────
  const Step1 = (
    <div className="space-y-4">
      {/* Asset quick-search */}
      <div>
        <Label className="text-sm font-medium">Know the asset?</Label>
        <p className="text-xs text-muted-foreground mb-2">Search by name or code to auto-fill location & scope. Skip if unsure.</p>
        {selectedAsset ? (
          <div className="flex items-center gap-2 p-3 rounded-lg border border-[#015E65] bg-[#015E65]/5">
            <Check className="h-4 w-4 text-[#015E65] shrink-0" />
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium truncate">{selectedAsset.name}</div>
              <div className="text-xs text-muted-foreground">
                <code className="font-mono">{selectedAsset.asset_code}</code>
                {selectedAsset.location && <> · {selectedAsset.location.name}</>}
              </div>
            </div>
            <button type="button" onClick={clearAsset} className="p-1 hover:bg-muted rounded">
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ) : (
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
            <Input
              value={assetQuery}
              onChange={(e) => setAssetQuery(e.target.value)}
              placeholder="Type asset name or code…"
              className="pl-9"
            />
            {assetSearching && <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 animate-spin text-muted-foreground" />}
            {assetResults.length > 0 && (
              <div className="absolute z-10 w-full mt-1 rounded-lg border bg-popover shadow-md max-h-48 overflow-y-auto">
                {assetResults.slice(0, 10).map((a) => (
                  <button
                    key={a.id}
                    type="button"
                    onClick={() => selectAsset(a)}
                    className="w-full text-left px-3 py-2 text-sm hover:bg-muted/60 border-b last:border-b-0"
                  >
                    <span className="font-medium">{a.name}</span>
                    <span className="text-xs text-muted-foreground ml-2">{a.asset_code}</span>
                    {a.location && <span className="text-xs text-muted-foreground ml-1">· {a.location.name}</span>}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Divider */}
      {!selectedAsset && (
        <>
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <div className="flex-1 h-px bg-border" />
            <span>or pick a location</span>
            <div className="flex-1 h-px bg-border" />
          </div>

          <div>
            <Label className="text-sm font-medium">Location</Label>
            <p className="text-xs text-muted-foreground mb-2">Where is the issue?</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {locations.map((l) => {
                const sel = locationId === l.id;
                return (
                  <button
                    key={l.id}
                    type="button"
                    onClick={() => { setLocationId(l.id); setFloorId(""); setSpaceUnitId(""); setAssetId(""); }}
                    className={cn(
                      "flex items-center gap-2 p-3 rounded-lg border text-left transition",
                      sel ? "border-[#015E65] bg-[#015E65]/5" : "border-border hover:bg-muted/40",
                    )}
                  >
                    <div className={cn("h-7 w-7 rounded flex items-center justify-center shrink-0",
                      sel ? "bg-[#015E65] text-white" : "bg-muted text-muted-foreground")}>
                      {sel ? <Check className="h-4 w-4" /> : <MapPin className="h-4 w-4" />}
                    </div>
                    <div className="min-w-0">
                      <div className="text-sm font-medium truncate">{l.name}</div>
                      <code className="text-xs text-muted-foreground">{l.code}</code>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {locationId && floors.length > 0 && (
            <div>
              <Label className="text-sm font-medium">Floor (optional)</Label>
              <div className="flex flex-wrap gap-2 mt-2">
                <button
                  type="button"
                  onClick={() => { setFloorId(""); setSpaceUnitId(""); }}
                  className={cn(
                    "px-3 py-1.5 text-xs rounded-full border",
                    !floorId ? "bg-[#015E65] text-white border-[#015E65]" : "bg-muted/40",
                  )}
                >Any</button>
                {floors.map((f) => (
                  <button
                    key={f.id}
                    type="button"
                    onClick={() => { setFloorId(f.id); setSpaceUnitId(""); }}
                    className={cn(
                      "px-3 py-1.5 text-xs rounded-full border",
                      floorId === f.id ? "bg-[#015E65] text-white border-[#015E65]" : "bg-muted/40",
                    )}
                  >{f.name}</button>
                ))}
              </div>
            </div>
          )}

          {locationId && filteredUnits.length > 0 && (
            <div>
              <Label className="text-sm font-medium">Space unit (optional)</Label>
              <div className="flex flex-wrap gap-2 mt-2 max-h-32 overflow-y-auto">
                <button
                  type="button"
                  onClick={() => setSpaceUnitId("")}
                  className={cn(
                    "px-3 py-1.5 text-xs rounded-full border",
                    !spaceUnitId ? "bg-[#015E65] text-white border-[#015E65]" : "bg-muted/40",
                  )}
                >Any</button>
                {filteredUnits.slice(0, 50).map((u) => (
                  <button
                    key={u.id}
                    type="button"
                    onClick={() => setSpaceUnitId(u.id)}
                    className={cn(
                      "px-3 py-1.5 text-xs rounded-full border",
                      spaceUnitId === u.id ? "bg-[#015E65] text-white border-[#015E65]" : "bg-muted/40",
                    )}
                  ><code className="font-mono">{u.code}</code> · {u.name}</button>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );

  // ── Step 2: What ───────────────────────────────────────────────
  const prefilledLocation = locations.find((l) => l.id === locationId);

  const Step2 = (
    <div className="space-y-4">
      {/* Context banner when asset was selected */}
      {selectedAsset && (
        <div className="rounded-lg border bg-muted/30 p-3 space-y-1 text-sm">
          <div className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium mb-1">Reporting for</div>
          <div className="font-medium">{selectedAsset.name} <code className="text-xs text-muted-foreground ml-1">{selectedAsset.asset_code}</code></div>
          <div className="text-xs text-muted-foreground">
            {prefilledLocation?.name}{selectedAsset.category?.scope && <> · {SCOPE_LABEL[selectedAsset.category.scope as FacilityScope]}</>}
          </div>
        </div>
      )}

      {/* Scope picker — skip if asset already set the scope */}
      {!selectedAsset && (
        <div>
          <Label className="text-sm font-medium">What kind of issue?</Label>
          <div className="grid grid-cols-2 gap-2 mt-2">
            {SCOPE_ORDER.map((s) => {
              const sel = scope === s;
              const Icon = SCOPE_ICONS[s];
              return (
                <button
                  key={s}
                  type="button"
                  onClick={() => setScope(s)}
                  className={cn(
                    "flex items-center gap-2.5 p-3 rounded-lg border text-left transition",
                    sel ? "border-[#015E65] bg-[#015E65]/5" : "border-border hover:bg-muted/40",
                  )}
                >
                  <div className={cn("h-8 w-8 rounded-lg flex items-center justify-center shrink-0",
                    sel ? "bg-[#015E65] text-white" : "bg-muted text-muted-foreground")}>
                    <Icon className="h-4 w-4" />
                  </div>
                  <span className={cn("text-sm", sel && "font-medium")}>{SCOPE_LABEL[s]}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      <div>
        <Label className="text-sm font-medium">Priority</Label>
        <div className="grid grid-cols-2 gap-2 mt-2">
          {PRIORITY_LIST.map((p) => {
            const sel = priority === p;
            const sty = PRIORITY_STYLES[p];
            return (
              <button
                key={p}
                type="button"
                onClick={() => setPriority(p)}
                className={cn(
                  "p-3 rounded-lg border text-left transition flex items-center gap-2",
                  sel ? "border-[#015E65] bg-[#015E65]/5" : "border-border hover:bg-muted/40",
                )}
              >
                <span className={cn("h-2.5 w-2.5 rounded-full", sty.dot)} />
                <span className="text-sm font-medium">{sty.label}</span>
                {p === "critical" && <AlertTriangle className="h-3.5 w-3.5 text-red-500 ml-auto" />}
              </button>
            );
          })}
        </div>
      </div>

      <div>
        <Label htmlFor="title" className="text-sm font-medium">Title</Label>
        <Input
          id="title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="e.g. WiFi dropping in conference room"
          className="mt-1"
          maxLength={200}
        />
      </div>

      <div>
        <Label htmlFor="description" className="text-sm font-medium">Details (optional)</Label>
        <Textarea
          id="description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="When did it start? Anything specific you noticed?"
          className="mt-1"
          rows={3}
        />
      </div>

      <div>
        <Label className="text-sm font-medium">Photo (optional)</Label>
        <div className="mt-1">
          <FacilityPhotoUpload
            pathPrefix="report"
            photos={photos}
            onUploaded={(p) => setPhotos((prev) => [...prev, p])}
            onRemove={(i) => setPhotos((prev) => prev.filter((_, idx) => idx !== i))}
            disabled={submitting}
          />
        </div>
      </div>
    </div>
  );

  // ── Step 3: Who ────────────────────────────────────────────────
  const Step3 = (
    <div className="space-y-4">
      <div>
        <Label className="text-sm font-medium">How was this reported?</Label>
        <div className="flex flex-wrap gap-2 mt-2">
          {VIAS.map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setReportedVia(v)}
              className={cn(
                "px-3 py-1.5 text-xs rounded-full border",
                reportedVia === v ? "bg-[#015E65] text-white border-[#015E65]" : "bg-muted/40",
              )}
            >{REPORTED_VIA_LABEL[v]}</button>
          ))}
        </div>
      </div>

      <div className="rounded-lg border bg-muted/30 p-3 space-y-3">
        <p className="text-xs text-muted-foreground">
          If you&apos;re reporting on someone else&apos;s behalf, add their contact so they get the resolution update. Skip if not applicable.
        </p>
        <div>
          <Label htmlFor="rname" className="text-xs">Reporter name</Label>
          <Input id="rname" value={reporterName} onChange={(e) => setReporterName(e.target.value)} className="mt-1" />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <Label htmlFor="rphone" className="text-xs">Phone</Label>
            <Input id="rphone" value={reporterPhone} onChange={(e) => setReporterPhone(e.target.value)} className="mt-1" inputMode="tel" />
          </div>
          <div>
            <Label htmlFor="remail" className="text-xs">Email</Label>
            <Input id="remail" type="email" value={reporterEmail} onChange={(e) => setReporterEmail(e.target.value)} className="mt-1" />
          </div>
        </div>
      </div>

      {/* Summary */}
      <div className="rounded-lg border p-3 space-y-1.5 text-sm">
        <div className="text-xs text-muted-foreground uppercase tracking-wide">Summary</div>
        <div><span className="text-muted-foreground">Location:</span> {prefilledLocation?.name ?? "—"}</div>
        {selectedAsset && <div><span className="text-muted-foreground">Asset:</span> {selectedAsset.asset_code} · {selectedAsset.name}</div>}
        <div><span className="text-muted-foreground">Scope:</span> {SCOPE_LABEL[scope]}</div>
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground">Priority:</span>
          <span className={cn("h-2 w-2 rounded-full", PRIORITY_STYLES[priority].dot)} />
          {PRIORITY_STYLES[priority].label}
        </div>
        <div><span className="text-muted-foreground">Title:</span> {title || "—"}</div>
        {photos.length > 0 && (
          <div><span className="text-muted-foreground">Photos:</span> {photos.length}</div>
        )}
      </div>
    </div>
  );

  const StepHeader = (n: Step, label: string) => (
    <div className="flex items-center gap-2">
      <span className={cn(
        "h-6 w-6 rounded-full text-xs font-bold flex items-center justify-center",
        step === n ? "bg-[#015E65] text-white" : step > n ? "bg-emerald-500 text-white" : "bg-muted text-muted-foreground",
      )}>
        {step > n ? <Check className="h-3.5 w-3.5" /> : n}
      </span>
      <span className={cn("text-xs", step === n ? "font-semibold" : "text-muted-foreground")}>{label}</span>
    </div>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg p-0 gap-0 max-h-[92vh] flex flex-col">
        <DialogHeader className="p-4 pb-3 border-b">
          <DialogTitle className="text-base">Report a facility issue</DialogTitle>
          <DialogDescription className="sr-only">3-step wizard to report a new issue</DialogDescription>
          <div className="flex items-center gap-3 pt-2">
            {!prefilled && <>{StepHeader(1, "Where")}<ChevronRight className="h-3 w-3 text-muted-foreground" /></>}
            {StepHeader(2, prefilled ? "Details" : "What")}
            <ChevronRight className="h-3 w-3 text-muted-foreground" />
            {StepHeader(3, prefilled ? "Submit" : "Who")}
          </div>
        </DialogHeader>

        <div className="overflow-y-auto p-4 flex-1">
          {step === 1 && Step1}
          {step === 2 && Step2}
          {step === 3 && Step3}
        </div>

        <div className="border-t p-3 flex items-center justify-between gap-2 bg-background">
          {step > 1 && !(prefilled && step === 2) ? (
            <Button variant="ghost" size="sm" onClick={() => setStep((s) => (s - 1) as Step)} disabled={submitting}>
              <ChevronLeft className="h-4 w-4 mr-1" /> Back
            </Button>
          ) : <div />}
          {step < 3 ? (
            <Button
              size="sm"
              disabled={(step === 1 && !canNext1) || (step === 2 && !canNext2)}
              onClick={() => setStep((s) => (s + 1) as Step)}
            >
              Next <ChevronRight className="h-4 w-4 ml-1" />
            </Button>
          ) : (
            <Button size="sm" onClick={submit} disabled={!canSubmit || submitting}>
              {submitting ? <><Loader2 className="h-4 w-4 mr-1 animate-spin" /> Submitting…</> : "Submit"}
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
