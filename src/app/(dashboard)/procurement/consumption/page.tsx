"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import {
  Globe,
  Search,
  AlertTriangle,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  RotateCcw,
  Loader2,
  Plus,
  Minus,
  Package,
  ListChecks,
} from "lucide-react";
import { t } from "@/lib/translations";
import { useLanguage, LanguageProvider } from "@/providers/language-provider";
import { PROCUREMENT_DEPARTMENTS, PROCUREMENT_DEPARTMENT_LABELS } from "@/lib/constants";
import Link from "next/link";
import { cn } from "@/lib/utils";

interface UserLocation {
  id: string;
  location_id: string;
  responsibility: "primary" | "secondary";
  location: { id: string; name: string };
}

interface InventoryItem {
  id: string;
  item_id: string;
  item_name: string;
  department: string;
  unit: string;
  quantity_on_hand: number;
  reorder_level: number;
}

interface CartEntry {
  quantity: number;
  notes: string;
}

interface ReorderAlert {
  item_name: string;
  quantity_on_hand: number;
  reorder_level: number;
}

type WizardStep = 1 | 2 | 3 | 4;

const STEPS = [
  { n: 1, label: "Location", labelTa: "இடம்" },
  { n: 2, label: "Pick Items", labelTa: "பொருட்கள்" },
  { n: 3, label: "Review Cart", labelTa: "கார்ட்" },
  { n: 4, label: "Confirm", labelTa: "உறுதிப்படுத்து" },
];

function StepIndicator({ step, lang }: { step: WizardStep; lang: string }) {
  return (
    <div className="flex items-center justify-center gap-0 mb-8">
      {STEPS.map((s, i) => {
        const isComplete = step > s.n;
        const isCurrent = step === s.n;
        return (
          <div key={s.n} className="flex items-center">
            <div className="flex flex-col items-center">
              <div
                className={cn(
                  "w-8 h-8 rounded-full flex items-center justify-center text-sm font-semibold transition-colors",
                  isComplete && "bg-primary text-primary-foreground",
                  isCurrent && "bg-primary text-primary-foreground ring-2 ring-primary ring-offset-2",
                  !isComplete && !isCurrent && "bg-muted text-muted-foreground"
                )}
                aria-current={isCurrent ? "step" : undefined}
              >
                {isComplete ? <CheckCircle2 className="h-4 w-4" /> : s.n}
              </div>
              <span className={cn(
                "hidden sm:block text-xs mt-1 font-medium",
                isCurrent ? "text-primary" : "text-muted-foreground"
              )}>
                {lang === "en" ? s.label : s.labelTa}
              </span>
            </div>
            {i < STEPS.length - 1 && (
              <div className={cn(
                "h-px w-8 sm:w-16 mx-1",
                step > s.n ? "bg-primary" : "bg-border"
              )} />
            )}
          </div>
        );
      })}
    </div>
  );
}

