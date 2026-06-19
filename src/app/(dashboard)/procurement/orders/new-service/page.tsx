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
import { SearchableSelect } from "@/components/ui/searchable-select";
import { toast } from "sonner";
import {
  SERVICE_PO_BILLING_CYCLES, BILLING_CYCLE_LABELS, BILLING_CYCLE_MONTHS,
  PO_ADVANCE_PAYMENT_MODE_LABELS,
} from "@/lib/constants";
import { formatCurrency } from "@/lib/utils";
import type { ProcurementVendor, FacilityAsset } from "@/types";

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
  const [assets, setAssets] = useState<FacilityAsset[]>([]);

  const [vendorId, setVendorId] = useState("");
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

  // AMC fields — pre-activate if URL param ?amc=1
  const isAmcFromUrl = searchParams.get("amc") === "1";
  const [isAmc, setIsAmc] = useState(isAmcFromUrl);
  const [amcContactExpanded, setAmcContactExpanded] = useState(true);
  const [termsExpanded, setTermsExpanded] = useState(false);
  const [amcCoverageType, setAmcCoverageType] = useState<"comprehensive" | "labour_only">("comprehensive");
  const [amcStartDate, setAmcStartDate] = useState("");
  const [amcEndDate, setAmcEndDate] = useState("");
  const [amcUnlimited, setAmcUnlimited] = useState(false);
  const [amcVisitsCovered, setAmcVisitsCovered] = useState("");
  const [amcContactName, setAmcContactName] = useState("");
  const [amcHelpline, setAmcHelpline] = useState("");
  const [amcContactEmail, setAmcContactEmail] = useState("");
  const [amcEscalationName, setAmcEscalationName] = useState("");
  const [amcEscalationPhone, setAmcEscalationPhone] = useState("");
  const [amcEscalation2Name, setAmcEscalation2Name] = useState("");
  const [amcEscalation2Phone, setAmcEscalation2Phone] = useState("");
  const [linkedAssetId, setLinkedAssetId] = useState("");

  function handleAmcStartDateChange(val: string) {
    setAmcStartDate(val);
    setServiceStartDate(val);
    if (val && !amcEndDate) {
      const d = new Date(val);
      d.setFullYear(d.getFullYear() + 1);
      d.setDate(d.getDate() - 1);
      setAmcEndDate(d.toISOString().split("T")[0]);
    }
  }

  function handleAssetSelect(assetId: string) {
    setLinkedAssetId(assetId);
    if (assetId) {
      const asset = assets.find((a) => a.id === assetId);
      if (asset && !customName) {
        setCustomName(`Annual Maintenance Contract — ${asset.name}`);
      }
    }
  }

  const fetchVendors = useCallback(async () => {
    const res = await fetch("/api/procurement/vendors?limit=100");
    if (res.ok) { const j = await res.json(); setVendors(j.data ?? []); }
  }, []);

  const fetchLocations = useCallback(async () => {
    const res = await fetch("/api/locations");
    if (res.ok) { const j = await res.json(); setLocations(j.data ?? []); }
  }, []);

  const fetchAssets = useCallback(async () => {
    const res = await fetch("/api/facility/assets?status=active");
    if (res.ok) { const j = await res.json(); setAssets(j.data ?? []); }
  }, []);

  useEffect(() => {
    fetchVendors();
    fetchLocations();
    fetchAssets();
  }, [fetchVendors, fetchLocations, fetchAssets]);

  const serviceItemName = customName;
  const cycleCountNum = parseInt(cycleCount) || 0;
  const unitCostNum = parseFloat(unitCost) || 0;
  const gstRateNum = parseFloat(gstRate) || 0;
  const totalAmount = cycleCountNum * unitCostNum;
  const gstAmount = Math.round(totalAmount * gstRateNum) / 100;
  const totalWithGst = totalAmount + gstAmount;
  const amcGstAmount = Math.round(unitCostNum * gstRateNum) / 100;
  const amcTotalWithGst = unitCostNum + amcGstAmount;

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

    if (isAmc) {
      if (!linkedAssetId) { toast.error("Select the asset this AMC covers"); return; }
      if (!amcStartDate) { toast.error("Contract start date is required"); return; }
      if (!amcEndDate) { toast.error("Contract end date is required"); return; }
    } else {
      if (!serviceStartDate) { toast.error("Service start date is required"); return; }
      if (cycleCountNum < 1) { toast.error("Number of cycles must be at least 1"); return; }
    }

    if (unitCostNum <= 0) { toast.error(isAmc ? "Annual contract value must be greater than 0" : "Cost per cycle must be greater than 0"); return; }

    if (advanceRequired) {
      if (!advanceAmount || isNaN(parseFloat(advanceAmount)) || parseFloat(advanceAmount) <= 0) {
        toast.error("Advance amount must be a positive number"); return;
      }
      if (!advanceMode) { toast.error("Please select a payment mode for the advance"); return; }
      const poTotal = isAmc ? amcTotalWithGst : totalWithGst;
      if (poTotal > 0 && parseFloat(advanceAmount) > poTotal) {
        toast.error(`Advance amount (${formatCurrency(parseFloat(advanceAmount))}) cannot exceed the PO total (${formatCurrency(poTotal)})`);
        return;
      }
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
          service_start_date: isAmc ? amcStartDate : serviceStartDate,
          billing_cycle: isAmc ? "yearly" : billingCycle,
          cycle_count: isAmc ? 1 : cycleCountNum,
          unit_cost_per_cycle: unitCostNum,
          gst_rate: gstRateNum,
          notes: notes.trim() || undefined,
          payment_terms: paymentTerms.trim() || undefined,
          terms_and_conditions: termsAndConditions.trim() || undefined,
          advance_amount: advanceRequired && advanceAmount ? parseFloat(advanceAmount) : undefined,
          advance_payment_mode: advanceRequired && advanceMode ? advanceMode : undefined,
          advance_payment_reference: advanceRequired && advanceReference.trim() ? advanceReference.trim() : undefined,
          advance_notes: advanceRequired && advanceNotes.trim() ? advanceNotes.trim() : undefined,
          ...(isAmc ? {
            amc_start_date: amcStartDate || undefined,
            amc_end_date: amcEndDate || undefined,
            amc_visits_covered: !amcUnlimited && amcVisitsCovered ? parseInt(amcVisitsCovered) : undefined,
            amc_contact_name: amcContactName || undefined,
            amc_helpline_number: amcHelpline || undefined,
            amc_contact_email: amcContactEmail || undefined,
            amc_escalation_name: amcEscalationName || undefined,
            amc_escalation_phone: amcEscalationPhone || undefined,
            amc_escalation2_name: amcEscalation2Name || undefined,
            amc_escalation2_phone: amcEscalation2Phone || undefined,
            linked_asset_id: linkedAssetId || undefined,
            amc_coverage_type: amcCoverageType,
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

        {/* ── Mode switcher — declare intent first ── */}
        <div className="grid grid-cols-2 gap-3">
          <button
            type="button"
            onClick={() => setIsAmc(false)}
            className={`rounded-lg border-2 px-4 py-3 text-left transition-colors ${
              !isAmc ? "border-primary bg-primary/5" : "border-border hover:border-primary/50"
            }`}
          >
            <p className="text-sm font-semibold">Regular Service</p>
            <p className="text-xs text-muted-foreground mt-0.5">Cleaning, security, generator, etc.</p>
          </button>
          <button
            type="button"
            onClick={() => setIsAmc(true)}
            className={`rounded-lg border-2 px-4 py-3 text-left transition-colors ${
              isAmc ? "border-primary bg-primary/5" : "border-border hover:border-primary/50"
            }`}
          >
            <div className="flex items-center gap-1.5 mb-0.5">
              <Wrench className={`h-3.5 w-3.5 ${isAmc ? "text-primary" : "text-muted-foreground"}`} />
              <p className="text-sm font-semibold">Annual Maintenance Contract</p>
            </div>
            <p className="text-xs text-muted-foreground">AMC for a specific asset (printer, AC, UPS…)</p>
          </button>
        </div>

        {isAmc ? (
          /* ════════════════════════════════════════
             AMC FLOW — asset-first ordering
             ════════════════════════════════════════ */
          <>
            {/* Card 1: Asset & Coverage */}
            <Card className="border-primary/20">
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Asset &amp; Coverage</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-1.5">
                  <Label>Asset being covered *</Label>
                  <SearchableSelect
                    options={assets.map((a) => ({
                      value: a.id,
                      label: `${a.name}${a.asset_code ? ` (${a.asset_code})` : ""}${a.location ? ` — ${(a.location as { name: string }).name}` : ""}`,
                    }))}
                    value={linkedAssetId}
                    onValueChange={handleAssetSelect}
                    placeholder="Select asset"
                    searchPlaceholder="Search assets..."
                    emptyMessage="No assets found."
                  />
                  <p className="text-xs text-muted-foreground">The asset this AMC will cover.</p>
                </div>

                <div className="space-y-1.5">
                  <Label>Coverage Type *</Label>
                  <div className="grid grid-cols-2 gap-3">
                    <button
                      type="button"
                      onClick={() => setAmcCoverageType("comprehensive")}
                      className={`rounded-lg border-2 px-4 py-3 text-left transition-colors ${
                        amcCoverageType === "comprehensive"
                          ? "border-primary bg-primary/5"
                          : "border-border hover:border-primary/50"
                      }`}
                    >
                      <p className="text-sm font-semibold">Comprehensive</p>
                      <p className="text-xs text-muted-foreground mt-0.5">Parts + Labour covered</p>
                    </button>
                    <button
                      type="button"
                      onClick={() => setAmcCoverageType("labour_only")}
                      className={`rounded-lg border-2 px-4 py-3 text-left transition-colors ${
                        amcCoverageType === "labour_only"
                          ? "border-primary bg-primary/5"
                          : "border-border hover:border-primary/50"
                      }`}
                    >
                      <p className="text-sm font-semibold">Labour Only</p>
                      <p className="text-xs text-muted-foreground mt-0.5">Service only, parts excluded</p>
                    </button>
                  </div>
                </div>

                <div className="space-y-1.5">
                  <Label>Service Description *</Label>
                  <Input
                    placeholder="e.g. Annual Maintenance Contract — Dell Laser Printer"
                    value={customName}
                    onChange={(e) => setCustomName(e.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">Auto-filled from asset name — edit if needed.</p>
                </div>
              </CardContent>
            </Card>

            {/* Card 2: Vendor */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Vendor</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-1.5">
                  <Label>Vendor *</Label>
                  <SearchableSelect
                    options={vendors.map((v) => ({ value: v.id, label: v.name }))}
                    value={vendorId}
                    onValueChange={setVendorId}
                    placeholder="Select vendor"
                    searchPlaceholder="Search vendors..."
                    emptyMessage="No vendors found."
                  />
                </div>
              </CardContent>
            </Card>

            {/* Card 3: Contract Period & Cost */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Contract Period &amp; Cost</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <Label>Contract Start Date *</Label>
                    <Input
                      type="date"
                      value={amcStartDate}
                      onChange={(e) => handleAmcStartDateChange(e.target.value)}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Contract End Date *</Label>
                    <Input
                      type="date"
                      value={amcEndDate}
                      min={amcStartDate || undefined}
                      onChange={(e) => setAmcEndDate(e.target.value)}
                    />
                    <p className="text-xs text-muted-foreground">Auto-filled to 1 year — adjust if needed.</p>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <Label>Annual Contract Value (₹) *</Label>
                    <Input
                      type="number"
                      min="0.01"
                      step="0.01"
                      value={unitCost}
                      onChange={(e) => setUnitCost(e.target.value)}
                      placeholder="0.00"
                    />
                    <p className="text-xs text-muted-foreground">Total amount payable to vendor per year.</p>
                  </div>
                  <div className="space-y-1.5">
                    <Label>GST Rate</Label>
                    <Select value={gstRate} onValueChange={setGstRate}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
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
                {unitCostNum > 0 && (
                  <div className="rounded-lg border border-blue-200 bg-blue-50/50 px-3 py-2.5 text-sm text-blue-800 space-y-1">
                    <div className="flex justify-between">
                      <span>Annual Contract Value</span>
                      <strong>{formatCurrency(unitCostNum)}</strong>
                    </div>
                    {gstRateNum > 0 && (
                      <div className="flex justify-between text-blue-700">
                        <span>GST @{gstRateNum}%</span>
                        <span>{formatCurrency(amcGstAmount)}</span>
                      </div>
                    )}
                    <div className="flex justify-between border-t border-blue-200 pt-1 font-semibold">
                      <span>Total{gstRateNum > 0 ? " (incl. GST)" : ""}</span>
                      <span>{formatCurrency(amcTotalWithGst)}</span>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Card 4: AMC Service Contact (collapsible) */}
            <Card>
              <CardHeader
                className="flex flex-row items-center justify-between pb-3 cursor-pointer select-none"
                onClick={() => setAmcContactExpanded((v) => !v)}
              >
                <div className="flex items-center gap-2">
                  <CardTitle className="text-base">Service Contact</CardTitle>
                  <span className="text-xs text-muted-foreground">(recommended)</span>
                </div>
                {amcContactExpanded ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
              </CardHeader>
              {amcContactExpanded && (
                <CardContent className="space-y-4">
                  {(!amcContactName && !amcHelpline) && (
                    <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-800">
                      <AlertTriangle className="h-4 w-4 flex-shrink-0 mt-0.5 text-amber-600" />
                      <span>Add at least one contact detail before issuing the PO. You can save now and update later.</span>
                    </div>
                  )}
                  <div className="space-y-1.5">
                    <Label>Service Visits / Calls Covered</Label>
                    <div className="flex items-center gap-3">
                      <Input
                        type="number"
                        min={1}
                        placeholder="e.g. 4"
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
                  </div>
                  {/* L1 — Primary contact */}
                  <div>
                    <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">L1 — Primary Contact</p>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div className="space-y-1.5">
                        <Label>Name</Label>
                        <Input
                          placeholder="e.g. Rajesh Kumar"
                          value={amcContactName}
                          onChange={(e) => setAmcContactName(e.target.value)}
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label>Phone / Helpline</Label>
                        <Input
                          placeholder="+91 98400 12345"
                          value={amcHelpline}
                          onChange={(e) => setAmcHelpline(e.target.value)}
                        />
                      </div>
                      <div className="space-y-1.5 sm:col-span-2">
                        <Label>Email</Label>
                        <Input
                          type="email"
                          placeholder="amc@vendor.com"
                          value={amcContactEmail}
                          onChange={(e) => setAmcContactEmail(e.target.value)}
                        />
                      </div>
                    </div>
                  </div>

                  {/* L2 — Escalation contact */}
                  <div>
                    <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">L2 — Escalation Contact</p>
                    <p className="text-xs text-muted-foreground mb-2">Call if L1 is unreachable or unresponsive.</p>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div className="space-y-1.5">
                        <Label>Name</Label>
                        <Input
                          placeholder="e.g. Suresh Manager"
                          value={amcEscalationName}
                          onChange={(e) => setAmcEscalationName(e.target.value)}
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label>Phone</Label>
                        <Input
                          placeholder="+91 98400 99999"
                          value={amcEscalationPhone}
                          onChange={(e) => setAmcEscalationPhone(e.target.value)}
                        />
                      </div>
                    </div>
                  </div>

                  {/* L3 — Second escalation */}
                  <div>
                    <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">L3 — Second Escalation</p>
                    <p className="text-xs text-muted-foreground mb-2">Senior point of contact when L2 is also unavailable.</p>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div className="space-y-1.5">
                        <Label>Name</Label>
                        <Input
                          placeholder="e.g. Priya Director"
                          value={amcEscalation2Name}
                          onChange={(e) => setAmcEscalation2Name(e.target.value)}
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label>Phone</Label>
                        <Input
                          placeholder="+91 98400 77777"
                          value={amcEscalation2Phone}
                          onChange={(e) => setAmcEscalation2Phone(e.target.value)}
                        />
                      </div>
                    </div>
                  </div>
                </CardContent>
              )}
            </Card>

            {/* Terms (collapsible optional) */}
            <Card>
              <CardHeader
                className="flex flex-row items-center justify-between pb-3 cursor-pointer select-none"
                onClick={() => setTermsExpanded((v) => !v)}
              >
                <div className="flex items-center gap-2">
                  <CardTitle className="text-base">Terms &amp; Notes</CardTitle>
                  <span className="text-xs text-muted-foreground">(optional)</span>
                </div>
                {termsExpanded ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
              </CardHeader>
              {termsExpanded && (
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
              )}
            </Card>
          </>
        ) : (
          /* ════════════════════════════════════════
             REGULAR SERVICE FLOW — unchanged
             ════════════════════════════════════════ */
          <>
            {/* Service Details */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Service Details</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-1.5">
                  <Label>Vendor *</Label>
                  <SearchableSelect
                    options={vendors.map((v) => ({ value: v.id, label: v.name }))}
                    value={vendorId}
                    onValueChange={setVendorId}
                    placeholder="Select vendor"
                    searchPlaceholder="Search vendors..."
                    emptyMessage="No vendors found."
                  />
                </div>

                <div className="space-y-1.5">
                  <Label>Service Description *</Label>
                  <Input
                    placeholder="e.g. Generator Maintenance, Security Service..."
                    value={customName}
                    onChange={(e) => setCustomName(e.target.value)}
                  />
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
                      <SelectTrigger><SelectValue /></SelectTrigger>
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

                {unitCostNum > 0 && (
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
          </>
        )}

        {/* Advance Payment — both modes */}
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
                    />
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
