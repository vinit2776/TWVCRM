"use client";

/**
 * Facility Quotas section on the contracts quota sheet.
 *
 * Manages contract_facilities rows — conference rooms and other facility types
 * that provide N free hours/month to a member.  Unlike service_catalog (print),
 * facilities are contract-specific rows with a free name+unit chosen at setup.
 *
 * UX:
 *  - Lists all active contract_facilities rows.
 *  - Each row: name, unit, free quota/month, overage rate — inline editable.
 *  - "Add facility" inline form at the bottom.
 *  - Remove button soft-deletes (is_active=false).
 *  - Changing free_quota triggers server-side recalc of this month's pending charges.
 */

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Pencil, Trash2, Loader2, Check, X, Plus, BookOpen } from "lucide-react";
import { toast } from "sonner";
import { formatCurrency } from "@/lib/utils";

interface CatalogItem {
  id: string;
  name: string;
  unit: string;
  price_per_unit: number; // from location_services
}

interface Facility {
  id: string;
  name: string;
  unit: string;
  free_quota: number;
  cost_per_unit: number;
}

interface RowState extends Facility {
  editing: boolean;
  draftQty: string;
  draftRate: string;
  saving: boolean;
}

interface Props {
  contractId: string;
  /** Location ID of the contract — used to load catalogue suggestions. */
  locationId?: string | null;
  readOnly?: boolean;
  onSave?: () => void;
}

const BLANK_NEW = { name: "", unit: "hr", freeQty: "0", rate: "0" };

