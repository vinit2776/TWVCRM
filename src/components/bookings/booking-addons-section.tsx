"use client";

/**
 * Booking add-ons section — used on the booking detail page to:
 *   • show all extras charged (extended time, food & beverage, services)
 *   • let staff add a charge from the catalog or as a free-text line
 *   • let staff remove a wrongly-added charge
 *
 * The booking's `total_amount_with_gst` is recomputed by the API on every
 * add/remove, so the parent page should refetch the booking after changes.
 */

import { useEffect, useMemo, useState } from "react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Plus, Trash2, Loader2, Coffee, Printer, Clock, Package, X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { formatCurrency } from "@/lib/utils";
import type { BookingAddon, AddonCatalogItem, BookingAddonType } from "@/types";

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
  bookingId: string;
  /** Used to scope the add-charge dialog to this space's catalogue.
   *  Catalogue items live per-space (Tea / Print / Coffee rates can differ
   *  between rooms even at the same location). */
  spaceId: string;
  /** Kept for backwards-compat with older parents — no longer used. */
  locationId?: string;
  /** Allow add/remove. Set false on locked / cancelled bookings. */
  canEdit: boolean;
  /** Called after a successful add or remove so the parent can refetch totals. */
  onChange?: () => void;
  /** When provided, the dialog opens pre-filled — used by the check-out
   *  overtime prompt to suggest the "Extended time" addon. */
  prefill?: {
    addon_catalog_id?: string;
    addon_type?: BookingAddonType;
    description?: string;
    quantity?: number;
    unit_price?: number;
    unit_label?: string;
    gst_rate?: number;
  } | null;
  /** Set to a unique value to programmatically open the add dialog. */
  openSignal?: number;
}

