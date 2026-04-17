"use client";

import { useState, useEffect, useCallback, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ChevronLeft, Info, ChevronDown, ChevronUp, Wrench, AlertTriangle } from "lucide-react";
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
  PO_ADVANCE_PAYMENT_MODE_LABELS,
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

function NewServicePOForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
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
  const [gstRate, setGstRate] = useState("18");
  const [notes, setNotes] = useState("");
  const [paymentTerms, setPaymentTerms] = useState("");
  const [termsAndConditions, setTermsAndConditions] = useState("");

  // Advance payment
  const [advanceRequired, setAdvanceRequired] = useState(false);
  const [advanceExpanded, setAdvanceExpanded] = useState(false);
  const [advanceAmount, setAdvanceAmount] = useState("");
  const [advanceMode, setAdvanceMode] = useState("");
  const [advanceReference, setAdvanceReference] = useState("");
  const [advanceNotes, setAdvanceNotes] = useState("");

  // AMC fields — pre-expand if URL param ?amc=1
  const isAmcFromUrl = searchParams.get("amc") === "1";
  const [isAmc, setIsAmc] = useState(isAmcFromUrl);
  const [amcExpanded, setAmcExpanded] = useState(isAmcFromUrl);
  const [amcStartDate, setAmcStartDate] = useState("");
  const [amcEndDate, setAmcEndDate] = useState("");
  const [amcUnlimited, setAmcUnlimited] = useState(false);
  const [amcVisitsCovered, setAmcVisitsCovered] = useState("");
  const [amcContactName, setAmcContactName] = useState("");
  const [amcHelpline, setAmcHelpline] = useState("");
  const [amcContactEmail, setAmcContactEmail] = useState("");

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
  const gstRateNum = parseFloat(gstRate) || 0;
  const totalAmount = cycleCountNum * unitCostNum;
  const gstAmount = Math.round(totalAmount * gstRateNum) / 100;
  const totalWithGst = totalAmount + gstAmount;

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
    if (advanceRequired) {
      if (!advanceAmount || isNaN(parseFloat(advanceAmount)) || parseFloat(advanceAmount) <= 0) {
        toast.error("Advance amount must be a positive number"); return;
      }
      if (!advanceMode) { toast.error("Please select a payment mode for the advance"); return; }
      if (totalWithGst > 0 && parseFloat(advanceAmount) > totalWithGst) {
        toast.error(`Advance amount (${formatCurrency(parseFloat(advanceAmount))}) cannot exceed the PO total (${formatCurrency(totalWithGst)})`);
        return;
      }
    }

    // AMC warning (non-blocking)
    if (isAmc && (!amcStartDate || (!amcContactName && !amcHelpline))) {
      // Show warning but allow user to still submit after confirmation
      const proceed = window.confirm(
        "⚠ AMC details are incomplete.\n\n" +
        (!amcStartDate ? "• Contract start date is not set\n" : "") +
        (!amcContactName && !amcHelpline ? "• No AMC contact details provided\n" : "") +
        "\nProceed anyway? (You can add these details later from the PO page.)"
      );
      if (!proceed) return;
    }

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
          gst_rate: gstRateNum,
          notes: notes.trim() || undefined,
          payment_terms: paymentTerms.trim() || undefined,
          terms_and_conditions: termsAndConditions.trim() || undefined,
          advance_amount: advanceRequired && advanceAmount ? parseFloat(advanceAmount) : undefined,
          advance_payment_mode: advanceRequired && advanceMode ? advanceMode : undefined,
          advance_payment_reference: advanceRequired && advanceReference.trim() ? advanceReference.trim() : undefined,
          advance_notes: advanceRequired && advanceNotes.trim() ? advanceNotes.trim() : undefined,
          // AMC fields
          ...(isAmc ? {
            amc_start_date: amcStartDate || undefined,
            amc_end_date: amcEndDate || undefined,
            amc_visits_covered: !amcUnlimited && amcVisitsCovered ? parseInt(amcVisitsCovered) : undefined,
            amc_contact_name: amcContactName || undefined,
            amc_helpline_number: amcHelpline || undefined,
            amc_contact_email: amcContactEmail || undefined,
          } : {}),
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
              <div className="space-y-1.5">
                <Label>GST Rate</Label>
                <Select value={gstRate} onValueChange={setGstRate}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="0">0% (Exempt)</SelectItem>
                    <SelectItem value="5">5%</SelectItem>
                    <SelectItem value="12">12%</SelectItem>
                    <SelectItem value="18">18%</SelectItem>
                    <SelectItem value="28">28%</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            {totalAmount > 0 && (
              <div className="rounded-lg border border-blue-200 bg-blue-50/50 px-3 py-2.5 text-sm text-blue-800 space-y-1">
                <div className="flex justify-between">
                  <span>Subtotal ({cycleCountNum} × {formatCurrency(unitCostNum)})</span>
                  <strong>{formatCurrency(totalAmount)}</strong>
                </div>
                {gstRateNum > 0 && (
                  <div className="flex justify-between text-blue-700">
                    <span>GST @{gstRateNum}%</span>
                    <span>{formatCurrency(gstAmount)}</span>
                  </div>
                )}
                <div className="flex justify-between border-t border-blue-200 pt-1 font-semibold">
                  <span>Total{gstRateNum > 0 ? " (incl. GST)" : ""}</span>
                  <span>{formatCurrency(totalWithGst)}</span>
                </div>
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

        {/* AMC Contract Details */}
        <Card className={isAmc ? "border-blue-200" : ""}>
          <CardHeader
            className="flex flex-row items-center justify-between pb-3 cursor-pointer select-none"
            onClick={() => setAmcExpanded((v) => !v)}
          >
            <div className="flex items-center gap-2">
              <Wrench className={`h-4 w-4 ${isAmc ? "text-blue-600" : "text-muted-foreground"}`} />
              <CardTitle className="text-base">AMC Contract</CardTitle>
              {isAmc && <span className="text-xs text-blue-600 font-medium bg-blue-50 px-2 py-0.5 rounded-full">Enabled</span>}
              {!isAmc && <span className="text-xs text-muted-foreground">(optional — for AMC / maintenance contracts)</span>}
            </div>
            {amcExpanded ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
          </CardHeader>
          {amcExpanded && (
            <CardContent className="space-y-4">
              {/* Toggle */}
              <div className="flex items-center gap-2">
                <input
                  id="is_amc"
                  type="checkbox"
                  checked={isAmc}
                  onChange={(e) => setIsAmc(e.target.checked)}
                  className="h-4 w-4 rounded border-gray-300"
                />
                <label htmlFor="is_amc" className="text-sm cursor-pointer font-medium">
                  This is an AMC / Annual Maintenance Contract
                </label>
              </div>

              {isAmc && (
                <div className="space-y-4 pt-2 border-t">
                  {/* Warning if incomplete */}
                  {(!amcStartDate || (!amcContactName && !amcHelpline)) && (
                    <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-800">
                      <AlertTriangle className="h-4 w-4 flex-shrink-0 mt-0.5 text-amber-600" />
                      <span>
                        Complete AMC details before issuing the PO.
                        {!amcStartDate && " Start date is missing."}
                        {!amcContactName && !amcHelpline && " Contact details are missing."}
                        {" "}You can still save now and update later.
                      </span>
                    </div>
                  )}

                  {/* Contract period */}
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1.5">
                      <Label>Contract Start Date</Label>
                      <Input
                        type="date"
                        value={amcStartDate}
                        onChange={(e) => setAmcStartDate(e.target.value)}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label>Contract End Date</Label>
                      <Input
                        type="date"
                        value={amcEndDate}
                        onChange={(e) => setAmcEndDate(e.target.value)}
                      />
                    </div>
                  </div>

                  {/* Visits covered */}
                  <div className="space-y-1.5">
                    <Label>Visits / Calls Covered</Label>
                    <div className="flex items-center gap-3">
                      <Input
                        type="number"
                        min={1}
                        placeholder="e.g. 12"
                        value={amcUnlimited ? "" : amcVisitsCovered}
                        onChange={(e) => setAmcVisitsCovered(e.target.value)}
                        disabled={amcUnlimited}
                        className="w-32"
                      />
                      <label className="flex items-center gap-1.5 text-sm cursor-pointer select-none">
                        <input
                          type="checkbox"
                          checked={amcUnlimited}
                          onChange={(e) => {
                            setAmcUnlimited(e.target.checked);
                            if (e.target.checked) setAmcVisitsCovered("");
                          }}
                          className="rounded"
                        />
                        Unlimited
                      </label>
                    </div>
                    <p className="text-xs text-muted-foreground">How many visits / support calls does this AMC cover in total?</p>
                  </div>

                  {/* Contact details */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div className="space-y-1.5">
                      <Label>AMC Contact Name</Label>
                      <Input
                        placeholder="e.g. Rajesh Kumar"
                        value={amcContactName}
                        onChange={(e) => setAmcContactName(e.target.value)}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label>Helpline / Support Number</Label>
                      <Input
                        placeholder="+91 98400 12345"
                        value={amcHelpline}
                        onChange={(e) => setAmcHelpline(e.target.value)}
                      />
                    </div>
                    <div className="space-y-1.5 sm:col-span-2">
                      <Label>AMC Contact Email</Label>
                      <Input
                        type="email"
                        placeholder="amc@vendor.com"
                        value={amcContactEmail}
                        onChange={(e) => setAmcContactEmail(e.target.value)}
                      />
                    </div>
                  </div>
                </div>
              )}
            </CardContent>
          )}
        </Card>

        {/* Advance Payment */}
        <Card>
          <CardHeader
            className="flex flex-row items-center justify-between pb-3 cursor-pointer select-none"
            onClick={() => setAdvanceExpanded((v) => !v)}
          >
            <div className="flex items-center gap-2">
              <CardTitle className="text-base">Advance Payment</CardTitle>
              <span className="text-xs text-muted-foreground">(optional)</span>
            </div>
            {advanceExpanded ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
          </CardHeader>
          {advanceExpanded && (
            <CardContent className="space-y-4">
              <div className="flex items-center gap-2">
                <input
                  id="advance_required"
                  type="checkbox"
                  checked={advanceRequired}
                  onChange={(e) => {
                    setAdvanceRequired(e.target.checked);
                    if (!e.target.checked) {
                      setAdvanceAmount("");
                      setAdvanceMode("");
                      setAdvanceReference("");
                      setAdvanceNotes("");
                    }
                  }}
                  className="h-4 w-4 rounded border-gray-300"
                />
                <Label htmlFor="advance_required" className="cursor-pointer">Advance payment required for this order</Label>
              </div>

              {advanceRequired && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-2 border-t">
                  <div className="space-y-1.5">
                    <Label htmlFor="advance_amount">Advance Amount (₹) <span className="text-red-500">*</span></Label>
                    <Input
                      id="advance_amount"
                      type="number"
                      min="0.01"
                      step="0.01"
                      placeholder="e.g. 5000"
                      value={advanceAmount}
                      onChange={(e) => setAdvanceAmount(e.target.value)}
                      className={totalWithGst > 0 && parseFloat(advanceAmount) > totalWithGst ? "border-red-400 focus-visible:ring-red-400" : ""}
                    />
                    {totalWithGst > 0 && parseFloat(advanceAmount) > 0 && parseFloat(advanceAmount) > totalWithGst && (
                      <p className="text-xs text-red-600 mt-0.5">
                        Exceeds PO total ({formatCurrency(totalWithGst)})
                      </p>
                    )}
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="advance_mode">Payment Mode <span className="text-red-500">*</span></Label>
                    <Select value={advanceMode || "__none__"} onValueChange={(v) => setAdvanceMode(v === "__none__" ? "" : v)}>
                      <SelectTrigger id="advance_mode">
                        <SelectValue placeholder="Select mode…" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__none__">Select mode…</SelectItem>
                        {Object.entries(PO_ADVANCE_PAYMENT_MODE_LABELS).map(([k, label]) => (
                          <SelectItem key={k} value={k}>{label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="advance_reference">Reference No.</Label>
                    <Input
                      id="advance_reference"
                      placeholder="e.g. NEFT/20250318/001"
                      value={advanceReference}
                      onChange={(e) => setAdvanceReference(e.target.value)}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="advance_notes">Notes</Label>
                    <Input
                      id="advance_notes"
                      placeholder="Any notes about this advance…"
                      value={advanceNotes}
                      onChange={(e) => setAdvanceNotes(e.target.value)}
                    />
                  </div>
                </div>
              )}
            </CardContent>
          )}
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

export default function NewServicePOPage() {
  return (
    <Suspense fallback={
      <div className="flex items-center justify-center h-64">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
      </div>
    }>
      <NewServicePOForm />
    </Suspense>
  );
}
