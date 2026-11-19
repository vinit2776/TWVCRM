"use client";

import { PackageTip } from "@/components/packages/package-tips";
import { useState, useEffect, useRef, useCallback } from "react";
import { Loader2, Search, Users, User, Link2 } from "lucide-react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { formatCurrency, formatDate } from "@/lib/utils";
import { useLocations } from "@/hooks/use-locations";
import { addDaysToDate, istDateString } from "@/lib/prepaid";
import { CREDIT_TYPE_LABELS } from "@/lib/constants";
import type { PrepaidPackage } from "@/types";

interface SellPackageDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
  /** Optional: pre-select a specific package */
  preselectedPackageId?: string;
  /** Optional: restrict packages list to this location */
  locationId?: string;
}

interface LeadSuggestion {
  id: string;
  name: string;
  phone?: string;
  email?: string;
  company?: string;
}

const PAYMENT_MODES = [
  { value: "cash", label: "Cash" },
  { value: "upi", label: "UPI" },
  { value: "card", label: "Card" },
  { value: "payment_link", label: "Send Payment Link" },
];

export function SellPackageDialog({
  open,
  onOpenChange,
  onSuccess,
  preselectedPackageId,
  locationId,
}: SellPackageDialogProps) {
  const [packages, setPackages] = useState<PrepaidPackage[]>([]);
  const [packagesLoading, setPackagesLoading] = useState(false);

  const [packageId, setPackageId] = useState(preselectedPackageId || "");
  const [selectedPackage, setSelectedPackage] = useState<PrepaidPackage | null>(null);

  // Terms agreed at the point of sale
  const { locations } = useLocations();
  const [selectedLocationIds, setSelectedLocationIds] = useState<string[]>(locationId ? [locationId] : []);
  const [validityDays, setValidityDays] = useState("30");
  const [windowHours, setWindowHours] = useState("2");
  const [noRestore, setNoRestore] = useState(false);

  // Customer search
  const [customerQuery, setCustomerQuery] = useState("");
  const [suggestions, setSuggestions] = useState<LeadSuggestion[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [selectedLead, setSelectedLead] = useState<LeadSuggestion | null>(null);
  const suggestionsRef = useRef<HTMLDivElement>(null);
  const searchTimeout = useRef<NodeJS.Timeout | null>(null);

  // Gap 4: Scope — "individual" or "company"
  const [scope, setScope] = useState<"individual" | "company">("individual");
  const [companyName, setCompanyName] = useState("");

  // Gap 4: Contract lookup for informational note
  const [contractNote, setContractNote] = useState<string | null>(null);

  // Gap 2: Payment mode
  const [paymentMode, setPaymentMode] = useState("cash");
  const [paymentReference, setPaymentReference] = useState("");
  // Payment link notify options
  const [notifySms, setNotifySms] = useState(true);
  const [notifyEmail, setNotifyEmail] = useState(true);

  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);

  // Fetch packages when dialog opens
  useEffect(() => {
    if (!open) return;
    setPackagesLoading(true);
    const params = new URLSearchParams({ is_active: "true" });
    if (locationId) params.set("location_id", locationId);
    fetch(`/api/prepaid-packages?${params}`)
      .then(r => r.json())
      .then(json => setPackages(json.data || []))
      .catch(() => setPackages([]))
      .finally(() => setPackagesLoading(false));
  }, [open, locationId]);

  // Sync selected package details
  useEffect(() => {
    const pkg = packages.find(p => p.id === packageId) || null;
    setSelectedPackage(pkg);
    if (pkg) {
      setValidityDays(String(pkg.validity_days || 30));
      setNoRestore(pkg.default_cancellation_window_hours === null);
      setWindowHours(pkg.default_cancellation_window_hours == null ? "2" : String(pkg.default_cancellation_window_hours));
    }
  }, [packageId, packages]);

  // Close suggestions on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (suggestionsRef.current && !suggestionsRef.current.contains(e.target as Node)) {
        setShowSuggestions(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const searchLeads = useCallback(async (q: string) => {
    if (q.length < 2) { setSuggestions([]); return; }
    setSearchLoading(true);
    try {
      const res = await fetch(`/api/bookings/search-customer?q=${encodeURIComponent(q)}`);
      if (res.ok) {
        const json = await res.json();
        // Filter to leads only
        const leads: LeadSuggestion[] = (json.data || [])
          .filter((s: { type: string }) => s.type === "lead")
          .map((s: { id?: string; lead_id?: string; name: string; phone?: string; email?: string; company?: string }) => ({
            id: s.lead_id || s.id || "",
            name: s.name,
            phone: s.phone,
            email: s.email,
            company: s.company,
          }));
        setSuggestions(leads);
        setShowSuggestions(true);
      }
    } catch { /* ignore */ }
    setSearchLoading(false);
  }, []);

  const handleCustomerInput = (val: string) => {
    setCustomerQuery(val);
    setSelectedLead(null);
    setContractNote(null);
    setScope("individual");
    setCompanyName("");
    if (searchTimeout.current) clearTimeout(searchTimeout.current);
    searchTimeout.current = setTimeout(() => searchLeads(val), 300);
  };

  const selectLead = (lead: LeadSuggestion) => {
    setSelectedLead(lead);
    setCustomerQuery(lead.phone ? `${lead.phone} — ${lead.name}` : lead.name);
    setShowSuggestions(false);
    // Default scope to individual; auto-fill company in case user switches
    setScope("individual");
    setCompanyName(lead.company || "");

    // Gap 4: Check if a contract exists for this lead (informational only)
    if (lead.id) {
      fetch(`/api/contracts?lead_id=${lead.id}&limit=1`)
        .then(r => r.json())
        .then(json => {
          const contract = (json.data || [])[0];
          if (contract) {
            setContractNote(
              `Contract ${contract.contract_number} found for ${lead.company || lead.name}${contract.seats ? ` (${contract.seats} seats)` : ""} — team bookings will auto-detect this package.`
            );
          } else {
            setContractNote(null);
          }
        })
        .catch(() => setContractNote(null));
    }
  };

  const handleSubmit = async () => {
    if (!packageId) { toast.error("Please select a package"); return; }
    if (!selectedLead && !companyName.trim()) {
      toast.error("Please select a customer or enter a company name");
      return;
    }
    if (!paymentMode) { toast.error("Please select a payment mode"); return; }
    if (selectedLocationIds.length === 0) { toast.error("Choose at least one location this package can be redeemed at"); return; }
    const validity = Number(validityDays);
    if (!Number.isInteger(validity) || validity < 1) { toast.error("Validity must be a whole number of days, 1 or more"); return; }
    if (!noRestore && !(Number(windowHours) >= 0)) { toast.error("Enter the free-cancellation window in hours, or tick 'never restore'"); return; }

    // Determine the company_name to send based on scope
    const resolvedCompanyName = scope === "company"
      ? (companyName.trim() || selectedLead?.company || undefined)
      : undefined;

    setSaving(true);
    try {
      const res = await fetch("/api/prepaid-purchases", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          package_id: packageId,
          location_ids: selectedLocationIds,
          validity_days: validity,
          cancellation_window_hours: noRestore ? null : Number(windowHours),
          lead_id: selectedLead?.id || undefined,
          company_name: resolvedCompanyName,
          payment_mode: paymentMode,
          payment_reference: paymentReference.trim() || undefined,
          notes: notes.trim() || undefined,
          notify_sms: paymentMode === "payment_link" ? notifySms : undefined,
          notify_email: paymentMode === "payment_link" ? notifyEmail : undefined,
        }),
      });
      const json = await res.json();
      if (res.ok) {
        if (paymentMode === "payment_link") {
          const linkUrl = json.data?.payment_link_url || json.data?.razorpay_payment_link_url;
          if (linkUrl) {
            toast.success("Package created — payment link sent to customer");
          } else {
            toast.success("Package created — payment pending (no Razorpay link generated)");
          }
        } else {
          toast.success(`Package sold — ${selectedPackage?.total_credits} ${CREDIT_TYPE_LABELS[selectedPackage?.credit_type || "hours"]} issued`);
        }
        onSuccess();
        handleClose();
      } else {
        toast.error(json.error || "Failed to sell package");
      }
    } catch {
      toast.error("Failed to sell package");
    } finally {
      setSaving(false);
    }
  };

  const handleClose = () => {
    setPackageId(preselectedPackageId || "");
    setSelectedPackage(null);
    setCustomerQuery("");
    setSuggestions([]);
    setSelectedLead(null);
    setScope("individual");
    setCompanyName("");
    setContractNote(null);
    setPaymentMode("cash");
    setPaymentReference("");
    setNotifySms(true);
    setNotifyEmail(true);
    setNotes("");
    setSelectedLocationIds(locationId ? [locationId] : []);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Sell Package</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {/* Package selection */}
          <div className="space-y-2">
            <Label>Package *</Label>
            {packagesLoading ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading packages...
              </div>
            ) : (
              <Select value={packageId} onValueChange={setPackageId}>
                <SelectTrigger>
                  <SelectValue placeholder="Select a package" />
                </SelectTrigger>
                <SelectContent>
                  {packages.map(pkg => (
                    <SelectItem key={pkg.id} value={pkg.id}>
                      {pkg.name} — {pkg.total_credits} {CREDIT_TYPE_LABELS[pkg.credit_type]} · {formatCurrency(pkg.price)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            {selectedPackage && (
              <p className="text-xs text-muted-foreground">
                Valid for {selectedPackage.validity_days} days from purchase
                {selectedPackage.workspace_type && ` · ${selectedPackage.workspace_type.replace(/_/g, " ")}`}
                {(selectedPackage.space as { name?: string } | undefined)?.name && ` · ${(selectedPackage.space as { name?: string }).name} only`}
              </p>
            )}
          </div>

          {/* Terms agreed at sale */}
          {selectedPackage && (
            <div className="space-y-3 rounded-md border p-3">
              <div className="space-y-2">
                <Label>Redeemable at *</Label>
                <PackageTip>The customer can only redeem at the places you tick. At least one is required.</PackageTip>
                <div className="flex flex-wrap gap-2">
                  {locations.map(l => {
                    const on = selectedLocationIds.includes(l.id);
                    return (
                      <button
                        key={l.id}
                        type="button"
                        aria-pressed={on}
                        onClick={() => setSelectedLocationIds(ids => on ? ids.filter(i => i !== l.id) : [...ids, l.id])}
                        className={`rounded-md border px-3 py-1.5 text-sm transition-colors ${
                          on ? "border-primary bg-primary/5 text-primary" : "border-border text-muted-foreground hover:bg-muted/30"
                        }`}
                      >
                        {l.name}
                      </button>
                    );
                  })}
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-2">
                  <Label>Valid for (days) *</Label>
                  <Input type="number" min={1} step={1} value={validityDays} onChange={(e) => setValidityDays(e.target.value)} />
                  {Number.isInteger(Number(validityDays)) && Number(validityDays) >= 1 && (
                    <p className="text-xs text-muted-foreground">
                      Expires {formatDate(addDaysToDate(istDateString(), Number(validityDays)))}
                    </p>
                  )}
                </div>
                <div className="space-y-2">
                  <Label>Free cancellation up to (hrs before start)</Label>
                  <PackageTip>Cancel earlier than this and the hours come back. Later, or a no-show, and they are used up.</PackageTip>
                  <Input type="number" min={0} step="0.5" value={windowHours} disabled={noRestore} onChange={(e) => setWindowHours(e.target.value)} />
                  <label className="flex items-center gap-2 text-xs text-muted-foreground">
                    <input type="checkbox" checked={noRestore} onChange={(e) => setNoRestore(e.target.checked)} />
                    Never restore credits
                  </label>
                </div>
              </div>
            </div>
          )}

          {/* Customer search */}
          <div className="space-y-2">
            <Label>Customer (Lead) *</Label>
            <div className="relative" ref={suggestionsRef}>
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                value={customerQuery}
                onChange={(e) => handleCustomerInput(e.target.value)}
                onFocus={() => suggestions.length > 0 && setShowSuggestions(true)}
                placeholder="Search by name, phone, or company..."
                className="pl-9"
              />
              {searchLoading && (
                <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 animate-spin text-muted-foreground" />
              )}
              {showSuggestions && suggestions.length > 0 && (
                <div className="absolute z-50 top-full left-0 right-0 mt-1 border rounded-md bg-white shadow-lg max-h-48 overflow-y-auto">
                  {suggestions.map(lead => (
                    <button
                      key={lead.id}
                      type="button"
                      className="w-full text-left px-3 py-2 hover:bg-muted/50 text-sm"
                      onClick={() => selectLead(lead)}
                    >
                      <div className="font-medium">{lead.name}</div>
                      <div className="text-xs text-muted-foreground">
                        {[lead.phone, lead.company].filter(Boolean).join(" · ")}
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Gap 4: Who can use this package? — only shown when a lead is selected */}
          {selectedLead && (
            <div className="space-y-2">
              <Label>Who can use this package?</Label>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setScope("individual")}
                  className={`flex-1 flex items-center gap-2 rounded-md border px-3 py-2 text-sm transition-colors ${
                    scope === "individual"
                      ? "border-primary bg-primary/5 text-primary"
                      : "border-border text-muted-foreground hover:bg-muted/30"
                  }`}
                >
                  <User className="h-4 w-4 shrink-0" />
                  <div className="text-left">
                    <div className="font-medium">This customer only</div>
                  </div>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setScope("company");
                    if (!companyName && selectedLead.company) setCompanyName(selectedLead.company);
                  }}
                  className={`flex-1 flex items-center gap-2 rounded-md border px-3 py-2 text-sm transition-colors ${
                    scope === "company"
                      ? "border-primary bg-primary/5 text-primary"
                      : "border-border text-muted-foreground hover:bg-muted/30"
                  }`}
                  disabled={!selectedLead.company}
                >
                  <Users className="h-4 w-4 shrink-0" />
                  <div className="text-left">
                    <div className="font-medium">Entire company &amp; team</div>
                    {selectedLead.company && (
                      <div className="text-xs opacity-70">{selectedLead.company}</div>
                    )}
                  </div>
                </button>
              </div>

              {scope === "company" && companyName && (
                <div className="rounded-md bg-blue-50 px-3 py-2 text-xs text-blue-700">
                  Any booking by a <strong>{companyName}</strong> member will be able to redeem this package.
                  {contractNote && (
                    <div className="mt-1 text-blue-600">{contractNote}</div>
                  )}
                </div>
              )}

              {scope === "individual" && !selectedLead.company && (
                <p className="text-xs text-muted-foreground">
                  Company-wide redemption requires the lead to have a company name set.
                </p>
              )}
            </div>
          )}

          {/* Fallback: company name (for anonymous corporate sales) */}
          {!selectedLead && (
            <div className="space-y-2">
              <Label>Company Name <span className="text-muted-foreground text-xs">(for corporate redemption — any booking with this company can redeem)</span></Label>
              <Input
                value={companyName}
                onChange={(e) => setCompanyName(e.target.value)}
                placeholder="e.g. Acme Corp"
              />
            </div>
          )}

          {/* Payment */}
          <div className="space-y-2">
            <Label>Payment Mode *</Label>
            <div className="grid grid-cols-2 gap-2">
              {PAYMENT_MODES.map(m => (
                <button
                  key={m.value}
                  type="button"
                  onClick={() => setPaymentMode(m.value)}
                  className={`flex items-center gap-2 rounded-md border px-3 py-2 text-sm transition-colors ${
                    paymentMode === m.value
                      ? "border-primary bg-primary/5 text-primary font-medium"
                      : "border-border text-muted-foreground hover:bg-muted/30"
                  }`}
                >
                  {m.value === "payment_link" && <Link2 className="h-3.5 w-3.5" />}
                  {m.label}
                </button>
              ))}
            </div>
          </div>

          {/* Payment reference — hidden for payment_link */}
          {paymentMode !== "payment_link" && (
            <div className="space-y-2">
              <Label>Payment Reference</Label>
              <Input
                value={paymentReference}
                onChange={(e) => setPaymentReference(e.target.value)}
                placeholder="UPI ID / receipt no."
              />
            </div>
          )}

          {/* Payment link notify options */}
          {paymentMode === "payment_link" && (
            <div className="rounded-md bg-blue-50 border border-blue-100 px-3 py-3 space-y-2">
              <p className="text-xs font-medium text-blue-800">Notify customer via:</p>
              <div className="flex gap-4">
                <label className="flex items-center gap-2 text-sm text-blue-700 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={notifySms}
                    onChange={e => setNotifySms(e.target.checked)}
                    className="h-4 w-4 rounded"
                  />
                  SMS (phone)
                </label>
                <label className="flex items-center gap-2 text-sm text-blue-700 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={notifyEmail}
                    onChange={e => setNotifyEmail(e.target.checked)}
                    className="h-4 w-4 rounded"
                  />
                  Email
                </label>
              </div>
              <p className="text-xs text-blue-600">
                Customer will receive a Razorpay payment link. Package activates on payment.
              </p>
            </div>
          )}

          {/* Amount display */}
          {selectedPackage && (
            <div className="rounded-md bg-muted/40 px-3 py-2 text-sm">
              <span className="text-muted-foreground">Amount to collect: </span>
              <span className="font-semibold">{formatCurrency(selectedPackage.price)}</span>
            </div>
          )}

          {/* Notes */}
          <div className="space-y-2">
            <Label>Notes</Label>
            <Textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Optional notes..."
              rows={2}
            />
          </div>

          {/* Actions */}
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={handleClose} disabled={saving}>Cancel</Button>
            <Button onClick={handleSubmit} disabled={saving}>
              {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {paymentMode === "payment_link" ? "Send Payment Link" : "Sell Package"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
