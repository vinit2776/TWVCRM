"use client";

/**
 * Mobile-first 3-step wizard for reporting a facility issue.
 *
 * Step 1 — Where?  Pick location → (optional) floor → (optional) space unit / asset
 * Step 2 — What?   Pick category → priority → title + description + photo
 * Step 3 — Who?    Reporter contact (auto-filled when logged-in user is reporting on their own behalf)
 *
 * Designed to work on a phone in one thumb. Dialog content scrolls vertically;
 * sticky footer holds Back/Next/Submit. Each step is its own render fn so
 * focus management and validation are isolated.
 */

import { useEffect, useMemo, useState } from "react";
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
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { PRIORITY_LIST, PRIORITY_STYLES, REPORTED_VIA_LABEL } from "@/lib/facility-ui";
import { FacilityPhotoUpload, type FacilityUploadedPhoto } from "@/components/facility/photo-upload";
import type {
  FacilityAsset, FacilityAssetCategory, FacilityIssuePriority, FacilityReportedVia,
} from "@/types";

interface Location { id: string; name: string; code: string }
interface Floor { id: string; name: string; floor_number?: number | null }
interface SpaceUnit { id: string; name: string; code: string; floor_id?: string | null }

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Pre-fill location/asset/etc if invoked from a context that knows it. */
  defaults?: {
    location_id?: string;
    floor_id?: string;
    space_unit_id?: string;
    asset_id?: string;
    category_id?: string;
    priority?: FacilityIssuePriority;
  };
  /** Called after successful create. Receives the new issue id + number. */
  onCreated?: (issue: { id: string; issue_number: string }) => void;
}

type Step = 1 | 2 | 3;

const VIAS: FacilityReportedVia[] = ["walk_in", "phone", "whatsapp", "email", "proactive"];