function ConsumptionPageContent() {
  const { lang, toggleLang } = useLanguage();
  const [step, setStep] = useState<WizardStep>(1);

  // User + locations
  const [userRole, setUserRole] = useState<string>("");
  const [userLocations, setUserLocations] = useState<UserLocation[]>([]);
  const [allLocations, setAllLocations] = useState<{ id: string; name: string }[]>([]);
  const [locationsLoading, setLocationsLoading] = useState(true);
  const [selectedLocationId, setSelectedLocationId] = useState("");

  // Inventory
  const [items, setItems] = useState<InventoryItem[]>([]);
  const [inventoryLoading, setInventoryLoading] = useState(false);
  const [department, setDepartment] = useState("all");
  const [search, setSearch] = useState("");

  // Cart
  const [cart, setCart] = useState<Record<string, CartEntry>>({});
  const [globalNotes, setGlobalNotes] = useState("");

  // Submit
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [reorderAlerts, setReorderAlerts] = useState<ReorderAlert[]>([]);
  const [lastLog, setLastLog] = useState<{ locationId: string; items: typeof cart } | null>(null);

  const isCrossLocationRole = ["admin", "manager", "office_admin"].includes(userRole);

  // Available locations for this user
  const availableLocations = useMemo(() => {
    // HO roles, or any user not yet assigned to a location, see all (no lockout).
    if (isCrossLocationRole || userLocations.length === 0) return allLocations;
    return userLocations
      .sort((a, b) => (a.responsibility === "primary" ? -1 : 1))
      .map((ul) => ul.location);
  }, [isCrossLocationRole, allLocations, userLocations]);

  // Load user info + locations
  useEffect(() => {
    async function load() {
      setLocationsLoading(true);
      try {
        const [meRes, locRes, ulRes] = await Promise.all([
          fetch("/api/me").then((r) => r.json()),
          fetch("/api/locations").then((r) => r.json()),
          // self-scoped — any authenticated user can read their own assignments
          fetch("/api/me/locations").then((r) => r.json()).catch(() => ({ data: [] })),
        ]);

        const role = meRes.role ?? "";
        setUserRole(role);

        const locs = locRes.data || locRes.locations || [];
        setAllLocations(Array.isArray(locs) ? locs : []);

        // /api/me/locations already returns only the current user's rows
        const myUls: UserLocation[] = ulRes.data ?? [];
        setUserLocations(myUls);

        // Auto-select primary location
        const primaryUl = myUls.find((ul) => ul.responsibility === "primary");
        if (primaryUl) {
          setSelectedLocationId(primaryUl.location_id);
        } else if (myUls.length > 0) {
          setSelectedLocationId(myUls[0].location_id);
        } else if (locs.length > 0) {
          // HO roles or unassigned users fall back to the first location
          setSelectedLocationId(locs[0].id);
        }
      } catch {
        toast.error("Failed to load location data");
      } finally {
        setLocationsLoading(false);
      }
    }
    load();
  }, []);

  const fetchInventory = useCallback(async () => {
    if (!selectedLocationId) return;
    setInventoryLoading(true);
    try {
      const res = await fetch(`/api/procurement/inventory?location_id=${selectedLocationId}`);
      const data = await res.json();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      setItems((data.data || [])
        // Services (AMC, rentals, pest control, etc.) are not physical stock —
        // they cannot be consumed, so keep them out of the picker.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .filter((row: any) => row.procurement_items?.item_type !== "service")
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .map((row: any) => ({
          id: row.id,
          item_id: row.item_id,
          item_name: row.procurement_items?.name ?? "Unknown",
          department: row.procurement_items?.department ?? "",
          unit: row.procurement_items?.unit ?? "",
          quantity_on_hand: Number(row.quantity_on_hand) || 0,
          reorder_level: Number(row.reorder_level) || 0,
        })));
      setCart({});
    } catch {
      toast.error("Failed to load inventory");
    } finally {
      setInventoryLoading(false);
    }
  }, [selectedLocationId]);

  useEffect(() => {
    if (step === 2) fetchInventory();
  }, [step, fetchInventory]);

  const filteredItems = useMemo(() => items.filter((item) => {
    if (department !== "all" && item.department !== department) return false;
    if (search && !item.item_name.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  }), [items, department, search]);

  const cartItems = useMemo(() =>
    Object.entries(cart)
      .filter(([, e]) => e.quantity > 0)
      .map(([itemId, e]) => {
        const item = items.find((i) => i.id === itemId);
        return item ? { itemId, item, quantity: e.quantity, notes: e.notes } : null;
      })
      .filter(Boolean) as { itemId: string; item: InventoryItem; quantity: number; notes: string }[],
    [cart, items]
  );

  const setQty = (itemId: string, qty: number) => {
    const item = items.find((i) => i.id === itemId);
    const max = item?.quantity_on_hand ?? Infinity;
    const clamped = Math.max(0, Math.min(qty, max));
    setCart((prev) => ({
      ...prev,
      [itemId]: { ...prev[itemId], quantity: clamped, notes: prev[itemId]?.notes ?? "" },
    }));
  };

  const setNotes = (itemId: string, notes: string) => {
    setCart((prev) => ({
      ...prev,
      [itemId]: { ...prev[itemId], notes, quantity: prev[itemId]?.quantity ?? 0 },
    }));
  };

  const quickRepeat = () => {
    if (!lastLog || lastLog.locationId !== selectedLocationId) return;
    setCart(lastLog.items);
    toast.success("Last entry loaded");
  };

  const selectedLocation = availableLocations.find((l) => l.id === selectedLocationId);

  const handleSubmit = async () => {
    if (cartItems.length === 0) return;
    setSubmitting(true);
    try {
      const res = await fetch("/api/procurement/consumption", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          location_id: selectedLocationId,
          notes: globalNotes || undefined,
          items: cartItems.map((e) => ({
            item_id: e.item.item_id,
            item_name: e.item.item_name,
            unit: e.item.unit,
            quantity_consumed: e.quantity,
            notes: e.notes || undefined,
          })),
        }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to log consumption");

      setLastLog({ locationId: selectedLocationId, items: cart });
      setReorderAlerts(data.reorder_alerts ?? []);
      setSubmitted(true);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Error submitting");
    } finally {
      setSubmitting(false);
    }
  };

  const reset = () => {
    setStep(1);
    setCart({});
    setGlobalNotes("");
    setSubmitted(false);
    setReorderAlerts([]);
    setSearch("");
    setDepartment("all");
  };

  // ── Post-submit success screen ───────────────────────────────────────────────
  if (submitted) {
    return (
      <div className="max-w-lg mx-auto space-y-4 pt-8">
        <div className="text-center space-y-2">
          <CheckCircle2 className="h-12 w-12 text-green-500 mx-auto" />
          <h2 className="text-xl font-semibold">
            {lang === "en" ? "Consumption logged successfully" : "நுகர்வு பதிவு செய்யப்பட்டது"}
          </h2>
          <p className="text-sm text-muted-foreground">
            {cartItems.length} {lang === "en" ? "items logged at" : "பொருட்கள்"}{" "}
            {selectedLocation?.name}
          </p>
        </div>

        {reorderAlerts.length > 0 && (
          <div className="space-y-2">
            {reorderAlerts.map((alert) => (
              <Card key={alert.item_name} className="border-amber-300 bg-amber-50 dark:bg-amber-950/20">
                <CardContent className="p-3 flex items-center gap-2">
                  <AlertTriangle className="h-4 w-4 text-amber-600 flex-shrink-0" />
                  <span className="text-sm text-amber-800 dark:text-amber-300">
                    <strong>{lang === "en" ? "Stock low" : "குறைந்த இருப்பு"}:</strong>{" "}
                    {alert.item_name} — {alert.quantity_on_hand} {lang === "en" ? "remaining (reorder at" : "மீதமுள்ளது"}{" "}
                    {alert.reorder_level})
                  </span>
                </CardContent>
              </Card>
            ))}
          </div>
        )}

        <div className="flex gap-3">
          <Button className="flex-1" onClick={reset}>
            {lang === "en" ? "Log More" : "மேலும் பதிவு"}
          </Button>
          <Button variant="outline" className="flex-1" asChild>
            <Link href="/procurement/consumption/history">
              {lang === "en" ? "View History" : "வரலாற்றை காண"}
            </Link>
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-3xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">
            {lang === "en" ? "Log Consumption" : "நுகர்வு பதிவு"}
          </h1>
          <p className="text-muted-foreground text-sm">
            {lang === "en" ? "Track daily material usage at your location" : "உங்கள் இடத்தில் தினசரி பொருள் பயன்பாட்டைக் கண்காணிக்கவும்"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href="/procurement/consumption/history"
            className="text-sm text-muted-foreground hover:text-foreground flex items-center gap-1"
          >
            <ListChecks className="h-4 w-4" />
            <span className="hidden sm:inline">{lang === "en" ? "History" : "வரலாறு"}</span>
          </Link>
          <Button variant="outline" size="sm" onClick={toggleLang}>
            <Globe className="h-4 w-4 mr-1.5" />
            {lang === "en" ? t("lang.tamil", lang) : t("lang.english", lang)}
          </Button>
        </div>
      </div>

      <StepIndicator step={step} lang={lang} />

      {/* ── STEP 1: Location ─────────────────────────────────────────────────── */}
      {step === 1 && (
        <div className="space-y-6">
          {locationsLoading ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : availableLocations.length === 0 ? (
            <Card>
              <CardContent className="py-12 text-center space-y-2">
                <Package className="h-10 w-10 text-muted-foreground mx-auto" />
                <p className="font-medium">
                  {lang === "en" ? "No location assigned yet" : "இடம் ஒதுக்கப்படவில்லை"}
                </p>
                <p className="text-sm text-muted-foreground">
                  {lang === "en"
                    ? "Ask your admin to assign you to a location."
                    : "உங்கள் நிர்வாகியிடம் இடத்தை ஒதுக்குமாறு கேளுங்கள்."}
                </p>
                {isCrossLocationRole && (
                  <Button variant="outline" size="sm" asChild className="mt-2">
                    <Link href="/admin/user-locations">Manage Assignments</Link>
                  </Button>
                )}
              </CardContent>
            </Card>
          ) : (
            <Card>
              <CardContent className="p-6 space-y-4">
                <div className="space-y-2">
                  <Label>
                    {lang === "en" ? "Select Location" : "இடத்தைத் தேர்ந்தெடுக்கவும்"}
                  </Label>
                  <Select value={selectedLocationId} onValueChange={setSelectedLocationId}>
                    <SelectTrigger className="h-11">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {availableLocations.map((loc) => {
                        const ul = userLocations.find((u) => u.location_id === loc.id);
                        return (
                          <SelectItem key={loc.id} value={loc.id}>
                            {loc.name}
                            {ul && (
                              <span className="ml-2 text-xs text-muted-foreground">
                                ({ul.responsibility})
                              </span>
                            )}
                          </SelectItem>
                        );
                      })}
                    </SelectContent>
                  </Select>
                </div>

                {lastLog?.locationId === selectedLocationId && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-full gap-2"
                    onClick={quickRepeat}
                  >
                    <RotateCcw className="h-4 w-4" />
                    {lang === "en" ? "Repeat Last Entry" : "கடைசி உள்ளீட்டை மீண்டும் செய்"}
                  </Button>
                )}
              </CardContent>
            </Card>
          )}

          {availableLocations.length > 0 && (
            <div className="flex justify-end">
              <Button
                onClick={() => setStep(2)}
                disabled={!selectedLocationId}
                className="gap-2 min-w-[120px]"
              >
                {lang === "en" ? "Next" : "அடுத்து"}
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          )}
        </div>
      )}

      {/* ── STEP 2: Item Selection ───────────────────────────────────────────── */}
      {step === 2 && (
        <div className="space-y-4">
          {/* Sticky search + department tabs */}
          <div className="space-y-2 sticky top-0 bg-background pt-1 pb-2 z-10">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder={lang === "en" ? "Search items..." : "பொருட்களை தேடுங்கள்..."}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-9 h-11"
                autoFocus
              />
            </div>
            <div className="overflow-x-auto">
              <Tabs value={department} onValueChange={setDepartment}>
                <TabsList className="w-max">
                  <TabsTrigger value="all">
                    {lang === "en" ? t("filter.all", lang) : "அனைத்தும்"}
                  </TabsTrigger>
                  {PROCUREMENT_DEPARTMENTS.map((dept) => (
                    <TabsTrigger key={dept} value={dept}>
                      {PROCUREMENT_DEPARTMENT_LABELS[dept]}
                    </TabsTrigger>
                  ))}
                </TabsList>
              </Tabs>
            </div>
          </div>

          {inventoryLoading ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : filteredItems.length === 0 ? (
            <Card>
              <CardContent className="py-12 text-center text-muted-foreground">
                {items.length === 0
                  ? (lang === "en"
                    ? "No inventory at this location. Stock arrives via purchase orders or transfers."
                    : "இந்த இடத்தில் சரக்கு இல்லை.")
                  : (lang === "en" ? "No items match your search." : "தேடலுக்கு பொருந்தும் பொருட்கள் இல்லை.")}
              </CardContent>
            </Card>
          ) : (
            <div className="border rounded-lg overflow-hidden">
              {filteredItems.map((item, idx) => {
                const isOut = item.quantity_on_hand === 0;
                const isBelowReorder = item.quantity_on_hand > 0 && item.quantity_on_hand <= item.reorder_level;
                const qty = cart[item.id]?.quantity ?? 0;
                return (
                  <div
                    key={item.id}
                    className={cn(
                      "flex items-center gap-3 px-4 py-3",
                      idx > 0 && "border-t",
                      isOut && "opacity-50"
                    )}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-medium text-sm">{item.item_name}</span>
                        {isBelowReorder && (
                          <AlertTriangle className="h-3.5 w-3.5 text-amber-500 flex-shrink-0" />
                        )}
                        {isOut && (
                          <Badge variant="secondary" className="text-xs">
                            {lang === "en" ? "Out of stock" : "இருப்பு இல்லை"}
                          </Badge>
                        )}
                      </div>
                      <p className={cn("text-xs mt-0.5", isBelowReorder ? "text-amber-600" : "text-muted-foreground")}>
                        {item.quantity_on_hand} {item.unit} {lang === "en" ? "available" : "கிடைக்கும்"}
                      </p>
                    </div>

                    {/* Stepper */}
                    <div className="flex items-center gap-1 flex-shrink-0">
                      <button
                        onClick={() => setQty(item.id, qty - 1)}
                        disabled={isOut || qty === 0}
                        className={cn(
                          "w-11 h-11 rounded-md border flex items-center justify-center transition-colors",
                          "hover:bg-muted disabled:opacity-40 disabled:cursor-not-allowed"
                        )}
                        aria-label="Decrease"
                      >
                        <Minus className="h-4 w-4" />
                      </button>
                      <Input
                        type="number"
                        min={0}
                        max={item.quantity_on_hand}
                        value={qty || ""}
                        onChange={(e) => setQty(item.id, Number(e.target.value))}
                        disabled={isOut}
                        className="w-16 h-11 text-center [appearance:textfield]"
                        placeholder="0"
                      />
                      <button
                        onClick={() => setQty(item.id, qty + 1)}
                        disabled={isOut || qty >= item.quantity_on_hand}
                        className={cn(
                          "w-11 h-11 rounded-md border flex items-center justify-center transition-colors",
                          "hover:bg-muted disabled:opacity-40 disabled:cursor-not-allowed"
                        )}
                        aria-label="Increase"
                      >
                        <Plus className="h-4 w-4" />
                      </button>
                      <span className="text-xs text-muted-foreground w-10 text-right">{item.unit}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          <div className="flex items-center justify-between pt-2">
            <Button variant="outline" onClick={() => setStep(1)} className="gap-2">
              <ChevronLeft className="h-4 w-4" />
              {lang === "en" ? "Back" : "பின்"}
            </Button>
            <div className="flex items-center gap-3">
              {cartItems.length > 0 && (
                <span className="text-sm text-muted-foreground">
                  {cartItems.length} {lang === "en" ? "items selected" : "பொருட்கள் தேர்ந்தெடுக்கப்பட்டன"}
                </span>
              )}
              <Button
                onClick={() => setStep(3)}
                disabled={cartItems.length === 0}
                className="gap-2 min-w-[120px]"
              >
                {lang === "en" ? "Review Cart" : "கார்ட்"}
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* ── STEP 3: Review Cart ──────────────────────────────────────────────── */}
      {step === 3 && (
        <div className="space-y-4">
          <div className="border rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="text-left p-3 font-medium">
                    {lang === "en" ? "Item" : "பொருள்"}
                  </th>
                  <th className="text-left p-3 font-medium w-24">
                    {lang === "en" ? "Qty" : "அளவு"}
                  </th>
                  <th className="text-left p-3 font-medium w-24">
                    {lang === "en" ? "Unit" : "அலகு"}
                  </th>
                  <th className="text-left p-3 font-medium">
                    {lang === "en" ? "Notes" : "குறிப்புகள்"}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {cartItems.map((e) => (
                  <tr key={e.itemId}>
                    <td className="p-3 font-medium">{e.item.item_name}</td>
                    <td className="p-3">{e.quantity}</td>
                    <td className="p-3 text-muted-foreground">{e.item.unit}</td>
                    <td className="p-3">
                      <Input
                        placeholder={lang === "en" ? "Optional note" : "விருப்ப குறிப்பு"}
                        value={e.notes}
                        onChange={(ev) => setNotes(e.itemId, ev.target.value)}
                        className="h-8 text-sm"
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="space-y-2">
            <Label>{lang === "en" ? "General Notes" : "பொது குறிப்புகள்"}</Label>
            <Textarea
              value={globalNotes}
              onChange={(e) => setGlobalNotes(e.target.value)}
              placeholder={lang === "en" ? "Any overall notes for this consumption log..." : "குறிப்புகள்..."}
              rows={2}
            />
          </div>

          <p className="text-sm text-muted-foreground">
            {cartItems.length} {lang === "en" ? "items," : "பொருட்கள்,"}{" "}
            {cartItems.reduce((s, e) => s + e.quantity, 0)} {lang === "en" ? "total units" : "மொத்த அலகுகள்"}
          </p>

          <div className="flex items-center justify-between pt-2">
            <Button variant="outline" onClick={() => setStep(2)} className="gap-2">
              <ChevronLeft className="h-4 w-4" />
              {lang === "en" ? "Back" : "பின்"}
            </Button>
            <Button onClick={() => setStep(4)} className="gap-2 min-w-[120px]">
              {lang === "en" ? "Review & Confirm" : "உறுதிப்படுத்து"}
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}

      {/* ── STEP 4: Confirm ──────────────────────────────────────────────────── */}
      {step === 4 && (
        <div className="space-y-4">
          <Card>
            <CardContent className="p-4 space-y-3">
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">
                  {lang === "en" ? "Location" : "இடம்"}
                </span>
                <span className="font-medium">{selectedLocation?.name}</span>
              </div>
              <div className="border-t pt-3">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-muted-foreground">
                      <th className="text-left pb-2 font-normal">
                        {lang === "en" ? "Item" : "பொருள்"}
                      </th>
                      <th className="text-right pb-2 font-normal">
                        {lang === "en" ? "Quantity" : "அளவு"}
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {cartItems.map((e) => (
                      <tr key={e.itemId}>
                        <td className="py-2">{e.item.item_name}</td>
                        <td className="py-2 text-right">
                          {e.quantity} <span className="text-muted-foreground">{e.item.unit}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {globalNotes && (
                <div className="border-t pt-2 text-sm text-muted-foreground">{globalNotes}</div>
              )}
            </CardContent>
          </Card>

          <div className="flex items-center justify-between pt-2">
            <Button variant="outline" onClick={() => setStep(3)} disabled={submitting} className="gap-2">
              <ChevronLeft className="h-4 w-4" />
              {lang === "en" ? "Back" : "பின்"}
            </Button>
            <Button
              onClick={handleSubmit}
              disabled={submitting}
              className="gap-2 min-w-[140px] sm:min-w-[200px]"
            >
              {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
              {lang === "en" ? "Submit Consumption" : "நுகர்வை சமர்ப்பிக்கவும்"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

export default function ConsumptionPage() {
  return (
    <LanguageProvider>
      <ConsumptionPageContent />
    </LanguageProvider>
  );
}
