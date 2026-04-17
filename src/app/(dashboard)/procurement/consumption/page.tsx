"use client";

import { useState, useEffect, useCallback } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { Globe, Search, AlertTriangle, ArrowRight, Loader2 } from "lucide-react";
import { t } from "@/lib/translations";
import { useLanguage, LanguageProvider } from "@/providers/language-provider";
import { PROCUREMENT_DEPARTMENTS, PROCUREMENT_DEPARTMENT_LABELS } from "@/lib/constants";
import Link from "next/link";

interface Location {
  id: string;
  name: string;
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

interface ConsumptionEntry {
  quantity: string;
  notes: string;
}

function ConsumptionPageContent() {
  const { lang, toggleLang } = useLanguage();
  const [locations, setLocations] = useState<Location[]>([]);
  const [selectedLocation, setSelectedLocation] = useState("");
  const [department, setDepartment] = useState("all");
  const [search, setSearch] = useState("");
  const [items, setItems] = useState<InventoryItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [entries, setEntries] = useState<Record<string, ConsumptionEntry>>({});
  const [showConfirm, setShowConfirm] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [globalNotes, setGlobalNotes] = useState("");

  useEffect(() => {
    fetch("/api/locations")
      .then((r) => r.json())
      .then((data) => {
        const locs = data.data || data.locations || [];
        setLocations(Array.isArray(locs) ? locs : []);
        if (locs.length > 0) setSelectedLocation(locs[0].id);
      })
      .catch(() => toast.error("Failed to load locations"));
  }, []);

  const fetchInventory = useCallback(async () => {
    if (!selectedLocation) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/procurement/inventory?location_id=${selectedLocation}`);
      const data = await res.json();
      const rows = data.data || [];
      setItems(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        rows.map((row: any) => ({
          id: row.id,
          item_id: row.item_id,
          item_name: row.procurement_items?.name ?? "Unknown",
          department: row.procurement_items?.department ?? "",
          unit: row.procurement_items?.unit ?? "",
          quantity_on_hand: Number(row.quantity_on_hand) || 0,
          reorder_level: Number(row.reorder_level) || 0,
        }))
      );
      setEntries({});
    } catch {
      toast.error("Failed to load inventory");
    } finally {
      setLoading(false);
    }
  }, [selectedLocation]);

  useEffect(() => {
    fetchInventory();
  }, [fetchInventory]);

  const updateEntry = (itemId: string, field: keyof ConsumptionEntry, value: string) => {
    setEntries((prev) => ({
      ...prev,
      [itemId]: { ...prev[itemId], [field]: value },
    }));
  };

  const filteredItems = items.filter((item) => {
    if (department !== "all" && item.department !== department) return false;
    if (search && !item.item_name.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  const itemsWithQty = Object.entries(entries)
    .filter(([, e]) => e.quantity && parseFloat(e.quantity) > 0)
    .map(([itemId, e]) => {
      const item = items.find((i) => i.id === itemId);
      return { itemId, item, quantity: parseFloat(e.quantity), notes: e.notes };
    })
    .filter((e) => e.item);

  const hasEntries = itemsWithQty.length > 0;

  const handleSubmit = async () => {
    setSubmitting(true);
    try {
      const res = await fetch("/api/procurement/consumption", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          location_id: selectedLocation,
          notes: globalNotes || undefined,
          items: itemsWithQty.map((e) => ({
            item_id: e.item!.item_id,
            item_name: e.item!.item_name,
            unit: e.item!.unit,
            quantity_consumed: e.quantity,
            notes: e.notes || undefined,
          })),
        }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to log consumption");

      toast.success(t("status.success", lang));
      setShowConfirm(false);
      setEntries({});
      setGlobalNotes("");
      fetchInventory();

      if (data.reorder_alerts && data.reorder_alerts.length > 0) {
        const alertItems = data.reorder_alerts.map((a: { item_name: string }) => a.item_name).join(", ");
        toast.warning(`${data.reorder_alerts.length} ${t("status.reorder_alert", lang)}: ${alertItems}`, {
          duration: 8000,
        });
      }
      if (data.stock_warnings && data.stock_warnings.length > 0) {
        toast.warning(
          `Stock discrepancy noted — ${data.stock_warnings.length} item(s) consumed beyond system stock. Please verify delivery receipts are linked to this location.`,
          { duration: 10000 }
        );
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("status.error", lang));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Top bar */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{t("page.title", lang)}</h1>
          <p className="text-muted-foreground">{t("page.subtitle", lang)}</p>
        </div>
        <div className="flex items-center gap-3">
          <Link
            href="/procurement/consumption/history"
            className="text-sm text-muted-foreground hover:text-foreground flex items-center gap-1"
          >
            {lang === "en" ? "View History" : "வரலாற்றை காண"}
            <ArrowRight className="h-3.5 w-3.5" />
          </Link>
          <Button variant="outline" size="sm" onClick={toggleLang}>
            <Globe className="h-4 w-4 mr-1.5" />
            {lang === "en" ? t("lang.tamil", lang) : t("lang.english", lang)}
          </Button>
        </div>
      </div>

      {/* Location selector */}
      <div className="flex items-center gap-4 flex-wrap">
        <div className="w-64">
          <Label className="text-sm mb-1.5 block">{t("filter.location", lang)}</Label>
          <Select value={selectedLocation} onValueChange={setSelectedLocation}>
            <SelectTrigger>
              <SelectValue placeholder={t("filter.location", lang)} />
            </SelectTrigger>
            <SelectContent>
              {locations.map((loc) => (
                <SelectItem key={loc.id} value={loc.id}>
                  {loc.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Department tabs + Search */}
      <div className="flex items-center gap-4 flex-wrap">
        <Tabs value={department} onValueChange={setDepartment}>
          <TabsList>
            <TabsTrigger value="all">{t("filter.all", lang)}</TabsTrigger>
            {PROCUREMENT_DEPARTMENTS.map((dept) => (
              <TabsTrigger key={dept} value={dept}>
                {PROCUREMENT_DEPARTMENT_LABELS[dept]}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder={t("filter.search", lang)}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
      </div>

      {/* Inventory items */}
      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : filteredItems.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            {t("status.no_items", lang)}
          </CardContent>
        </Card>
      ) : (
        <div className="border rounded-lg overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="text-left p-3 font-medium">{t("table.item_name", lang)}</th>
                  <th className="text-left p-3 font-medium">{t("table.available", lang)}</th>
                  <th className="text-left p-3 font-medium w-32">{t("table.consume_qty", lang)}</th>
                  <th className="text-left p-3 font-medium w-48">{t("table.notes", lang)}</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {filteredItems.map((item) => {
                  const isOutOfStock = item.quantity_on_hand === 0;
                  const isBelowReorder = item.quantity_on_hand > 0 && item.quantity_on_hand <= item.reorder_level;
                  const enteredQty = parseFloat(entries[item.id]?.quantity || "0") || 0;
                  const exceedsStock = enteredQty > item.quantity_on_hand && item.quantity_on_hand > 0;
                  return (
                    <tr
                      key={item.id}
                      className={isOutOfStock ? "bg-muted/20" : ""}
                    >
                      <td className="p-3">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span>{item.item_name}</span>
                          {isBelowReorder && (
                            <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />
                          )}
                          {isOutOfStock && (
                            <span className="text-[10px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
                              system: 0 stock
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="p-3">
                        <span className={isBelowReorder ? "text-amber-600 font-medium" : isOutOfStock ? "text-muted-foreground" : ""}>
                          {item.quantity_on_hand}
                        </span>
                        <span className="text-muted-foreground ml-1 text-xs">{item.unit}</span>
                      </td>
                      <td className="p-3">
                        <Input
                          type="number"
                          min={0}
                          step="any"
                          placeholder="0"
                          value={entries[item.id]?.quantity || ""}
                          onChange={(e) => updateEntry(item.id, "quantity", e.target.value)}
                          className={`h-8 ${exceedsStock ? "border-amber-400" : ""}`}
                        />
                        {exceedsStock && (
                          <p className="text-[10px] text-amber-600 mt-0.5">Exceeds tracked stock</p>
                        )}
                      </td>
                      <td className="p-3">
                        <Input
                          placeholder={t("table.notes", lang)}
                          value={entries[item.id]?.notes || ""}
                          onChange={(e) => updateEntry(item.id, "notes", e.target.value)}
                          className="h-8"
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Footer */}
      <div className="flex items-center justify-between">
        <Button
          variant="outline"
          size="sm"
          onClick={() => setEntries({})}
          disabled={!hasEntries}
        >
          {t("action.clear", lang)}
        </Button>
        <Button
          onClick={() => setShowConfirm(true)}
          disabled={!hasEntries}
        >
          {t("action.log", lang)}
        </Button>
      </div>

      {/* Confirmation Dialog */}
      <Dialog open={showConfirm} onOpenChange={setShowConfirm}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("confirm.title", lang)}</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">{t("confirm.message", lang)}</p>

          <div className="border rounded-lg overflow-hidden my-2">
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="text-left p-2 font-medium">{t("confirm.item", lang)}</th>
                  <th className="text-left p-2 font-medium">{t("confirm.quantity", lang)}</th>
                  <th className="text-left p-2 font-medium">{t("table.unit", lang)}</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {itemsWithQty.map((e) => (
                  <tr key={e.itemId}>
                    <td className="p-2">{e.item!.item_name}</td>
                    <td className="p-2 font-medium">{e.quantity}</td>
                    <td className="p-2 text-muted-foreground">{e.item!.unit}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="space-y-2">
            <Label>{t("general.notes", lang)}</Label>
            <Textarea
              value={globalNotes}
              onChange={(e) => setGlobalNotes(e.target.value)}
              placeholder={t("general.notes", lang)}
              rows={2}
            />
          </div>

          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="outline" onClick={() => setShowConfirm(false)} disabled={submitting}>
              {t("action.cancel", lang)}
            </Button>
            <Button onClick={handleSubmit} disabled={submitting}>
              {submitting && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}
              {t("action.confirm", lang)}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
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
