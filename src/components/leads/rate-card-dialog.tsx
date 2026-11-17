"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { WORKSPACE_TYPES, WORKSPACE_TYPE_LABELS } from "@/lib/constants";

interface Row { location_id: string | null; workspace_type: string; monthly_rate_per_seat: number }

/** Our standard monthly price per seat. Only used to estimate enquiries that gave no budget; those estimates are always marked "est.". */
export function RateCardDialog({
  open,
  onOpenChange,
  locations,
  locationId,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  locations: { id: string; name: string }[];
  /** Which location's rates to edit first; null = the default for every location. */
  locationId: string | null;
  onSaved: () => void;
}) {
  const [scope, setScope] = useState<string>(locationId ?? "*");
  const [saved, setSaved] = useState<Row[]>([]);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setScope(locationId ?? "*");
    fetch("/api/leads/rate-card")
      .then((r) => r.json())
      .then((j) => setSaved(j.data ?? []))
      .catch(() => toast.error("Could not load the rate card"));
  }, [open, locationId]);

  useEffect(() => {
    const next: Record<string, string> = {};
    for (const t of WORKSPACE_TYPES) {
      const row = saved.find((r) => (r.location_id ?? "*") === scope && r.workspace_type === t);
      next[t] = row ? String(row.monthly_rate_per_seat) : "";
    }
    setDraft(next);
  }, [saved, scope]);

  async function save() {
    const rates = WORKSPACE_TYPES.flatMap((t) => {
      const was = saved.find((r) => (r.location_id ?? "*") === scope && r.workspace_type === t);
      const raw = draft[t]?.trim() ?? "";
      const value = raw === "" ? null : Number(raw);
      if (value !== null && (!Number.isFinite(value) || value <= 0)) return [];
      if ((was?.monthly_rate_per_seat ?? null) === value) return [];
      return [{ location_id: scope === "*" ? null : scope, workspace_type: t, monthly_rate_per_seat: value }];
    });
    if (rates.length === 0) { onOpenChange(false); return; }
    setSaving(true);
    const res = await fetch("/api/leads/rate-card", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ rates }) });
    setSaving(false);
    if (!res.ok) { toast.error((await res.json().catch(() => ({}))).error || "Could not save"); return; }
    toast.success("Rate card saved");
    onSaved();
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Rate card</DialogTitle>
          <DialogDescription>Our standard monthly price per seat. Used only to estimate enquiries that gave no budget. A location&apos;s own rate wins over the default.</DialogDescription>
        </DialogHeader>
        <select value={scope} onChange={(e) => setScope(e.target.value)} className="h-9 w-full rounded-md border bg-background px-2 text-sm">
          <option value="*">All locations (default)</option>
          {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
        <div className="space-y-2">
          {WORKSPACE_TYPES.map((t) => (
            <label key={t} className="flex items-center gap-3 text-sm">
              <span className="w-40">{WORKSPACE_TYPE_LABELS[t] ?? t}</span>
              <Input type="number" min={0} inputMode="numeric" placeholder="not set" value={draft[t] ?? ""} onChange={(e) => setDraft((d) => ({ ...d, [t]: e.target.value }))} />
            </label>
          ))}
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={save} disabled={saving}>{saving ? "Saving…" : "Save"}</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
