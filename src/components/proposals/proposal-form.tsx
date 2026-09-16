"use client";

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { LineItemsEditor, type LineItemData } from "@/components/shared/line-items-editor";
import { Loader2, Lock } from "lucide-react";
import { toast } from "sonner";
import { DEFAULT_PROPOSAL_TERMS } from "@/lib/constants";
import { LocationSelector } from "@/components/shared/location-selector";
import { formatCurrency, preventEnterSubmit } from "@/lib/utils";
import {
  PROPOSAL_MAX_TENURE_MONTHS,
  buildCommitmentTermLines,
  hasCommitmentTerms,
  maxNoticePeriodMonths,
  mentionsCommitmentTerms,
  stripLegacyCommitmentLines,
  validateCommitmentTerms,
} from "@/lib/proposal-terms";
import type { ServiceCatalogItem, Proposal } from "@/types";

interface ServiceQuotaRow {
  service_id: string;
  name: string;
  unit_label: string;
  default_overage_rate: number;
  monthly_quota: number;
  overage_rate: number;
}

interface ProposalFormProps {
  leadId: string;
  leadLocationId?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
  /** Present in edit mode — the proposal being edited. */
  proposalId?: string;
  initialProposal?: Proposal;
}

export function ProposalForm({
  leadId,
  leadLocationId,
  open,
  onOpenChange,
  onSuccess,
  proposalId,
  initialProposal,
}: ProposalFormProps) {
  const isEditMode = Boolean(proposalId && initialProposal);
  const [title, setTitle] = useState("");
  const [locationId, setLocationId] = useState<string | null>(leadLocationId || null);
  const [description, setDescription] = useState("");
  const [serviceQuotas, setServiceQuotas] = useState<ServiceQuotaRow[]>([]);
  const [catalogLoaded, setCatalogLoaded] = useState(false);
  const [items, setItems] = useState<LineItemData[]>([
    { description: "", quantity: 1, unit_price: 0, total: 0 },
  ]);
  const [taxPercentage, setTaxPercentage] = useState(18);
  const [discountPercentage, setDiscountPercentage] = useState(0);
  const [validUntil, setValidUntil] = useState("");
  const [termsAndConditions, setTermsAndConditions] = useState(DEFAULT_PROPOSAL_TERMS);
  const [notes, setNotes] = useState("");
  const [confRoomHours, setConfRoomHours] = useState(0);
  const [confRoomOverageRate, setConfRoomOverageRate] = useState(0);
  const [depositMonths, setDepositMonths] = useState(0);
  const [depositAmount, setDepositAmount] = useState(0);
  const [depositOverridden, setDepositOverridden] = useState(false);
  // No defaults on purpose: the commitment offered must be a deliberate choice,
  // since it's carried into the contract.
  const [tenureMonths, setTenureMonths] = useState<number | null>(null);
  const [lockInMonths, setLockInMonths] = useState<number | null>(null);
  const [noticePeriodMonths, setNoticePeriodMonths] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Load service catalog once on mount
  useEffect(() => {
    fetch("/api/service-catalog")
      .then(r => r.json())
      .then(json => {
        const catalog = (json.data || []) as ServiceCatalogItem[];
        setServiceQuotas(catalog.map(s => ({
          service_id: s.id,
          name: s.name,
          unit_label: s.unit_label,
          default_overage_rate: s.default_overage_rate,
          monthly_quota: 0,
          overage_rate: s.default_overage_rate,
        })));
        setCatalogLoaded(true);
      })
      .catch(() => setCatalogLoaded(true));
  }, []);

  // Prefill from the existing proposal when opened in edit mode; otherwise
  // start from a blank form each time the create dialog is opened.
  useEffect(() => {
    if (!open) return;
    if (initialProposal) {
      setTitle(initialProposal.title || "");
      setLocationId(initialProposal.location_id || leadLocationId || null);
      setDescription(initialProposal.description || "");
      setItems(
        initialProposal.items?.length
          ? initialProposal.items.map((i) => ({
              description: i.description,
              quantity: i.quantity,
              unit: i.unit,
              unit_price: i.unit_price,
              total: i.total,
            }))
          : [{ description: "", quantity: 1, unit_price: 0, total: 0 }]
      );
      setTaxPercentage(initialProposal.tax_percentage ?? 18);
      setDiscountPercentage(initialProposal.discount_percentage ?? 0);
      setValidUntil(initialProposal.valid_until ? initialProposal.valid_until.slice(0, 10) : "");
      const storedTerms = initialProposal.terms_and_conditions ?? DEFAULT_PROPOSAL_TERMS;
      // A legacy proposal's text still carries the old hardcoded deposit/term/
      // notice lines; drop them so they don't contradict the generated ones.
      setTermsAndConditions(hasCommitmentTerms(initialProposal) ? storedTerms : stripLegacyCommitmentLines(storedTerms));
      setTenureMonths(initialProposal.tenure_months ?? null);
      setLockInMonths(initialProposal.lock_in_months ?? null);
      setNoticePeriodMonths(initialProposal.notice_period_months ?? null);
      setNotes(initialProposal.notes ?? "");
      const confRoom = (initialProposal.complimentary_items || []).find((i) => i.name === "Conference Room");
      setConfRoomHours(confRoom?.quantity ?? 0);
      setConfRoomOverageRate(confRoom?.price_per_unit ?? 0);
      setDepositMonths(initialProposal.security_deposit_months ?? 0);
      setDepositAmount(initialProposal.security_deposit_amount ?? 0);
      // Only lock the stored deposit if it was a custom figure. A deposit that
      // was months × rent keeps following the months selector, so changing
      // "2 months" to "3 months" doesn't leave the old amount behind.
      const storedMonths = initialProposal.security_deposit_months ?? 0;
      const storedSubtotal = (initialProposal.items ?? []).reduce(
        (sum, item) => sum + Math.max(1, item.quantity) * item.unit_price,
        0
      );
      setDepositOverridden(
        storedMonths > 0 && (initialProposal.security_deposit_amount ?? 0) !== storedMonths * storedSubtotal
      );
    } else {
      resetForm();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialProposal, leadLocationId]);

  // Edit mode only — merge in the proposal's existing service quotas once
  // the catalog has loaded (need service_id from the catalog to match rows).
  useEffect(() => {
    if (!open || !proposalId || !initialProposal || !catalogLoaded) return;
    fetch(`/api/proposals/${proposalId}/service-quotas`)
      .then((r) => (r.ok ? r.json() : { data: [] }))
      .then((json) => {
        const rows = (json.data || []) as { service_id: string; monthly_quota: number; overage_rate: number }[];
        if (rows.length === 0) return;
        setServiceQuotas((prev) =>
          prev.map((sq) => {
            const match = rows.find((r) => r.service_id === sq.service_id);
            return match ? { ...sq, monthly_quota: match.monthly_quota, overage_rate: match.overage_rate } : sq;
          })
        );
      })
      .catch(() => {});
  }, [open, proposalId, initialProposal, catalogLoaded]);

  // Compute subtotal for deposit auto-calculation
  const computedSubtotal = items
    .filter((item) => item.description.trim())
    .reduce((sum, item) => sum + Math.max(1, item.quantity) * item.unit_price, 0);

  // Keep the auto-calculated deposit following the rent. The deposit line in
  // the terms is generated from these values (see generatedTermLines).
  const effectiveDepositAmount = depositOverridden ? depositAmount : depositMonths * computedSubtotal;
  useEffect(() => {
    if (!open) return;
    if (!depositOverridden && depositAmount !== effectiveDepositAmount) {
      setDepositAmount(effectiveDepositAmount);
    }
  }, [open, depositMonths, depositAmount, depositOverridden, effectiveDepositAmount]);

  const resetForm = () => {
    setTitle("");
    setDescription("");
    setItems([{ description: "", quantity: 1, unit_price: 0, total: 0 }]);
    setTaxPercentage(18);
    setDiscountPercentage(0);
    setValidUntil("");
    setTermsAndConditions(DEFAULT_PROPOSAL_TERMS);
    setNotes("");
    setLocationId(leadLocationId || null);
    setConfRoomHours(0);
    setConfRoomOverageRate(0);
    setDepositMonths(0);
    setDepositAmount(0);
    setDepositOverridden(false);
    setTenureMonths(null);
    setLockInMonths(null);
    setNoticePeriodMonths(null);
    // Reset quotas to defaults
    setServiceQuotas(prev => prev.map(sq => ({
      ...sq,
      monthly_quota: 0,
      overage_rate: sq.default_overage_rate,
    })));
  };

  const handleTenureChange = (val: string) => {
    const tenure = parseInt(val);
    setTenureMonths(tenure);
    const lockIn = lockInMonths != null ? Math.min(lockInMonths, tenure) : null;
    setLockInMonths(lockIn);
    if (lockIn != null && noticePeriodMonths != null) {
      setNoticePeriodMonths(Math.min(noticePeriodMonths, maxNoticePeriodMonths(tenure, lockIn)));
    }
  };

  const handleLockInChange = (val: string) => {
    const lockIn = parseInt(val);
    setLockInMonths(lockIn);
    if (tenureMonths != null && noticePeriodMonths != null) {
      setNoticePeriodMonths(Math.min(noticePeriodMonths, maxNoticePeriodMonths(tenureMonths, lockIn)));
    }
  };

  const maxNotice = tenureMonths != null && lockInMonths != null
    ? maxNoticePeriodMonths(tenureMonths, lockInMonths)
    : null;

  const generatedTermLines = buildCommitmentTermLines({
    tenure_months: tenureMonths,
    lock_in_months: lockInMonths,
    notice_period_months: noticePeriodMonths,
    security_deposit_months: depositMonths,
    security_deposit_amount: depositMonths > 0 ? effectiveDepositAmount : 0,
  });

  const updateQuota = (serviceId: string, field: "monthly_quota" | "overage_rate", value: number) => {
    setServiceQuotas(prev => prev.map(sq =>
      sq.service_id === serviceId ? { ...sq, [field]: value } : sq
    ));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!title.trim()) {
      toast.error("Please enter a proposal title");
      return;
    }

    const validItems = items.filter((item) => item.description.trim());
    if (validItems.length === 0) {
      toast.error("Please add at least one line item with a description");
      return;
    }

    const invalidQty = validItems.find((item) => item.quantity <= 0);
    if (invalidQty) {
      toast.error("Each line item must have a quantity of at least 1");
      return;
    }

    const commitmentError = validateCommitmentTerms({
      tenure_months: tenureMonths,
      lock_in_months: lockInMonths,
      notice_period_months: noticePeriodMonths,
    });
    if (commitmentError) {
      toast.error(commitmentError);
      return;
    }

    setSubmitting(true);

    // Only send quotas that have been configured (quota > 0 or rate differs from default)
    const activeQuotas = serviceQuotas
      .filter(sq => sq.monthly_quota > 0 || sq.overage_rate !== sq.default_overage_rate)
      .map(sq => ({
        service_id: sq.service_id,
        monthly_quota: sq.monthly_quota,
        overage_rate: sq.overage_rate,
      }));

    const body = {
      lead_id: leadId,
      location_id: locationId || undefined,
      title: title.trim(),
      description: description.trim() || undefined,
      items: validItems.map((item) => ({
        description: item.description,
        quantity: Math.max(1, item.quantity),
        unit: item.unit || undefined,
        unit_price: item.unit_price,
        total: Math.max(1, item.quantity) * item.unit_price,
      })),
      tax_percentage: taxPercentage,
      discount_percentage: discountPercentage,
      valid_until: validUntil || undefined,
      terms_and_conditions: termsAndConditions.trim() || undefined,
      notes: notes.trim() || undefined,
      service_quotas: activeQuotas.length > 0 ? activeQuotas : undefined,
      complimentary_items: confRoomHours > 0 ? [{
        name: "Conference Room",
        unit: "hrs",
        quantity: confRoomHours,
        price_per_unit: confRoomOverageRate,
      }] : undefined,
      security_deposit_months: depositMonths,
      security_deposit_amount: depositMonths > 0 ? depositAmount : 0,
      tenure_months: tenureMonths,
      lock_in_months: lockInMonths,
      notice_period_months: noticePeriodMonths,
    };

    const res = await fetch(isEditMode ? `/api/proposals/${proposalId}` : "/api/proposals", {
      method: isEditMode ? "PATCH" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    setSubmitting(false);
    if (res.ok) {
      toast.success(isEditMode ? "Proposal updated successfully" : "Proposal created successfully");
      if (!isEditMode) resetForm();
      onOpenChange(false);
      onSuccess();
    } else {
      const err = await res.json().catch(() => null);
      toast.error(err?.error || (isEditMode ? "Failed to update proposal" : "Failed to create proposal"));
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isEditMode ? "Edit Proposal" : "Create Proposal"}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} onKeyDown={preventEnterSubmit} className="space-y-6">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="proposal-title">
                Title <span className="text-destructive">*</span>
              </Label>
              <Input
                id="proposal-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="e.g. Private Office - 15 Seats"
              />
            </div>
            <div className="space-y-2">
              <Label>Location</Label>
              <LocationSelector
                value={locationId}
                onValueChange={setLocationId}
                placeholder="Select center"
              />
            </div>
          </div>

          {/* Line Items */}
          <div>
            <Label className="mb-3 block">Line Items</Label>
            <LineItemsEditor
              items={items}
              onChange={setItems}
              taxPercentage={taxPercentage}
              onTaxChange={setTaxPercentage}
              discountPercentage={discountPercentage}
              onDiscountChange={setDiscountPercentage}
            />
          </div>

          {/* Service Quotas — from global service catalog */}
          <div className="border rounded-lg p-4 space-y-3 bg-muted/30">
            <div>
              <Label className="text-sm font-semibold">Service Quotas</Label>
              <p className="text-xs text-muted-foreground mt-0.5">
                Set the free monthly allowance per service for this customer. Leave at 0 if fully chargeable. The overage rate applies above the free quota.
              </p>
            </div>
            {!catalogLoaded ? (
              <p className="text-xs text-muted-foreground py-2 flex items-center gap-1.5">
                <Loader2 className="h-3 w-3 animate-spin" /> Loading services…
              </p>
            ) : serviceQuotas.length === 0 ? (
              <p className="text-xs text-muted-foreground py-2">
                No services in catalog. Add them in Admin → Service Catalog.
              </p>
            ) : (
              <div className="space-y-2">
                <div className="grid grid-cols-12 gap-2 text-xs text-muted-foreground font-medium px-1">
                  <div className="col-span-4">Service</div>
                  <div className="col-span-2">Unit</div>
                  <div className="col-span-3">Free quota / month</div>
                  <div className="col-span-3">Addl Usage rate</div>
                </div>
                {serviceQuotas.map((sq) => (
                  <div key={sq.service_id} className="grid grid-cols-12 gap-2 items-center">
                    <div className="col-span-4 flex items-center h-8">
                      <span className="text-sm font-medium">{sq.name}</span>
                    </div>
                    <div className="col-span-2 flex items-center h-8">
                      <span className="text-xs text-muted-foreground">{sq.unit_label}</span>
                    </div>
                    <div className="col-span-3">
                      <Input
                        type="number"
                        min="0"
                        step="1"
                        placeholder="0"
                        value={sq.monthly_quota || ""}
                        onChange={(e) => updateQuota(sq.service_id, "monthly_quota", Number(e.target.value) || 0)}
                        className="h-8 text-sm"
                      />
                    </div>
                    <div className="col-span-3">
                      <div className="relative">
                        <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">₹</span>
                        <Input
                          type="number"
                          min="0"
                          step="0.01"
                          value={sq.overage_rate || ""}
                          onChange={(e) => updateQuota(sq.service_id, "overage_rate", Number(e.target.value) || 0)}
                          className="h-8 text-sm pl-6"
                        />
                      </div>
                    </div>
                  </div>
                ))}
                <p className="text-xs text-muted-foreground pt-1">
                  Default rates from the service catalog are pre-filled. Adjust per negotiation.
                </p>
              </div>
            )}
          </div>

          {/* Conference Room Complimentary */}
          <div className="border rounded-lg p-4 space-y-3 bg-muted/30">
            <div>
              <Label className="text-sm font-semibold">Conference Room Complimentary</Label>
              <p className="text-xs text-muted-foreground mt-0.5">
                Free conference room hours offered per month. Leave at 0 if not included.
              </p>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Free hours / month</Label>
                <Input
                  type="number"
                  min="0"
                  step="0.5"
                  placeholder="0"
                  value={confRoomHours || ""}
                  onChange={(e) => setConfRoomHours(Number(e.target.value) || 0)}
                  className="h-8 text-sm"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Overage rate (₹ / hr)</Label>
                <div className="relative">
                  <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">₹</span>
                  <Input
                    type="number"
                    min="0"
                    step="1"
                    placeholder="0"
                    value={confRoomOverageRate || ""}
                    onChange={(e) => setConfRoomOverageRate(Number(e.target.value) || 0)}
                    className="h-8 text-sm pl-6"
                  />
                </div>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="valid-until">Valid Until</Label>
              <Input
                id="valid-until"
                type="date"
                value={validUntil}
                onChange={(e) => setValidUntil(e.target.value)}
              />
            </div>
          </div>

          {/* Commitment & Security Deposit */}
          <div className="border rounded-lg p-4 space-y-3 bg-muted/30">
            <div>
              <Label className="text-sm font-semibold">Commitment & Security Deposit</Label>
              <p className="text-xs text-muted-foreground mt-0.5">
                What the customer is offered. These are printed in the proposal terms and carried into the contract.
              </p>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div className="space-y-2">
                <Label htmlFor="tenure-months" className="text-xs text-muted-foreground">
                  Term <span className="text-destructive">*</span>
                </Label>
                <Select value={tenureMonths != null ? String(tenureMonths) : ""} onValueChange={handleTenureChange}>
                  <SelectTrigger id="tenure-months">
                    <SelectValue placeholder="Select term" />
                  </SelectTrigger>
                  <SelectContent>
                    {Array.from({ length: PROPOSAL_MAX_TENURE_MONTHS }, (_, i) => i + 1).map((m) => (
                      <SelectItem key={m} value={String(m)}>
                        {m} month{m !== 1 ? "s" : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="lock-in-months" className="text-xs text-muted-foreground">
                  Lock-in Period <span className="text-destructive">*</span>
                </Label>
                <Select
                  value={lockInMonths != null ? String(lockInMonths) : ""}
                  onValueChange={handleLockInChange}
                  disabled={tenureMonths == null}
                >
                  <SelectTrigger id="lock-in-months">
                    <SelectValue placeholder={tenureMonths == null ? "Select term first" : "Select lock-in"} />
                  </SelectTrigger>
                  <SelectContent>
                    {Array.from({ length: tenureMonths ?? 0 }, (_, i) => i + 1).map((m) => (
                      <SelectItem key={m} value={String(m)}>
                        {m} month{m !== 1 ? "s" : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="notice-period-months" className="text-xs text-muted-foreground">
                  Notice Period <span className="text-destructive">*</span>
                </Label>
                <Select
                  value={noticePeriodMonths != null ? String(noticePeriodMonths) : ""}
                  onValueChange={(v) => setNoticePeriodMonths(parseInt(v))}
                  disabled={maxNotice == null}
                >
                  <SelectTrigger id="notice-period-months">
                    <SelectValue placeholder={maxNotice == null ? "Select lock-in first" : "Select notice"} />
                  </SelectTrigger>
                  <SelectContent>
                    {Array.from({ length: (maxNotice ?? -1) + 1 }, (_, i) => i).map((m) => (
                      <SelectItem key={m} value={String(m)}>
                        {m === 0 ? "None (0 months)" : `${m} month${m !== 1 ? "s" : ""}`}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="deposit-months" className="text-xs text-muted-foreground">Security Deposit (months)</Label>
                <Select
                  value={String(depositMonths)}
                  onValueChange={(v) => {
                    const months = parseInt(v);
                    setDepositMonths(months);
                    if (!depositOverridden) {
                      setDepositAmount(months * computedSubtotal);
                    }
                  }}
                >
                  <SelectTrigger id="deposit-months">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="0">No deposit</SelectItem>
                    <SelectItem value="1">1 month</SelectItem>
                    <SelectItem value="2">2 months</SelectItem>
                    <SelectItem value="3">3 months</SelectItem>
                    <SelectItem value="4">4 months</SelectItem>
                    <SelectItem value="5">5 months</SelectItem>
                    <SelectItem value="6">6 months</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {depositMonths > 0 && (
                <div className="space-y-2">
                  <Label htmlFor="deposit-amount" className="text-xs text-muted-foreground">
                    Deposit Amount (pre-GST)
                    {!depositOverridden && computedSubtotal > 0 && (
                      <span className="ml-1 text-muted-foreground">= {depositMonths} × {formatCurrency(computedSubtotal)}</span>
                    )}
                  </Label>
                  <Input
                    id="deposit-amount"
                    type="number"
                    value={depositAmount || ""}
                    onChange={(e) => {
                      setDepositAmount(parseFloat(e.target.value) || 0);
                      setDepositOverridden(true);
                    }}
                    placeholder="0"
                  />
                  {depositOverridden && (
                    <button
                      type="button"
                      className="text-xs text-primary underline"
                      onClick={() => {
                        setDepositOverridden(false);
                        setDepositAmount(depositMonths * computedSubtotal);
                      }}
                    >
                      Reset to auto-calculated
                    </button>
                  )}
                </div>
              )}
            </div>
            {depositMonths > 0 && (
              <p className="text-xs text-muted-foreground">
                Refundable deposit. A separate payment link will be generated after proposal acceptance.
              </p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="terms">Terms & Conditions</Label>
            <div className="rounded-md border bg-muted/40 px-3 py-2 text-sm">
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground mb-1">
                <Lock className="h-3 w-3" /> Generated from Commitment & Security Deposit — updates as you change them
              </p>
              {generatedTermLines.length > 0 ? (
                <div className="whitespace-pre-line">{generatedTermLines.join("\n")}</div>
              ) : (
                <p className="text-xs text-muted-foreground">Select term, lock-in and notice period to generate these lines.</p>
              )}
            </div>
            <Textarea
              id="terms"
              value={termsAndConditions}
              onChange={(e) => setTermsAndConditions(e.target.value)}
              placeholder="Add terms and conditions..."
              rows={3}
            />
            {mentionsCommitmentTerms(termsAndConditions) && (
              <p className="text-xs text-amber-700">
                These terms mention lock-in, notice period or security deposit. Those lines are generated above — remove them here so the proposal doesn&apos;t state conflicting terms.
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              List other legal and commercial terms here. Set amenity quotas (conference rooms, prints, etc.) in the <span className="font-medium">Service Quotas</span> section above.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="proposal-notes">Customer Notes</Label>
            <Textarea
              id="proposal-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Notes visible to the customer..."
              rows={2}
            />
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {isEditMode ? "Save Changes" : "Create Proposal"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