export function FacilityReportWizard({ open, onOpenChange, defaults, onCreated }: Props) {
  const router = useRouter();

  // ---- step state ----------------------------------------------------------
  const [step, setStep] = useState<Step>(1);
  const [submitting, setSubmitting] = useState(false);

  // ---- data caches ---------------------------------------------------------
  const [locations, setLocations] = useState<Location[]>([]);
  const [floors, setFloors] = useState<Floor[]>([]);
  const [spaceUnits, setSpaceUnits] = useState<SpaceUnit[]>([]);
  const [assets, setAssets] = useState<FacilityAsset[]>([]);
  const [categories, setCategories] = useState<FacilityAssetCategory[]>([]);

  // ---- form values ---------------------------------------------------------
  const [locationId, setLocationId] = useState("");
  const [floorId, setFloorId] = useState<string>("");
  const [spaceUnitId, setSpaceUnitId] = useState<string>("");
  const [assetId, setAssetId] = useState<string>("");
  const [categoryId, setCategoryId] = useState<string>("");
  const [priority, setPriority] = useState<FacilityIssuePriority>("medium");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [reportedVia, setReportedVia] = useState<FacilityReportedVia>("walk_in");
  const [reporterName, setReporterName] = useState("");
  const [reporterPhone, setReporterPhone] = useState("");
  const [reporterEmail, setReporterEmail] = useState("");
  const [photos, setPhotos] = useState<FacilityUploadedPhoto[]>([]);

  // ---- initial load (open) -------------------------------------------------
  useEffect(() => {
    if (!open) return;
    setStep(1);
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
    setCategoryId(defaults?.category_id || "");

    (async () => {
      const [locRes, catRes] = await Promise.all([
        fetch("/api/locations?is_active=true").then((r) => r.json()),
        fetch("/api/facility/categories?scope=it").then((r) => r.json()),
      ]);
      setLocations(locRes.data || []);
      setCategories(catRes.data || []);
    })();
  }, [open, defaults]);

  // ---- when location changes, load floors + assets ------------------------
  useEffect(() => {
    if (!locationId) { setFloors([]); setSpaceUnits([]); setAssets([]); return; }
    (async () => {
      const [flRes, suRes, asRes] = await Promise.all([
        fetch(`/api/locations/${locationId}/floors`).then((r) => r.json()),
        fetch(`/api/locations/${locationId}/space-units?is_active=true`).then((r) => r.json()),
        fetch(`/api/facility/assets?location_id=${locationId}&status=active`).then((r) => r.json()),
      ]);
      setFloors(flRes.data || []);
      setSpaceUnits(suRes.data || []);
      setAssets(asRes.data || []);
    })();
  }, [locationId]);

  const filteredUnits = useMemo(
    () => floorId ? spaceUnits.filter((u) => u.floor_id === floorId) : spaceUnits,
    [spaceUnits, floorId],
  );
  const filteredAssets = useMemo(() => {
    let arr = assets;
    if (floorId)     arr = arr.filter((a) => a.floor_id === floorId || !a.floor_id);
    if (spaceUnitId) arr = arr.filter((a) => a.space_unit_id === spaceUnitId || !a.space_unit_id);
    return arr;
  }, [assets, floorId, spaceUnitId]);

  // ---- validation ----------------------------------------------------------
  const canNext1 = !!locationId;
  const canNext2 = !!categoryId && title.trim().length >= 3;
  const canSubmit = canNext1 && canNext2;

  // ---- submit --------------------------------------------------------------
  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      const res = await fetch("/api/facility/issues", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          scope: "it",
          location_id: locationId,
          floor_id: floorId || null,
          space_unit_id: spaceUnitId || null,
          asset_id: assetId || null,
          category_id: categoryId,
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

  // ---- step renderers ------------------------------------------------------
  const Step1 = (
    <div className="space-y-4">
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

      {locationId && filteredAssets.length > 0 && (
        <div>
          <Label className="text-sm font-medium">Specific equipment (optional)</Label>
          <p className="text-xs text-muted-foreground mb-2">Pick the affected device for sharper analytics.</p>
          <select
            value={assetId}
            onChange={(e) => setAssetId(e.target.value)}
            className="w-full h-10 px-3 rounded-md border bg-background text-sm"
          >
            <option value="">— None / unsure —</option>
            {filteredAssets.map((a) => (
              <option key={a.id} value={a.id}>
                [{a.asset_code}] {a.name}{a.category?.name ? ` · ${a.category.name}` : ""}
              </option>
            ))}
          </select>
        </div>
      )}
    </div>
  );

  const Step2 = (
    <div className="space-y-4">
      <div>
        <Label className="text-sm font-medium">What kind of issue?</Label>
        <div className="grid grid-cols-2 gap-2 mt-2">
          {categories.map((c) => {
            const sel = categoryId === c.id;
            return (
              <button
                key={c.id}
                type="button"
                onClick={() => setCategoryId(c.id)}
                className={cn(
                  "p-3 rounded-lg border text-left text-sm transition",
                  sel ? "border-[#015E65] bg-[#015E65]/5" : "border-border hover:bg-muted/40",
                )}
              >
                <div className="font-medium truncate">{c.name}</div>
                {c.description && (
                  <div className="text-xs text-muted-foreground truncate mt-0.5">{c.description}</div>
                )}
              </button>
            );
          })}
        </div>
      </div>

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

      {/* Submission summary */}
      <div className="rounded-lg border p-3 space-y-1.5 text-sm">
        <div className="text-xs text-muted-foreground uppercase tracking-wide">Summary</div>
        <div><span className="text-muted-foreground">Location:</span> {locations.find((l) => l.id === locationId)?.name ?? "—"}</div>
        <div><span className="text-muted-foreground">Category:</span> {categories.find((c) => c.id === categoryId)?.name ?? "—"}</div>
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
            {StepHeader(1, "Where")}
            <ChevronRight className="h-3 w-3 text-muted-foreground" />
            {StepHeader(2, "What")}
            <ChevronRight className="h-3 w-3 text-muted-foreground" />
            {StepHeader(3, "Who")}
          </div>
        </DialogHeader>

        <div className="overflow-y-auto p-4 flex-1">
          {step === 1 && Step1}
          {step === 2 && Step2}
          {step === 3 && Step3}
        </div>

        <div className="border-t p-3 flex items-center justify-between gap-2 bg-background">
          {step > 1 ? (
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
