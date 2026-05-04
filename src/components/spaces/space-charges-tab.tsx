"use client";

/**
 * Charges (Add-on catalogue) tab for a single space.
 *
 * Items shown here are what the booking detail page lists in its "Add charge"
 * dialog when an extra is collected from a customer (Tea, Coffee, Print etc.).
 * Each space owns its own list — premium meeting rooms can charge differently
 * from open-desk areas, even at the same location.
 *
 * Empty state: prompts admin to "Use defaults" which copies the standard 11
 * template items (seeded in migration 00117) into this space in one shot.
 *
 * Inline edit: name / unit price / unit label / GST% / active toggle.
 * Add-row form sits at the top.
 */

import { useEffect, useState, useMemo } from "react";
import {
  Card, CardContent, CardHeader, CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Plus, Trash2, Loader2, Coffee, Printer, Clock, Package,
  Sparkles, Pencil, Check, X,
} from "lucide-react";
import { toast } from "sonner";
import { cn, formatCurrency } from "@/lib/utils";
import type { AddonCatalogItem, BookingAddonType } from "@/types";

const TYPE_LABEL: Record<BookingAddonType, string> = {
  extended_time: "Extended time",
  food_beverage: "Food & beverage",
  service: "Service",
  other: "Other",
};
const TYPE_ICON: Record<BookingAddonType, React.ComponentType<{ className?: string }>> = {
  extended_time: Clock,
  food_beverage: Coffee,
  service: Printer,
  other: Package,
};

interface Props {
  spaceId: string;
  /** Read-only when the user lacks edit permissions. Buttons hidden but list visible. */
  readOnly?: boolean;
}

interface RowState extends AddonCatalogItem {
  // Local edit state
  editing: boolean;
  draftName: string;
  draftUnitPrice: string;
  draftUnitLabel: string;
  draftGstRate: string;
  saving: boolean;
}