export function ContractFacilitiesSection({ contractId, locationId, readOnly = false, onSave }: Props) {
  const [rows, setRows] = useState<RowState[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [newForm, setNewForm] = useState(BLANK_NEW);
  const [newSaving, setNewSaving] = useState(false);
  const [catalog, setCatalog] = useState<CatalogItem[]>([]);

  const reload = async () => {
    setLoading(true);
    const res = await fetch(`/api/contracts/${contractId}/facilities`);
    const json = await res.json();
    const data = (json.data || []) as Facility[];
    setRows(data.map((f) => ({
      ...f,
      editing: false,
      draftQty: String(f.free_quota),
      draftRate: String(f.cost_per_unit),
      saving: false,
    })));
    setLoading(false);
  };

  useEffect(() => { reload(); /* eslint-disable-next-line */ }, [contractId]);

  // Load location_services as catalogue when locationId is available
  useEffect(() => {
    if (!locationId) { setCatalog([]); return; }
    fetch(`/api/location-services?location_id=${locationId}&is_active=true`)
      .then((r) => r.json())
      .then((j) => setCatalog(j.data || []));
  }, [locationId]);

  const startEdit = (idx: number) => {
    setRows((prev) => prev.map((r, i) => i === idx ? {
      ...r, editing: true,
      draftQty: String(r.free_quota),
      draftRate: String(r.cost_per_unit),
    } : r));
  };

  const cancelEdit = (idx: number) => {
    setRows((prev) => prev.map((r, i) => i === idx ? { ...r, editing: false } : r));
  };

  const save = async (idx: number) => {
    const row = rows[idx];
    const qty = Number(row.draftQty);
    const rate = Number(row.draftRate);
    if (!isFinite(qty) || qty < 0) { toast.error("Quota must be a non-negative number"); return; }
    if (!isFinite(rate) || rate < 0) { toast.error("Rate must be a non-negative number"); return; }

    setRows((prev) => prev.map((r, i) => i === idx ? { ...r, saving: true } : r));
    try {
      const res = await fetch(`/api/contracts/${contractId}/facilities`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ facility_id: row.id, free_quota: qty, cost_per_unit: rate }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Save failed");
      toast.success(`${row.name} quota updated`);
      await reload();
      onSave?.();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Save failed");
      setRows((prev) => prev.map((r, i) => i === idx ? { ...r, saving: false } : r));
    }
  };

  const remove = async (idx: number) => {
    const row = rows[idx];
    if (!confirm(`Remove ${row.name} facility quota? Existing charges for the current month will not change.`)) return;

    setRows((prev) => prev.map((r, i) => i === idx ? { ...r, saving: true } : r));
    try {
      const res = await fetch(`/api/contracts/${contractId}/facilities?facility_id=${row.id}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const json = await res.json().catch(() => null);
        throw new Error(json?.error || "Failed to remove");
      }
      toast.success(`${row.name} removed`);
      await reload();
      onSave?.();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed");
      setRows((prev) => prev.map((r, i) => i === idx ? { ...r, saving: false } : r));
    }
  };

  const addNew = async () => {
    const qty = Number(newForm.freeQty);
    const rate = Number(newForm.rate);
    if (!newForm.name.trim()) { toast.error("Name is required"); return; }
    if (!newForm.unit.trim()) { toast.error("Unit is required"); return; }
    if (!isFinite(qty) || qty < 0) { toast.error("Quota must be a non-negative number"); return; }
    if (!isFinite(rate) || rate < 0) { toast.error("Rate must be a non-negative number"); return; }

    setNewSaving(true);
    try {
      const res = await fetch(`/api/contracts/${contractId}/facilities`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: newForm.name.trim(),
          unit: newForm.unit.trim(),
          free_quota: qty,
          cost_per_unit: rate,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Add failed");
      toast.success(`${newForm.name} added`);
      setNewForm(BLANK_NEW);
      setAdding(false);
      await reload();
      onSave?.();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Add failed");
    } finally {
      setNewSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center justify-between">
          <span>Facility Quotas</span>
          <span className="text-xs font-normal text-muted-foreground">
            Free hours/month for conference rooms etc.
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (
          <div className="space-y-2">
            {rows.length === 0 && !adding && (
              <p className="text-sm text-muted-foreground italic">No facility quotas configured.</p>
            )}

            {rows.map((r, i) => (
              <div key={r.id} className="border rounded-lg p-3 flex items-center gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-sm">{r.name}</span>
                    <Badge variant="outline" className="text-[10px]">{r.unit}</Badge>
                  </div>
                  {!r.editing && (
                    <div className="text-xs text-muted-foreground mt-0.5">
                      <span className="font-medium text-foreground">{Number(r.free_quota)}</span> {r.unit} free; then {formatCurrency(Number(r.cost_per_unit))}/{r.unit}
                    </div>
                  )}
                  {r.editing && (
                    <div className="grid grid-cols-2 gap-2 mt-2 max-w-md">
                      <div>
                        <Label className="text-[10px]">Free quota / month</Label>
                        <Input
                          type="number" min="0" step="0.5"
                          value={r.draftQty}
                          onChange={(e) => setRows((prev) => prev.map((row, idx) => idx === i ? { ...row, draftQty: e.target.value } : row))}
                          className="mt-1 h-8"
                          disabled={r.saving}
                        />
                      </div>
                      <div>
                        <Label className="text-[10px]">Overage rate (/{r.unit})</Label>
                        <Input
                          type="number" min="0" step="0.01"
                          value={r.draftRate}
                          onChange={(e) => setRows((prev) => prev.map((row, idx) => idx === i ? { ...row, draftRate: e.target.value } : row))}
                          className="mt-1 h-8"
                          disabled={r.saving}
                        />
                      </div>
                    </div>
                  )}
                </div>

                {!readOnly && (
                  <div className="flex items-center gap-1 shrink-0">
                    {r.editing ? (
                      <>
                        <Button size="sm" onClick={() => save(i)} disabled={r.saving} className="h-7">
                          {r.saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => cancelEdit(i)} disabled={r.saving} className="h-7">
                          <X className="h-3 w-3" />
                        </Button>
                      </>
                    ) : (
                      <>
                        <Button size="sm" variant="ghost" onClick={() => startEdit(i)} className="h-7">
                          <Pencil className="h-3 w-3 mr-1" />Edit
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => remove(i)} disabled={r.saving} className="h-7">
                          <Trash2 className="h-3 w-3" />
                        </Button>
                      </>
                    )}
                  </div>
                )}
              </div>
            ))}

            {/* Add new facility inline form */}
            {adding && (
              <div className="border rounded-lg p-3 space-y-2 bg-muted/30">
                {/* Catalogue quick-picks — only shown when catalogue items exist */}
                {catalog.length > 0 && (
                  <div>
                    <p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-1 flex items-center gap-1">
                      <BookOpen className="h-3 w-3" />From catalogue
                    </p>
                    <div className="flex flex-wrap gap-1">
                      {catalog
                        .filter((c) => !rows.some((r) => r.name.toLowerCase() === c.name.toLowerCase()))
                        .map((c) => (
                          <button
                            key={c.id}
                            type="button"
                            onClick={() => setNewForm({ name: c.name, unit: c.unit, freeQty: "0", rate: String(c.price_per_unit) })}
                            className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border border-dashed border-primary/40 bg-primary/5 text-primary hover:bg-primary/10 transition-colors"
                          >
                            {c.name}
                          </button>
                        ))}
                    </div>
                    <div className="border-t my-2" />
                  </div>
                )}
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <Label className="text-[10px]">Facility name</Label>
                    <Input
                      placeholder="e.g. Conference Room"
                      value={newForm.name}
                      onChange={(e) => setNewForm((f) => ({ ...f, name: e.target.value }))}
                      className="mt-1 h-8"
                      disabled={newSaving}
                    />
                  </div>
                  <div>
                    <Label className="text-[10px]">Unit</Label>
                    <Input
                      placeholder="hr"
                      value={newForm.unit}
                      onChange={(e) => setNewForm((f) => ({ ...f, unit: e.target.value }))}
                      className="mt-1 h-8"
                      disabled={newSaving}
                    />
                  </div>
                  <div>
                    <Label className="text-[10px]">Free quota / month</Label>
                    <Input
                      type="number" min="0" step="0.5"
                      value={newForm.freeQty}
                      onChange={(e) => setNewForm((f) => ({ ...f, freeQty: e.target.value }))}
                      className="mt-1 h-8"
                      disabled={newSaving}
                    />
                  </div>
                  <div>
                    <Label className="text-[10px]">Overage rate / unit</Label>
                    <Input
                      type="number" min="0" step="0.01"
                      value={newForm.rate}
                      onChange={(e) => setNewForm((f) => ({ ...f, rate: e.target.value }))}
                      className="mt-1 h-8"
                      disabled={newSaving}
                    />
                  </div>
                </div>
                <div className="flex gap-2 justify-end">
                  <Button size="sm" variant="ghost" onClick={() => { setAdding(false); setNewForm(BLANK_NEW); }} disabled={newSaving} className="h-7">
                    <X className="h-3 w-3 mr-1" />Cancel
                  </Button>
                  <Button size="sm" onClick={addNew} disabled={newSaving} className="h-7">
                    {newSaving ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <Check className="h-3 w-3 mr-1" />}
                    Add
                  </Button>
                </div>
              </div>
            )}

            {!readOnly && !adding && (
              <Button variant="outline" size="sm" onClick={() => setAdding(true)} className="h-7 mt-1">
                <Plus className="h-3 w-3 mr-1" />Add facility
              </Button>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