export function BookingAddonsSection({
  bookingId, spaceId, canEdit, onChange, prefill, openSignal,
}: Props) {
  const [addons, setAddons] = useState<BookingAddon[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);

  const fetchAddons = async () => {
    setLoading(true);
    const res = await fetch(`/api/bookings/${bookingId}/addons`);
    const json = await res.json();
    setAddons(json.data || []);
    setLoading(false);
  };

  useEffect(() => { fetchAddons(); /* eslint-disable-next-line */ }, [bookingId]);

  // External "open the dialog with prefill" signal
  useEffect(() => {
    if (openSignal != null) setDialogOpen(true);
  }, [openSignal]);

  const remove = async (addonId: string) => {
    if (!canEdit) return;
    const res = await fetch(`/api/bookings/${bookingId}/addons/${addonId}`, { method: "DELETE" });
    if (!res.ok) { toast.error("Could not remove charge"); return; }
    toast.success("Charge removed");
    await fetchAddons();
    onChange?.();
  };

  const subtotal = useMemo(
    () => addons.reduce((s, a) => s + Number(a.amount), 0),
    [addons],
  );
  const subtotalGst = useMemo(
    () => addons.reduce((s, a) => s + Number(a.gst_amount), 0),
    [addons],
  );
  const subtotalWithGst = subtotal + subtotalGst;

  return (
    <div className="rounded-lg border bg-card p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold">Extras &amp; charges</h3>
          <p className="text-xs text-muted-foreground">Add-ons added during check-in / check-out</p>
        </div>
        {canEdit && (
          <Button size="sm" onClick={() => setDialogOpen(true)}>
            <Plus className="h-4 w-4 mr-1" /> Add charge
          </Button>
        )}
      </div>

      {loading ? (
        <div className="text-xs text-muted-foreground py-2">Loading…</div>
      ) : addons.length === 0 ? (
        <p className="text-xs text-muted-foreground italic py-2">No extras yet.</p>
      ) : (
        <div className="rounded-md border overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-xs">
              <tr>
                <th className="text-left px-3 py-1.5 font-medium">Item</th>
                <th className="text-right px-3 py-1.5 font-medium">Qty</th>
                <th className="text-right px-3 py-1.5 font-medium">Rate</th>
                <th className="text-right px-3 py-1.5 font-medium">Amount</th>
                <th className="text-right px-3 py-1.5 font-medium">GST</th>
                <th className="text-right px-3 py-1.5 font-medium">Total</th>
                {canEdit && <th className="w-7"></th>}
              </tr>
            </thead>
            <tbody>
              {addons.map((a) => {
                const Icon = TYPE_ICON[a.addon_type];
                return (
                  <tr key={a.id} className="border-t hover:bg-muted/20">
                    <td className="px-3 py-1.5">
                      <div className="flex items-center gap-2">
                        <Icon className="h-3.5 w-3.5 text-muted-foreground" />
                        <div className="min-w-0">
                          <div className="font-medium truncate">{a.description}</div>
                          <div className="text-[10px] text-muted-foreground">
                            {TYPE_LABEL[a.addon_type]}{a.unit_label ? ` · ${a.unit_label}` : ""}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="px-3 py-1.5 text-right text-xs">{Number(a.quantity)}</td>
                    <td className="px-3 py-1.5 text-right text-xs">{formatCurrency(Number(a.unit_price))}</td>
                    <td className="px-3 py-1.5 text-right">{formatCurrency(Number(a.amount))}</td>
                    <td className="px-3 py-1.5 text-right text-xs text-muted-foreground">{formatCurrency(Number(a.gst_amount))}</td>
                    <td className="px-3 py-1.5 text-right font-medium">{formatCurrency(Number(a.total_with_gst))}</td>
                    {canEdit && (
                      <td className="px-1">
                        <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => remove(a.id)} title="Remove">
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </td>
                    )}
                  </tr>
                );
              })}
              <tr className="border-t bg-muted/20 text-xs font-medium">
                <td className="px-3 py-1.5" colSpan={3}>Subtotal</td>
                <td className="px-3 py-1.5 text-right">{formatCurrency(subtotal)}</td>
                <td className="px-3 py-1.5 text-right">{formatCurrency(subtotalGst)}</td>
                <td className="px-3 py-1.5 text-right">{formatCurrency(subtotalWithGst)}</td>
                {canEdit && <td />}
              </tr>
            </tbody>
          </table>
        </div>
      )}

      <AddChargeDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        bookingId={bookingId}
        spaceId={spaceId}
        prefill={prefill}
        onAdded={async () => { await fetchAddons(); onChange?.(); }}
      />
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Add-charge dialog: pick from catalog OR enter a free-text line
// ───────────────────────────────────────────────────────────────────────────
function AddChargeDialog({
  open, onOpenChange, bookingId, spaceId, prefill, onAdded,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  bookingId: string;
  spaceId: string;
  prefill?: Props["prefill"];
  onAdded: () => void | Promise<void>;
}) {
  const [tab, setTab] = useState<"catalog" | "custom">("catalog");
  const [catalog, setCatalog] = useState<AddonCatalogItem[]>([]);
  const [picked, setPicked] = useState<AddonCatalogItem | null>(null);
  const [quantity, setQuantity] = useState("1");
  const [busy, setBusy] = useState(false);

  // Free-text fields
  const [customType, setCustomType] = useState<BookingAddonType>("service");
  const [description, setDescription] = useState("");
  const [unitPrice, setUnitPrice] = useState("");
  const [unitLabel, setUnitLabel] = useState("");
  const [gstRate, setGstRate] = useState("18");
  const [notes, setNotes] = useState("");

  useEffect(() => {
    if (!open) return;
    // Catalogue is now scoped per-space; bookings of the same room get a
    // consistent list of extras while different rooms can charge differently.
    fetch(`/api/addon-catalog?space_id=${spaceId}`)
      .then((r) => r.json())
      .then((j) => setCatalog(j.data || []));

    if (prefill) {
      // External prefill (e.g. extended-time suggestion from check-out)
      setTab(prefill.addon_catalog_id ? "catalog" : "custom");
      setQuantity(String(prefill.quantity ?? 1));
      setCustomType(prefill.addon_type ?? "service");
      setDescription(prefill.description ?? "");
      setUnitPrice(String(prefill.unit_price ?? ""));
      setUnitLabel(prefill.unit_label ?? "");
      setGstRate(String(prefill.gst_rate ?? 18));
      setPicked(null);
    } else {
      setTab("catalog");
      setPicked(null);
      setQuantity("1");
      setDescription("");
      setUnitPrice("");
      setUnitLabel("");
      setGstRate("18");
      setNotes("");
    }
  }, [open, spaceId, prefill]);

  // When prefill targets a specific catalog item, auto-pick it once catalog loads
  useEffect(() => {
    if (!open || !prefill?.addon_catalog_id || catalog.length === 0) return;
    const match = catalog.find((c) => c.id === prefill.addon_catalog_id);
    if (match) setPicked(match);
  }, [open, prefill, catalog]);

  const grouped = useMemo(() => {
    const m = new Map<BookingAddonType, AddonCatalogItem[]>();
    for (const c of catalog) {
      if (!m.has(c.addon_type)) m.set(c.addon_type, []);
      m.get(c.addon_type)!.push(c);
    }
    return Array.from(m.entries());
  }, [catalog]);

  const submit = async () => {
    setBusy(true);
    try {
      const body: Record<string, unknown> = {
        quantity: Number(quantity) || 1,
        notes: notes.trim() || null,
      };
      if (tab === "catalog" && picked) {
        body.addon_catalog_id = picked.id;
      } else {
        if (!description.trim() || !unitPrice) {
          toast.error("Description and unit price are required");
          setBusy(false);
          return;
        }
        body.addon_type = customType;
        body.description = description.trim();
        body.unit_price = Number(unitPrice);
        body.unit_label = unitLabel.trim() || null;
        body.gst_rate = Number(gstRate) || 18;
      }
      const res = await fetch(`/api/bookings/${bookingId}/addons`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed");
      toast.success("Charge added");
      await onAdded();
      onOpenChange(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  };

  const linePreview = (() => {
    let qty = Number(quantity) || 0;
    if (qty <= 0) qty = 1;
    let unit = 0;
    let gst = 18;
    if (tab === "catalog" && picked) { unit = Number(picked.unit_price); gst = Number(picked.gst_rate); }
    else { unit = Number(unitPrice) || 0; gst = Number(gstRate) || 18; }
    const amount = qty * unit;
    const gstAmt = amount * gst / 100;
    return { qty, unit, gst, amount, gstAmt, total: amount + gstAmt };
  })();

  const Icon = (t: BookingAddonType) => {
    const I = TYPE_ICON[t];
    return <I className="h-3.5 w-3.5" />;
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Add charge</DialogTitle>
          <DialogDescription>From catalog or as a one-off line item.</DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-1 rounded-lg bg-muted/40 p-1">
          <button
            type="button"
            onClick={() => setTab("catalog")}
            className={cn("py-1.5 text-xs font-medium rounded-md", tab === "catalog" ? "bg-background shadow-sm" : "text-muted-foreground")}
          >From catalog</button>
          <button
            type="button"
            onClick={() => setTab("custom")}
            className={cn("py-1.5 text-xs font-medium rounded-md", tab === "custom" ? "bg-background shadow-sm" : "text-muted-foreground")}
          >Custom line</button>
        </div>

        {tab === "catalog" ? (
          <div className="space-y-3 max-h-[50vh] overflow-y-auto">
            {grouped.length === 0 ? (
              <p className="text-xs text-muted-foreground italic py-4">No catalog items configured.</p>
            ) : (
              grouped.map(([type, items]) => (
                <div key={type}>
                  <div className="text-[11px] uppercase text-muted-foreground font-medium mb-1 flex items-center gap-1">
                    {Icon(type)} {TYPE_LABEL[type]}
                  </div>
                  <div className="grid grid-cols-1 gap-1.5">
                    {items.map((c) => (
                      <button
                        key={c.id}
                        type="button"
                        onClick={() => setPicked(c)}
                        className={cn(
                          "w-full text-left p-2 rounded-md border text-sm flex justify-between items-center",
                          picked?.id === c.id ? "border-[#015E65] bg-[#015E65]/5" : "hover:bg-muted/40",
                        )}
                      >
                        <span className="min-w-0 truncate">
                          {c.name}
                          {c.unit_label ? <span className="text-xs text-muted-foreground"> · {c.unit_label}</span> : null}
                        </span>
                        <span className="text-xs font-mono shrink-0">{formatCurrency(Number(c.unit_price))}</span>
                      </button>
                    ))}
                  </div>
                </div>
              ))
            )}
          </div>
        ) : (
          <div className="space-y-3">
            <div>
              <Label className="text-xs">Type</Label>
              <select
                value={customType}
                onChange={(e) => setCustomType(e.target.value as BookingAddonType)}
                className="mt-1 w-full h-9 px-2 rounded-md border bg-background text-sm"
              >
                <option value="service">Service</option>
                <option value="food_beverage">Food &amp; beverage</option>
                <option value="extended_time">Extended time</option>
                <option value="other">Other</option>
              </select>
            </div>
            <div>
              <Label className="text-xs">Description</Label>
              <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="e.g. Photocopy A3 colour" className="mt-1" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs">Unit price (₹, ex-GST)</Label>
                <Input type="number" min="0" step="0.01" value={unitPrice} onChange={(e) => setUnitPrice(e.target.value)} className="mt-1" />
              </div>
              <div>
                <Label className="text-xs">Unit label</Label>
                <Input value={unitLabel} onChange={(e) => setUnitLabel(e.target.value)} placeholder="per page / per cup" className="mt-1" />
              </div>
            </div>
            <div>
              <Label className="text-xs">GST rate (%)</Label>
              <Input type="number" min="0" max="28" step="0.01" value={gstRate} onChange={(e) => setGstRate(e.target.value)} className="mt-1 w-24" />
            </div>
          </div>
        )}

        <div className="border-t pt-3 space-y-2">
          <div className="flex items-center gap-2">
            <Label className="text-xs w-20">Quantity</Label>
            <Input type="number" min="0.01" step="0.01" value={quantity} onChange={(e) => setQuantity(e.target.value)} className="w-24 h-8" />
          </div>
          <div>
            <Label className="text-xs">Notes (optional)</Label>
            <Input value={notes} onChange={(e) => setNotes(e.target.value)} className="mt-1" />
          </div>
          <div className="text-xs text-muted-foreground border-t pt-2">
            Preview: {linePreview.qty} × {formatCurrency(linePreview.unit)} = {formatCurrency(linePreview.amount)} +
            {" "}{linePreview.gst}% GST = <span className="text-foreground font-semibold">{formatCurrency(linePreview.total)}</span>
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}><X className="h-4 w-4 mr-1" /> Cancel</Button>
          <Button onClick={submit} disabled={busy || (tab === "catalog" && !picked)}>
            {busy ? <><Loader2 className="h-4 w-4 mr-1 animate-spin" /> Adding…</> : "Add charge"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
