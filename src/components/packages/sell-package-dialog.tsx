"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { Loader2, Search } from "lucide-react";
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
import { formatCurrency } from "@/lib/utils";
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

  // Customer search
  const [customerQuery, setCustomerQuery] = useState("");
  const [suggestions, setSuggestions] = useState<LeadSuggestion[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [selectedLead, setSelectedLead] = useState<LeadSuggestion | null>(null);
  const suggestionsRef = useRef<HTMLDivElement>(null);
  const searchTimeout = useRef<NodeJS.Timeout | null>(null);

  const [companyName, setCompanyName] = useState("");
  const [paymentMode, setPaymentMode] = useState("cash");
  const [paymentReference, setPaymentReference] = useState("");
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
    if (searchTimeout.current) clearTimeout(searchTimeout.current);
    searchTimeout.current = setTimeout(() => searchLeads(val), 300);
  };

  const selectLead = (lead: LeadSuggestion) => {
    setSelectedLead(lead);
    setCustomerQuery(lead.phone ? `${lead.phone} — ${lead.name}` : lead.name);
    setCompanyName(lead.company || "");
    setShowSuggestions(false);
  };

  const handleSubmit = async () => {
    if (!packageId) { toast.error("Please select a package"); return; }
    if (!selectedLead && !companyName.trim()) {
      toast.error("Please select a customer or enter a company name");
      return;
    }
    if (!paymentMode) { toast.error("Please select a payment mode"); return; }

    setSaving(true);
    try {
      const res = await fetch("/api/prepaid-purchases", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          package_id: packageId,
          lead_id: selectedLead?.id || undefined,
          company_name: companyName.trim() || selectedLead?.company || undefined,
          payment_mode: paymentMode,
          payment_reference: paymentReference.trim() || undefined,
          notes: notes.trim() || undefined,
        }),
      });
      const json = await res.json();
      if (res.ok) {
        toast.success(`Package sold — ${selectedPackage?.total_credits} ${CREDIT_TYPE_LABELS[selectedPackage?.credit_type || "hours"]} issued`);
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
    setCompanyName("");
    setPaymentMode("cash");
    setPaymentReference("");
    setNotes("");
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-lg">
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
              </p>
            )}
          </div>

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

          {/* Company name — for corporate redemption */}
          <div className="space-y-2">
            <Label>Company Name <span className="text-muted-foreground text-xs">(for corporate redemption — any booking with this company can redeem)</span></Label>
            <Input
              value={companyName}
              onChange={(e) => setCompanyName(e.target.value)}
              placeholder="e.g. Acme Corp"
            />
          </div>

          {/* Payment */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label>Payment Mode *</Label>
              <Select value={paymentMode} onValueChange={setPaymentMode}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {PAYMENT_MODES.map(m => (
                    <SelectItem key={m.value} value={m.value}>{m.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Payment Reference</Label>
              <Input
                value={paymentReference}
                onChange={(e) => setPaymentReference(e.target.value)}
                placeholder="UPI ID / receipt no."
              />
            </div>
          </div>

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
              Sell Package
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
