"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { ChevronLeft, Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import {
  SERVICE_PO_BILLING_CYCLES, BILLING_CYCLE_LABELS, BILLING_CYCLE_MONTHS,
} from "@/lib/constants";
import { formatCurrency } from "@/lib/utils";
import type { ProcurementVendor, ProcurementItem } from "@/types";

function addMonths(dateStr: string, months: number): string {
  const d = new Date(dateStr);
  d.setMonth(d.getMonth() + months);
  return d.toISOString().split("T")[0];
}

function getCycleEndDate(start: string, cycle: string): string {
  const months = BILLING_CYCLE_MONTHS[cycle] ?? 1;
  const d = new Date(start);
  d.setMonth(d.getMonth() + months);
  d.setDate(d.getDate() - 1);
  return d.toISOString().split("T")[0];
}

export default function NewServicePOPage() {
  const router = useRouter();
  const [saving, setSaving] = useState(false);

  const [vendors, setVendors] = useState<ProcurementVendor[]>([]);
  const [serviceItems, setServiceItems] = useState<ProcurementItem[]>([]);

  const [vendorId, setVendorId] = useState("");
  const [itemId, setItemId] = useState("");
  const [customName, setCustomName] = useState("");
  const [locationId, setLocationId] = useState("");
  const [locations, setLocations] = useState<{ id: string; name: string }[]>([]);
  const [serviceStartDate, setServiceStartDate] = useState(new Date().toISOString().split("T")[0]);
  const [billingCycle, setBillingCycle] = useState<string>("monthly");
  const [cycleCount, setCycleCount] = useState("12");
  const [unitCost, setUnitCost] = useState("");
  const [notes, setNotes] = useState("");
  const [paymentTerms, setPaymentTerms] = useState("");
  const [termsAndConditions, setTermsAndConditions] = useState("");

  const fetchVendors = useCallback(async () => {
    const res = await fetch("/api/procurement/vendors?limit=100");
    if (res.ok) { const j = await res.json(); setVendors(j.data ?? []); }
  }, []);

  const fetchServiceItems = useCallback(async () => {
    const res = await fetch("/api/procurement/items?item_type=service&include_inactive=false");
    if (res.ok) { const j = await res.json(); setServiceItems(j.data ?? []); }
  }, []);

  const fetchLocations = useCallback(async () => {
    const res = await fetch("/api/locations");
    if (res.ok) { const j = await res.json(); setLocations(j.data ?? []); }
  }, []);

  useEffect(() => {
    fetchVendors();
    fetchServiceItems();
    fetchLocations();
  }, [fetchVendors, fetchServiceItems, fetchLocations]);

  const selectedItem = serviceItems.find((i) => i.id === itemId);
  const serviceItemName = selectedItem?.name ?? customName;
  const cycleCountNum = parseInt(cycleCount) || 0;
  const unitCostNum = parseFloat(unitCost) || 0;
  const totalAmount = cycleCountNum * unitCostNum;

  // Build cycle schedule preview
  const cycleSchedule = (() => {
    if (!serviceStartDate || !billingCycle || cycleCountNum <= 0) return [];
    const months = BILLING_CYCLE_MONTHS[billingCycle] ?? 1;
    return Array.from({ length: Math.min(cycleCountNum, 6) }, (_, i) => {
      const from = addMonths(serviceStartDate, i * months);
      const to = getCycleEndDate(from, billingCycle);
      return { cycle: i + 1, from, to };
    });
  })();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!vendorId) { toast.error("Vendor is required"); return; }
    if (!serviceItemName.trim()) { toast.error("Service description is required"); return; }
    if (!serviceStartDate) { toast.error("Service start date is required"); return; }
    if (cycleCountNum < 1) { toast.error("Number of cycles must be at least 1"); return; }
    if (unitCostNum <= 0) { toast.error("Cost per cycle must be greater than 0"); return; }

    setSaving(true);
    try {
      const res = await fetch("/api/procurement/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          po_type: "service",
          vendor_id: vendorId,
          location_id: locationId || undefined,
          service_item_name: serviceItemName.trim(),
          item_id: itemId || undefined,
          service_start_date: serviceStartDate,
          billing_cycle: billingCycle,
          cycle_count: cycleCountNum,
          unit_cost_per_cycle: unitCostNum,
          notes: notes.trim() || undefined,
          payment_terms: paymentTerms.trim() || undefined,
          terms_and_conditions: termsAndConditions.trim() || undefined,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        const err = typeof json.error === "string" ? json.error : Object.values(json.error ?? {}).flat().join(", ");
        toast.error(err || "Failed to create service PO");
        return;
      }
      toast.success(`Service PO created — ${json.data.po_number}`);
      router.push(`/procurement/orders/${json.data.id}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={() => router.push("/procurement/orders")}>
          <ChevronLeft className="h-5 w-5" />
        </Button>
        <div>
          <h1 className="text-2xl font-bold">New Service PO</h1>
          <p className="text-sm text-muted-foreground">Authorize a recurring service contract</p>
        </div>
      </div>

      <form onSubmit={handleSubmit} className="space-y-6">
        {/* Service Details */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Service Details</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <Label>Vendor *</Label>
              <Select value={vendorId} onValueChange={setVendorId}>
                <SelectTrigger><SelectValue placeholder="Select vendor" /></SelectTrigger>
                <SelectContent>
                  {vendors.map((v) => (
                    <SelectItem key={v.id} value={v.id}>{v.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label>Service Item *</Label>
              <Select value={itemId} onValueChange={(v) => { setItemId(v === "_custom" ? "" : v); setCustomName(""); }}>
                <SelectTrigger><SelectValue placeholder="Select from catalog or type below" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="_custom">— Enter custom name —</SelectItem>
                  {serviceItems.map((i) => (
                    <SelectItem key={i.id} value={i.id}>{i.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {!itemId && (
                <Input
                  placeholder="e.g. Generator Maintenance, Security Service..."
                  value={customName}
                  onChange={(e) => setCustomName(e.target.value)}
                  className="mt-1.5"
                />
              )}
            </div>

            <div className="space-y-1.5">
              <Label>Location</Label>
              <Select value={locationId} onValueChange={(v) => setLocationId(v === "_all" ? "" : v)}>
                <SelectTrigger><SelectValue placeholder="All locations" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="_all">All locations</SelectItem>
                  {locations.map((l) => (
                    <SelectItem key={l.id} value={l.id}>{l.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </CardContent>
        </Card>

        {/* Schedule & Cost */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Schedule &amp; Cost</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label>Service Start Date *</Label>
                <Input
                  type="date"
                  value={serviceStartDate}
                  onChange={(e) => setServiceStartDate(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label>Billing Cycle *</Label>
                <Select value={billingCycle} onValueChange={setBillingCycle}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {SERVICE_PO_BILLING_CYCLES.map((c) => (
                      <SelectItem key={c} value={c}>{BILLING_CYCLE_LABELS[c]}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Number of Cycles *</Label>
                <Input
                  type="number"
                  min="1"
                  value={cycleCount}
                  onChange={(e) => setCycleCount(e.target.value)}
                  placeholder="e.g. 12"
                />
              </div>
              <div className="space-y-1.5">
                <Label>Cost per Cycle (₹) *</Label>
                <Input
                  type="number"
                  min="0.01"
                  step="0.01"
                  value={unitCost}
                  onChange={(e) => setUnitCost(e.target.value)}
                  placeholder="0.00"
                />
              </div>
            </div>

            {totalAmount > 0 && (
              <div className="rounded-lg border border-blue-200 bg-blue-50/50 px-3 py-2.5 text-sm text-blue-800">
                Total contract value: <strong>{formatCurrency(totalAmount)}</strong>
                {" "}({cycleCountNum} × {formatCurrency(unitCostNum)})
              </div>
            )}

            {/* Cycle schedule preview */}
            {cycleSchedule.length > 0 && (
              <div>
                <p className="text-xs font-medium text-muted-foreground mb-2 flex items-center gap-1">
                  <Info className="h-3 w-3" /> Expected cycle schedule (first {cycleSchedule.length} of {cycleCountNum})
                </p>
                <div className="rounded-md border overflow-hidden text-xs">
                  <table className="w-full">
                    <thead className="bg-muted/40">
                      <tr>
                        <th className="px-3 py-2 text-left font-medium">Cycle</th>
                        <th className="px-3 py-2 text-left font-medium">From</th>
                        <th className="px-3 py-2 text-left font-medium">To</th>
                        <th className="px-3 py-2 text-right font-medium">Amount</th>
                      </tr>
                    </thead>
                    <tbody>
                      {cycleSchedule.map((c) => (
                        <tr key={c.cycle} className="border-t">
                          <td className="px-3 py-1.5">Cycle {c.cycle}</td>
                          <td className="px-3 py-1.5 text-muted-foreground">{c.from}</td>
                          <td className="px-3 py-1.5 text-muted-foreground">{c.to}</td>
                          <td className="px-3 py-1.5 text-right">{unitCostNum > 0 ? formatCurrency(unitCostNum) : "—"}</td>
                        </tr>
                      ))}
                      {cycleCountNum > 6 && (
                        <tr className="border-t bg-muted/20">
                          <td colSpan={4} className="px-3 py-1.5 text-center text-muted-foreground">
                            +{cycleCountNum - 6} more cycles...
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Terms */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Terms &amp; Notes</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <Label>Payment Terms</Label>
              <Input value={paymentTerms} onChange={(e) => setPaymentTerms(e.target.value)} placeholder="e.g. Net 30" />
            </div>
            <div className="space-y-1.5">
              <Label>Notes</Label>
              <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} placeholder="Internal notes..." />
            </div>
            <div className="space-y-1.5">
              <Label>Terms &amp; Conditions</Label>
              <Textarea value={termsAndConditions} onChange={(e) => setTermsAndConditions(e.target.value)} rows={3} placeholder="Contract terms..." />
            </div>
          </CardContent>
        </Card>

        <div className="flex justify-end gap-3">
          <Button type="button" variant="outline" onClick={() => router.push("/procurement/orders")}>
            Cancel
          </Button>
          <Button type="submit" disabled={saving}>
            {saving ? "Creating..." : "Create Service PO"}
          </Button>
        </div>
      </form>
    </div>
  );
}