export function SpaceChargesTab({ spaceId, readOnly = false }: Props) {
  const [rows, setRows] = useState<RowState[]>([]);
  const [loading, setLoading] = useState(true);
  const [seeding, setSeeding] = useState(false);

  // New-row form
  const [adding, setAdding] = useState(false);
  const [newType, setNewType] = useState<BookingAddonType>("service");
  const [newName, setNewName] = useState("");
  const [newPrice, setNewPrice] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [newGst, setNewGst] = useState("18");
  const [creating, setCreating] = useState(false);

  const fetchRows = async () => {
    setLoading(true);
    const res = await fetch(`/api/addon-catalog?space_id=${spaceId}&include_inactive=true`);
    const json = await res.json();
    setRows(((json.data || []) as AddonCatalogItem[]).map((item) => ({
      ...item,
      editing: false,
      draftName: item.name,
      draftUnitPrice: String(item.unit_price),
      draftUnitLabel: item.unit_label ?? "",
      draftGstRate: String(item.gst_rate),
      saving: false,
    })));
    setLoading(false);
  };

  useEffect(() => { fetchRows(); /* eslint-disable-next-line */ }, [spaceId]);

  const seedDefaults = async () => {
    setSeeding(true);
    try {
      const res = await fetch(`/api/spaces/${spaceId}/addon-catalog/seed-defaults`, { method: "POST" });
      const json = await res.json();
      if (!res.ok) {
        toast.error(json.error || "Failed to seed defaults");
        return;
      }
      if (json.added === 0) {
        toast.info("All defaults already present");
      } else {
        toast.success(`${json.added} default item${json.added > 1 ? "s" : ""} added`);
      }
      await fetchRows();
    } finally {
      setSeeding(false);
    }
  };

  const updateField = (idx: number, patch: Partial<RowState>) => {
    setRows((prev) => prev.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  };

  const startEdit = (idx: number) => {
    updateField(idx, { editing: true });
  };

  const cancelEdit = (idx: number) => {
    setRows((prev) => prev.map((r, i) => (i === idx ? {
      ...r,
      editing: false,
      draftName: r.name,
      draftUnitPrice: String(r.unit_price),
      draftUnitLabel: r.unit_label ?? "",
      draftGstRate: String(r.gst_rate),
    } : r)));
  };

  const saveEdit = async (idx: number) => {
    const r = rows[idx];
    const price = Number(r.draftUnitPrice);
    const gst = Number(r.draftGstRate);
    if (!r.draftName.trim()) { toast.error("Name is required"); return; }
    if (!isFinite(price) || price < 0) { toast.error("Price must be ≥ 0"); return; }

    updateField(idx, { saving: true });
    try {
      const res = await fetch(`/api/addon-catalog/${r.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: r.draftName.trim(),
          unit_price: price,
          unit_label: r.draftUnitLabel.trim() || null,
          gst_rate: isFinite(gst) ? gst : 18,
        }),
      });
      const json = await res.json();
      if (!res.ok) { toast.error(json.error || "Save failed"); return; }
      toast.success("Saved");
      await fetchRows();
    } finally {
      updateField(idx, { saving: false });
    }
  };

  const toggleActive = async (idx: number) => {
    const r = rows[idx];
    updateField(idx, { saving: true });
    try {
      const res = await fetch(`/api/addon-catalog/${r.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ is_active: !r.is_active }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => null);
        toast.error(j?.error || "Update failed");
        return;
      }
      toast.success(r.is_active ? "Hidden" : "Activated");
      await fetchRows();
    } finally {
      updateField(idx, { saving: false });
    }
  };

  const removeRow = async (idx: number) => {
    const r = rows[idx];
    if (!confirm(`Remove "${r.name}" from this space's charges?`)) return;
    updateField(idx, { saving: true });
    const res = await fetch(`/api/addon-catalog/${r.id}`, { method: "DELETE" });
    if (res.ok) {
      toast.success("Removed");
      fetchRows();
    } else {
      toast.error("Remove failed");
      updateField(idx, { saving: false });
    }
  };

  const createRow = async () => {
    if (!newName.trim()) { toast.error("Name is required"); return; }
    const price = Number(newPrice);
    if (!isFinite(price) || price < 0) { toast.error("Price must be ≥ 0"); return; }
    setCreating(true);
    try {
      const res = await fetch("/api/addon-catalog", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          space_id: spaceId,
          addon_type: newType,
          name: newName.trim(),
          unit_price: price,
          unit_label: newLabel.trim() || null,
          gst_rate: Number(newGst) || 18,
        }),
      });
      const json = await res.json();
      if (!res.ok) { toast.error(json.error || "Create failed"); return; }
      toast.success("Charge added");
      setNewName(""); setNewPrice(""); setNewLabel(""); setNewGst("18");
      setAdding(false);
      await fetchRows();
    } finally {
      setCreating(false);
    }
  };

  const grouped = useMemo(() => {
    const map = new Map<BookingAddonType, RowState[]>();
    for (const r of rows) {
      if (!map.has(r.addon_type)) map.set(r.addon_type, []);
      map.get(r.addon_type)!.push(r);
    }
    return Array.from(map.entries());
  }, [rows]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center justify-between">
          <span>Charges</span>
          <span className="text-xs font-normal text-muted-foreground">
            Add-ons billable on bookings of this space
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : rows.length === 0 ? (
          // Empty state — biggest CTA is "Use defaults" because most admins
          // will want the standard 11 items (Tea, Coffee, prints, locker, etc.)
          // without re-typing each one.
          <div className="rounded-lg border-2 border-dashed p-8 text-center space-y-3">
            <Sparkles className="h-8 w-8 mx-auto text-muted-foreground" />
            <div>
              <p className="text-sm font-medium">No charges configured for this space yet</p>
              <p className="text-xs text-muted-foreground mt-1">
                Bookings can&apos;t add extras until at least one item exists. Start with the standard set?
              </p>
            </div>
            {!readOnly && (
              <div className="flex items-center justify-center gap-2 pt-2">
                <Button onClick={seedDefaults} disabled={seeding}>
                  {seeding ? <><Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> Adding…</> : "Use defaults"}
                </Button>
                <Button variant="outline" onClick={() => setAdding(true)}>
                  <Plus className="h-4 w-4 mr-1.5" /> Add manually
                </Button>
              </div>
            )}
          </div>
        ) : (
          <>
            {/* Add-row toolbar */}
            {!readOnly && (
              <div className="flex items-center justify-between">
                <p className="text-xs text-muted-foreground">
                  {rows.length} item{rows.length === 1 ? "" : "s"}
                </p>
                <Button size="sm" variant="outline" onClick={() => setAdding((v) => !v)}>
                  <Plus className="h-3.5 w-3.5 mr-1" /> Add charge
                </Button>
              </div>
            )}

            {adding && (
              <AddRow
                type={newType} setType={setNewType}
                name={newName} setName={setNewName}
                price={newPrice} setPrice={setNewPrice}
                label={newLabel} setLabel={setNewLabel}
                gst={newGst} setGst={setNewGst}
                onCancel={() => setAdding(false)}
                onCreate={createRow}
                creating={creating}
              />
            )}

            {/* Grouped by type */}
            <div className="space-y-4">
              {grouped.map(([type, items]) => {
                const Icon = TYPE_ICON[type];
                return (
                  <section key={type}>
                    <div className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium flex items-center gap-1 mb-1.5">
                      <Icon className="h-3 w-3" /> {TYPE_LABEL[type]}
                    </div>
                    <div className="rounded-md border overflow-hidden">
                      <table className="w-full text-sm">
                        <tbody>
                          {items.map((r) => {
                            const idx = rows.findIndex((x) => x.id === r.id);
                            return (
                              <tr
                                key={r.id}
                                className={cn(
                                  "border-t first:border-t-0",
                                  !r.is_active && "bg-muted/30 text-muted-foreground italic",
                                )}
                              >
                                <td className="px-3 py-2 w-[40%]">
                                  {r.editing ? (
                                    <Input
                                      value={r.draftName}
                                      onChange={(e) => updateField(idx, { draftName: e.target.value })}
                                      className="h-7 text-sm"
                                    />
                                  ) : (
                                    <span className="font-medium">{r.name}</span>
                                  )}
                                  {!r.is_active && (
                                    <Badge variant="outline" className="ml-2 text-[10px]">Hidden</Badge>
                                  )}
                                </td>
                                <td className="px-3 py-2 text-right w-[120px]">
                                  {r.editing ? (
                                    <Input
                                      type="number" min="0" step="0.01"
                                      value={r.draftUnitPrice}
                                      onChange={(e) => updateField(idx, { draftUnitPrice: e.target.value })}
                                      className="h-7 text-sm text-right w-20 inline-block"
                                    />
                                  ) : formatCurrency(Number(r.unit_price))}
                                </td>
                                <td className="px-3 py-2 text-xs text-muted-foreground w-[100px]">
                                  {r.editing ? (
                                    <Input
                                      value={r.draftUnitLabel}
                                      onChange={(e) => updateField(idx, { draftUnitLabel: e.target.value })}
                                      className="h-7 text-xs"
                                      placeholder="per page"
                                    />
                                  ) : (r.unit_label || "—")}
                                </td>
                                <td className="px-3 py-2 text-xs text-muted-foreground w-[60px] text-right">
                                  {r.editing ? (
                                    <Input
                                      type="number" min="0" max="28" step="0.01"
                                      value={r.draftGstRate}
                                      onChange={(e) => updateField(idx, { draftGstRate: e.target.value })}
                                      className="h-7 text-xs text-right w-14 inline-block"
                                    />
                                  ) : `${Number(r.gst_rate)}%`}
                                </td>
                                {!readOnly && (
                                  <td className="px-2 py-2 w-px whitespace-nowrap">
                                    <div className="flex items-center justify-end gap-0.5">
                                      {r.editing ? (
                                        <>
                                          <Button size="sm" className="h-7 w-7 p-0" onClick={() => saveEdit(idx)} disabled={r.saving}>
                                            {r.saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
                                          </Button>
                                          <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={() => cancelEdit(idx)}>
                                            <X className="h-3 w-3" />
                                          </Button>
                                        </>
                                      ) : (
                                        <>
                                          <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={() => startEdit(idx)} title="Edit">
                                            <Pencil className="h-3 w-3" />
                                          </Button>
                                          <Button
                                            size="sm" variant="ghost"
                                            className="h-7 px-2 text-[10px]"
                                            onClick={() => toggleActive(idx)}
                                            disabled={r.saving}
                                            title={r.is_active ? "Hide from booking add-charge dialog" : "Show in booking add-charge dialog"}
                                          >
                                            {r.is_active ? "Hide" : "Show"}
                                          </Button>
                                          <Button
                                            size="sm" variant="ghost"
                                            className="h-7 w-7 p-0 text-red-600 hover:text-red-700"
                                            onClick={() => removeRow(idx)}
                                            title="Remove"
                                          >
                                            <Trash2 className="h-3 w-3" />
                                          </Button>
                                        </>
                                      )}
                                    </div>
                                  </td>
                                )}
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </section>
                );
              })}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Add-row form — collapsible row above the catalogue list.
// ─────────────────────────────────────────────────────────────────────────────

function AddRow({
  type, setType, name, setName, price, setPrice, label, setLabel, gst, setGst,
  onCancel, onCreate, creating,
}: {
  type: BookingAddonType; setType: (v: BookingAddonType) => void;
  name: string; setName: (v: string) => void;
  price: string; setPrice: (v: string) => void;
  label: string; setLabel: (v: string) => void;
  gst: string; setGst: (v: string) => void;
  onCancel: () => void; onCreate: () => void; creating: boolean;
}) {
  return (
    <div className="rounded-md border bg-muted/20 p-3 space-y-2">
      <div className="grid grid-cols-1 sm:grid-cols-12 gap-2">
        <div className="sm:col-span-3">
          <Label className="text-[10px]">Type</Label>
          <select
            value={type}
            onChange={(e) => setType(e.target.value as BookingAddonType)}
            className="mt-1 h-8 w-full px-2 rounded-md border bg-background text-xs"
          >
            <option value="service">Service</option>
            <option value="food_beverage">Food &amp; beverage</option>
            <option value="extended_time">Extended time</option>
            <option value="other">Other</option>
          </select>
        </div>
        <div className="sm:col-span-4">
          <Label className="text-[10px]">Name</Label>
          <Input value={name} onChange={(e) => setName(e.target.value)} className="mt-1 h-8" placeholder="e.g. Photocopy A3 colour" />
        </div>
        <div className="sm:col-span-2">
          <Label className="text-[10px]">Price (₹)</Label>
          <Input type="number" min="0" step="0.01" value={price} onChange={(e) => setPrice(e.target.value)} className="mt-1 h-8" />
        </div>
        <div className="sm:col-span-2">
          <Label className="text-[10px]">Unit label</Label>
          <Input value={label} onChange={(e) => setLabel(e.target.value)} className="mt-1 h-8" placeholder="per page" />
        </div>
        <div className="sm:col-span-1">
          <Label className="text-[10px]">GST %</Label>
          <Input type="number" min="0" max="28" step="0.01" value={gst} onChange={(e) => setGst(e.target.value)} className="mt-1 h-8" />
        </div>
      </div>
      <div className="flex items-center justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={creating}>Cancel</Button>
        <Button size="sm" onClick={onCreate} disabled={creating}>
          {creating ? <><Loader2 className="h-3 w-3 mr-1 animate-spin" /> Adding…</> : "Add"}
        </Button>
      </div>
    </div>
  );
}
