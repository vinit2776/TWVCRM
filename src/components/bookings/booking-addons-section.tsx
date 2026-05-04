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
// Cart item — local-only shape used by the dialog. Each row in the cart is
// either a catalog item (with `catalogId` set) or a custom line.
interface CartLine {
  /** Stable client-side id so we can track + edit individual rows */
  key: string;
  catalogId: string | null;
  addon_type: BookingAddonType;
  description: string;
  unit_price: number;
  unit_label: string | null;
  gst_rate: number;
  quantity: number;
  notes: string | null;
}

function newKey(): string {
  return Math.random().toString(36).slice(2, 10);
}

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
  const [catalog, setCatalog] = useState<AddonCatalogItem[]>([]);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [busy, setBusy] = useState(false);
  const [showCustomForm, setShowCustomForm] = useState(false);

  // Custom-line draft (separate from cart so user can fill in then click Add)
  const [customType, setCustomType] = useState<BookingAddonType>("service");
  const [customDesc, setCustomDesc] = useState("");
  const [customPrice, setCustomPrice] = useState("");
  const [customLabel, setCustomLabel] = useState("");
  const [customGst, setCustomGst] = useState("18");
  const [customQty, setCustomQty] = useState("1");

  // Reset everything when dialog opens. Prefill seeds a single starting cart
  // row (used by the post-checkout extended-time prompt).
  useEffect(() => {
    if (!open) return;
    fetch(`/api/addon-catalog?space_id=${spaceId}`)
      .then((r) => r.json())
      .then((j) => setCatalog(j.data || []));
    setShowCustomForm(false);
    setCustomType("service"); setCustomDesc(""); setCustomPrice("");
    setCustomLabel(""); setCustomGst("18"); setCustomQty("1");

    if (prefill) {
      // Seed cart with the prefilled item so it appears as the first row
      setCart([{
        key: newKey(),
        catalogId: prefill.addon_catalog_id ?? null,
        addon_type: prefill.addon_type ?? "service",
        description: prefill.description ?? "Extended time",
        unit_price: Number(prefill.unit_price ?? 0),
        unit_label: prefill.unit_label ?? null,
        gst_rate: Number(prefill.gst_rate ?? 18),
        quantity: Number(prefill.quantity ?? 1),
        notes: null,
      }]);
    } else {
      setCart([]);
    }
  }, [open, spaceId, prefill]);

  const grouped = useMemo(() => {
    const m = new Map<BookingAddonType, AddonCatalogItem[]>();
    for (const c of catalog) {
      if (!m.has(c.addon_type)) m.set(c.addon_type, []);
      m.get(c.addon_type)!.push(c);
    }
    return Array.from(m.entries());
  }, [catalog]);

  // Tap a catalog item: if not in cart yet, append with qty 1; if already
  // in cart, increment its qty. Mobile-friendly because one tap = visible
  // change (cart row appears or qty stepper goes up).
  const addCatalogItem = (item: AddonCatalogItem) => {
    setCart((prev) => {
      const existing = prev.find((c) => c.catalogId === item.id);
      if (existing) {
        return prev.map((c) =>
          c.catalogId === item.id ? { ...c, quantity: c.quantity + 1 } : c,
        );
      }
      return [...prev, {
        key: newKey(),
        catalogId: item.id,
        addon_type: item.addon_type,
        description: item.name,
        unit_price: Number(item.unit_price),
        unit_label: item.unit_label ?? null,
        gst_rate: Number(item.gst_rate),
        quantity: 1,
        notes: null,
      }];
    });
  };

  const updateCartQty = (key: string, qty: number) => {
    setCart((prev) => prev
      .map((c) => (c.key === key ? { ...c, quantity: qty } : c))
      .filter((c) => c.quantity > 0));
  };

  const removeFromCart = (key: string) => {
    setCart((prev) => prev.filter((c) => c.key !== key));
  };

  const addCustomToCart = () => {
    if (!customDesc.trim()) { toast.error("Description is required"); return; }
    const price = Number(customPrice);
    const qty = Number(customQty);
    if (!isFinite(price) || price < 0) { toast.error("Unit price must be ≥ 0"); return; }
    if (!isFinite(qty) || qty <= 0) { toast.error("Quantity must be > 0"); return; }
    setCart((prev) => [...prev, {
      key: newKey(),
      catalogId: null,
      addon_type: customType,
      description: customDesc.trim(),
      unit_price: price,
      unit_label: customLabel.trim() || null,
      gst_rate: Number(customGst) || 18,
      quantity: qty,
      notes: null,
    }]);
    setCustomDesc(""); setCustomPrice(""); setCustomLabel("");
    setCustomGst("18"); setCustomQty("1");
    setShowCustomForm(false);
    toast.success("Added to cart");
  };

  // Cart totals (preview shown above the submit button)
  const totals = useMemo(() => {
    let amount = 0; let gst = 0;
    for (const c of cart) {
      const a = c.quantity * c.unit_price;
      amount += a;
      gst += a * c.gst_rate / 100;
    }
    return { amount, gst, total: amount + gst, count: cart.length };
  }, [cart]);

  const submitAll = async () => {
    if (cart.length === 0) { toast.error("Cart is empty"); return; }
    setBusy(true);
    try {
      const res = await fetch(`/api/bookings/${bookingId}/addons`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items: cart.map((c) => ({
            addon_catalog_id: c.catalogId ?? undefined,
            addon_type: c.addon_type,
            description: c.description,
            unit_price: c.unit_price,
            unit_label: c.unit_label,
            gst_rate: c.gst_rate,
            quantity: c.quantity,
            notes: c.notes,
          })),
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed");
      toast.success(`${json.count ?? cart.length} charge${(json.count ?? cart.length) > 1 ? "s" : ""} added`);
      await onAdded();
      onOpenChange(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  };

  const TypeIcon = (t: BookingAddonType) => {
    const I = TYPE_ICON[t];
    return <I className="h-3.5 w-3.5" />;
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Mobile-first: full-height sheet on phones, max-md card on desktop.
          Sticky bottom CTA shows running total + a single "Submit N items"
          button so staff can see what they're charging at all times. */}
      <DialogContent className="max-w-md p-0 gap-0 max-h-[92vh] flex flex-col">
        <DialogHeader className="px-4 pt-4 pb-3 border-b shrink-0">
          <DialogTitle>Add charges</DialogTitle>
          <DialogDescription className="text-xs">
            Tap items to add. Adjust quantities in the cart below. You can mix catalogue + custom lines and submit all together.
          </DialogDescription>
        </DialogHeader>

        {/* Scrollable middle: catalog grid + custom-line form + cart */}
        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4">
          {/* Catalog */}
          {grouped.length === 0 ? (
            <div className="text-xs text-muted-foreground italic py-4 text-center">
              No catalog items configured for this space. Use &quot;Add custom line&quot; below or
              set up the catalogue from the space&apos;s Charges tab.
            </div>
          ) : (
            grouped.map(([type, items]) => (
              <section key={type}>
                <div className="text-[11px] uppercase text-muted-foreground font-medium mb-1.5 flex items-center gap-1">
                  {TypeIcon(type)} {TYPE_LABEL[type]}
                </div>
                {/* Big tap targets — 56px tall on mobile (h-14) */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                  {items.map((c) => {
                    const inCartQty = cart.find((x) => x.catalogId === c.id)?.quantity ?? 0;
                    return (
                      <button
                        key={c.id}
                        type="button"
                        onClick={() => addCatalogItem(c)}
                        className={cn(
                          "h-14 px-3 rounded-lg border text-left flex items-center justify-between gap-2 active:scale-[0.98] transition",
                          inCartQty > 0 ? "border-[#015E65] bg-[#015E65]/5" : "hover:bg-muted/40",
                        )}
                      >
                        <div className="min-w-0 flex-1">
                          <div className="text-sm font-medium truncate">{c.name}</div>
                          <div className="text-[10px] text-muted-foreground">
                            {formatCurrency(Number(c.unit_price))}{c.unit_label ? ` ${c.unit_label}` : ""}
                          </div>
                        </div>
                        {inCartQty > 0 ? (
                          <span className="h-7 min-w-7 px-1.5 rounded-full bg-[#015E65] text-white text-xs font-semibold flex items-center justify-center shrink-0">
                            {inCartQty}
                          </span>
                        ) : (
                          <Plus className="h-4 w-4 text-muted-foreground shrink-0" />
                        )}
                      </button>
                    );
                  })}
                </div>
              </section>
            ))
          )}

          {/* Custom line — collapsed by default; expand to enter a one-off */}
          <div className="rounded-lg border border-dashed">
            {!showCustomForm ? (
              <button
                type="button"
                onClick={() => setShowCustomForm(true)}
                className="w-full p-3 text-sm text-muted-foreground hover:bg-muted/30 rounded-lg flex items-center justify-center gap-1.5"
              >
                <Plus className="h-4 w-4" /> Add custom line (not in catalogue)
              </button>
            ) : (
              <div className="p-3 space-y-2.5 bg-muted/20 rounded-lg">
                <div className="flex items-center justify-between">
                  <Label className="text-xs font-semibold">Custom line</Label>
                  <button onClick={() => setShowCustomForm(false)} className="text-xs text-muted-foreground hover:text-foreground">
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
                <div>
                  <Label className="text-[10px]">Description</Label>
                  <Input value={customDesc} onChange={(e) => setCustomDesc(e.target.value)} placeholder="e.g. Photocopy A3 colour" className="mt-1 h-9" />
                </div>
                <div className="grid grid-cols-3 gap-2">
                  <div>
                    <Label className="text-[10px]">Type</Label>
                    <select
                      value={customType}
                      onChange={(e) => setCustomType(e.target.value as BookingAddonType)}
                      className="mt-1 h-9 w-full px-2 rounded-md border bg-background text-xs"
                    >
                      <option value="service">Service</option>
                      <option value="food_beverage">F&amp;B</option>
                      <option value="extended_time">Extended</option>
                      <option value="other">Other</option>
                    </select>
                  </div>
                  <div>
                    <Label className="text-[10px]">Price (₹)</Label>
                    <Input type="number" min="0" step="0.01" value={customPrice} onChange={(e) => setCustomPrice(e.target.value)} className="mt-1 h-9" />
                  </div>
                  <div>
                    <Label className="text-[10px]">GST %</Label>
                    <Input type="number" min="0" max="28" step="0.01" value={customGst} onChange={(e) => setCustomGst(e.target.value)} className="mt-1 h-9" />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <Label className="text-[10px]">Unit label</Label>
                    <Input value={customLabel} onChange={(e) => setCustomLabel(e.target.value)} placeholder="per page" className="mt-1 h-9" />
                  </div>
                  <div>
                    <Label className="text-[10px]">Quantity</Label>
                    <Input type="number" min="0.01" step="0.01" value={customQty} onChange={(e) => setCustomQty(e.target.value)} className="mt-1 h-9" />
                  </div>
                </div>
                <Button size="sm" onClick={addCustomToCart} className="w-full mt-1">
                  Add to cart
                </Button>
              </div>
            )}
          </div>

          {/* Cart — visible whenever it has items */}
          {cart.length > 0 && (
            <section className="space-y-1.5">
              <div className="text-[11px] uppercase text-muted-foreground font-medium">In cart</div>
              {cart.map((c) => (
                <div key={c.key} className="rounded-md border bg-card p-2.5 flex items-center gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium truncate">
                      {c.description}
                      {!c.catalogId && <span className="ml-1 text-[10px] text-muted-foreground italic">(custom)</span>}
                    </div>
                    <div className="text-[10px] text-muted-foreground">
                      {formatCurrency(c.unit_price)}{c.unit_label ? ` ${c.unit_label}` : ""}{" "}
                      · {c.gst_rate}% GST
                    </div>
                  </div>
                  {/* Quantity stepper — bigger touch targets than text input */}
                  <div className="flex items-center gap-1 shrink-0">
                    <Button
                      type="button" variant="outline" size="icon"
                      className="h-8 w-8"
                      onClick={() => updateCartQty(c.key, c.quantity - 1)}
                      aria-label="Decrease"
                    >−</Button>
                    <Input
                      type="number" min="0" step="0.01" value={String(c.quantity)}
                      onChange={(e) => updateCartQty(c.key, Number(e.target.value) || 0)}
                      className="h-8 w-14 text-center text-sm px-1 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                    />
                    <Button
                      type="button" variant="outline" size="icon"
                      className="h-8 w-8"
                      onClick={() => updateCartQty(c.key, c.quantity + 1)}
                      aria-label="Increase"
                    >+</Button>
                  </div>
                  <button
                    type="button"
                    onClick={() => removeFromCart(c.key)}
                    className="text-muted-foreground hover:text-red-600 shrink-0 ml-1"
                    aria-label="Remove"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
              ))}
            </section>
          )}
        </div>

        {/* Sticky bottom — running total + single submit. Always visible so
            staff knows what they're about to charge. */}
        <div className="border-t bg-background px-4 py-3 shrink-0 space-y-2">
          {cart.length > 0 ? (
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>{totals.count} item{totals.count > 1 ? "s" : ""}</span>
              <span>
                {formatCurrency(totals.amount)} + {formatCurrency(totals.gst)} GST =
                <span className="text-foreground font-semibold ml-1">{formatCurrency(totals.total)}</span>
              </span>
            </div>
          ) : (
            <div className="text-xs text-muted-foreground italic text-center">Cart is empty — tap items above to add.</div>
          )}
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy} className="flex-1">
              Cancel
            </Button>
            <Button onClick={submitAll} disabled={busy || cart.length === 0} className="flex-[2]">
              {busy ? <><Loader2 className="h-4 w-4 mr-1 animate-spin" /> Submitting…</>
                    : cart.length === 0 ? "Submit"
                    : `Submit ${cart.length} ${cart.length > 1 ? "charges" : "charge"} · ${formatCurrency(totals.total)}`}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
