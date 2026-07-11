"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { Plus, Minus, Loader2, Coffee, Camera, X } from "lucide-react";
import { BEVERAGE_TYPES, BEVERAGE_TYPE_LABELS } from "@/lib/constants";
import { prepareUpload, UploadTooLargeError } from "@/lib/uploads/upload-gate";
import { cn } from "@/lib/utils";

const MAX_QTY = 50;

interface LocationOption {
  id: string;
  name: string;
}

interface BeverageLogFormProps {
  lang: string;
  locationsLoading: boolean;
  availableLocations: LocationOption[];
  selectedLocationId: string;
  onSelectLocation: (id: string) => void;
}

export function BeverageLogForm({
  lang,
  locationsLoading,
  availableLocations,
  selectedLocationId,
  onSelectLocation,
}: BeverageLogFormProps) {
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [todayTally, setTodayTally] = useState<Record<string, number>>({});
  const [tallyLoading, setTallyLoading] = useState(false);
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [photoPreviewUrl, setPhotoPreviewUrl] = useState<string | null>(null);
  const [photoProcessing, setPhotoProcessing] = useState(false);
  const photoInputRef = useRef<HTMLInputElement>(null);

  const totalDrinks = useMemo(
    () => Object.values(counts).reduce((s, n) => s + n, 0),
    [counts]
  );

  const tallyRequestId = useRef(0);
  const fetchTodayTally = useCallback(async () => {
    if (!selectedLocationId) return;
    const requestId = ++tallyRequestId.current;
    setTallyLoading(true);
    try {
      const today = new Date().toISOString().slice(0, 10);
      const res = await fetch(
        `/api/procurement/beverage-logs?location_id=${selectedLocationId}&from_date=${today}&to_date=${today}&limit=50`
      );
      const data = await res.json();
      // Ignore if a newer location switch has since fired another request.
      if (requestId !== tallyRequestId.current) return;
      const tally: Record<string, number> = {};
      for (const log of data.data ?? []) {
        for (const item of log.beverage_log_items ?? []) {
          tally[item.drink_type] = (tally[item.drink_type] ?? 0) + Number(item.quantity);
        }
      }
      setTodayTally(tally);
    } catch {
      // Tally is a nice-to-have, not the critical path — fail silently.
    } finally {
      if (requestId === tallyRequestId.current) setTallyLoading(false);
    }
  }, [selectedLocationId]);

  useEffect(() => {
    fetchTodayTally();
  }, [fetchTodayTally]);

  const setCount = (drink: string, qty: number) => {
    const clamped = Math.max(0, Math.min(qty, MAX_QTY));
    setCounts((prev) => ({ ...prev, [drink]: clamped }));
  };

  const clearPhoto = () => {
    if (photoPreviewUrl) URL.revokeObjectURL(photoPreviewUrl);
    setPhotoFile(null);
    setPhotoPreviewUrl(null);
    if (photoInputRef.current) photoInputRef.current.value = "";
  };

  const handlePhotoSelect = async (files: FileList | null) => {
    const raw = files?.[0];
    if (!raw) return;
    setPhotoProcessing(true);
    try {
      const prepared = await prepareUpload(raw);
      if (!prepared) return; // user declined the large-file confirm
      if (photoPreviewUrl) URL.revokeObjectURL(photoPreviewUrl);
      setPhotoFile(prepared);
      setPhotoPreviewUrl(URL.createObjectURL(prepared));
    } catch (e) {
      if (e instanceof UploadTooLargeError) toast.error(e.message);
      else toast.error(e instanceof Error ? e.message : "Could not process photo");
    } finally {
      setPhotoProcessing(false);
      if (photoInputRef.current) photoInputRef.current.value = "";
    }
  };

  const handleSubmit = async () => {
    const items = BEVERAGE_TYPES.filter((d) => (counts[d] ?? 0) > 0).map((d) => ({
      drink_type: d,
      quantity: counts[d],
    }));
    if (items.length === 0 || !selectedLocationId) return;

    setSubmitting(true);
    try {
      const res = await fetch("/api/procurement/beverage-logs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          location_id: selectedLocationId,
          notes: notes || undefined,
          items,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to log drinks");

      const totalLogged = items.reduce((s, i) => s + i.quantity, 0);
      const logId = data.data?.id as string | undefined;

      if (photoFile && logId) {
        try {
          const photoForm = new FormData();
          photoForm.append("photo", photoFile);
          const photoRes = await fetch(`/api/procurement/beverage-logs/${logId}/photo`, {
            method: "POST",
            body: photoForm,
          });
          if (!photoRes.ok) {
            const photoErr = await photoRes.json().catch(() => ({}));
            throw new Error(photoErr.error || "Photo upload failed");
          }
        } catch {
          toast.warning(
            lang === "en"
              ? `Logged ${totalLogged} drink${totalLogged === 1 ? "" : "s"}, but the photo failed to upload`
              : `பானங்கள் பதிவு செய்யப்பட்டன, ஆனால் புகைப்படம் பதிவேற்றத் தவறியது`
          );
          setCounts({});
          setNotes("");
          clearPhoto();
          fetchTodayTally();
          return;
        }
      }

      toast.success(
        lang === "en"
          ? `Logged ${totalLogged} drink${totalLogged === 1 ? "" : "s"}`
          : `${totalLogged} பானங்கள் பதிவு செய்யப்பட்டன`
      );
      setCounts({});
      setNotes("");
      clearPhoto();
      fetchTodayTally();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Error submitting");
    } finally {
      setSubmitting(false);
    }
  };

  const selectedLocation = availableLocations.find((l) => l.id === selectedLocationId);
  const tallyEntries = BEVERAGE_TYPES.filter((d) => todayTally[d]);

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="p-6 space-y-2">
          <Label>{lang === "en" ? "Select Location" : "இடத்தைத் தேர்ந்தெடுக்கவும்"}</Label>
          <Select value={selectedLocationId} onValueChange={onSelectLocation} disabled={locationsLoading}>
            <SelectTrigger className="h-11">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {availableLocations.map((loc) => (
                <SelectItem key={loc.id} value={loc.id}>
                  {loc.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </CardContent>
      </Card>

      {selectedLocationId && (
        <p className="text-xs text-muted-foreground px-1">
          {lang === "en" ? "Logged today at" : "இன்று பதிவு"} {selectedLocation?.name}:{" "}
          {tallyLoading
            ? "…"
            : tallyEntries.length === 0
            ? (lang === "en" ? "none yet" : "இல்லை")
            : tallyEntries.map((d) => `${BEVERAGE_TYPE_LABELS[d]} ×${todayTally[d]}`).join(", ")}
        </p>
      )}

      <div className="border rounded-lg overflow-hidden">
        {BEVERAGE_TYPES.map((drink, idx) => {
          const qty = counts[drink] ?? 0;
          return (
            <div
              key={drink}
              className={cn("flex items-center gap-3 px-4 py-3", idx > 0 && "border-t")}
            >
              <div className="flex-1 min-w-0 flex items-center gap-2">
                <Coffee className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                <span className="font-medium text-sm">{BEVERAGE_TYPE_LABELS[drink]}</span>
              </div>

              <div className="flex items-center gap-1 flex-shrink-0">
                <button
                  onClick={() => setCount(drink, qty - 1)}
                  disabled={qty === 0}
                  className={cn(
                    "w-11 h-11 rounded-md border flex items-center justify-center transition-colors",
                    "hover:bg-muted disabled:opacity-40 disabled:cursor-not-allowed"
                  )}
                  aria-label={`Decrease ${BEVERAGE_TYPE_LABELS[drink]}`}
                >
                  <Minus className="h-4 w-4" />
                </button>
                <Input
                  type="number"
                  min={0}
                  max={MAX_QTY}
                  value={qty || ""}
                  onChange={(e) => setCount(drink, Number(e.target.value))}
                  className="w-16 h-11 text-center [appearance:textfield]"
                  placeholder="0"
                />
                <button
                  onClick={() => setCount(drink, qty + 1)}
                  disabled={qty >= MAX_QTY}
                  className={cn(
                    "w-11 h-11 rounded-md border flex items-center justify-center transition-colors",
                    "hover:bg-muted disabled:opacity-40 disabled:cursor-not-allowed"
                  )}
                  aria-label={`Increase ${BEVERAGE_TYPE_LABELS[drink]}`}
                >
                  <Plus className="h-4 w-4" />
                </button>
              </div>
            </div>
          );
        })}
      </div>

      <div className="space-y-2">
        <Label>
          {lang === "en" ? "Verification photo (optional)" : "சரிபார்ப்பு புகைப்படம் (விருப்பம்)"}
        </Label>
        <input
          ref={photoInputRef}
          type="file"
          accept="image/*"
          capture="environment"
          className="hidden"
          onChange={(e) => handlePhotoSelect(e.target.files)}
        />
        {photoPreviewUrl ? (
          <div className="relative h-24 w-24 rounded-md overflow-hidden border bg-muted">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={photoPreviewUrl} alt="Vending machine counter" className="h-full w-full object-cover" />
            <button
              type="button"
              onClick={clearPhoto}
              className="absolute top-0.5 right-0.5 h-5 w-5 rounded-full bg-black/60 text-white flex items-center justify-center"
              aria-label="Remove photo"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        ) : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={photoProcessing}
            onClick={() => photoInputRef.current?.click()}
            className="gap-2"
          >
            {photoProcessing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Camera className="h-4 w-4" />}
            {lang === "en" ? "Photograph machine counter" : "இயந்திர எண்ணிக்கையை படமெடு"}
          </Button>
        )}
      </div>

      <div className="space-y-2">
        <Label>{lang === "en" ? "Notes (optional)" : "குறிப்புகள் (விருப்பம்)"}</Label>
        <Textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder={lang === "en" ? "Any notes for this batch..." : "குறிப்புகள்..."}
          rows={2}
        />
      </div>

      <div className="flex justify-end">
        <Button
          onClick={handleSubmit}
          disabled={submitting || photoProcessing || totalDrinks === 0 || !selectedLocationId}
          className="gap-2 min-w-[160px]"
        >
          {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
          {lang === "en"
            ? `Log Drinks${totalDrinks > 0 ? ` (${totalDrinks})` : ""}`
            : "பானங்களை பதிவு செய்"}
        </Button>
      </div>
    </div>
  );
}
