"use client";

import { useState, useEffect, useMemo } from "react";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Loader2, AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import { BILLING_CYCLES, BILLING_CYCLE_LABELS, KYC_DOCUMENTS, ENTITY_TYPE_LABELS } from "@/lib/constants";
import { formatCurrency } from "@/lib/utils";
import { LocationSelector } from "@/components/shared/location-selector";
import type { Proposal, Lead } from "@/types";

interface CreateContractDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
  leadId: string;
}

export function CreateContractDialog({
  open,
  onOpenChange,
  onSuccess,
  leadId,
}: CreateContractDialogProps) {
  const [lead, setLead] = useState<Lead | null>(null);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [loadingData, setLoadingData] = useState(false);

  // Source
  const [source, setSource] = useState<"direct" | "proposal">("direct");
  const [selectedProposalId, setSelectedProposalId] = useState("");

  // Member details (auto-filled from lead, editable)
  const [company, setCompany] = useState("");
  const [panNumber, setPanNumber] = useState("");
  const [gstNumber, setGstNumber] = useState("");
  const [street, setStreet] = useState("");
  const [city, setCity] = useState("");
  const [state, setState] = useState("");
  const [zipCode, setZipCode] = useState("");
  const [country, setCountry] = useState("");

  // Agreement details
  const [locationId, setLocationId] = useState<string | null>(null);
  const [workspaceDescription, setWorkspaceDescription] = useState("");
  const [parkingSpace, setParkingSpace] = useState("");
  const [complimentaryServices, setComplimentaryServices] = useState("");

  // Commercial terms
  const [monthlyFee, setMonthlyFee] = useState<number>(0);
  const [billingCycle, setBillingCycle] = useState("");
  const [seats, setSeats] = useState<number>(1);
  const [startDate, setStartDate] = useState("");
  const [tenureMonths, setTenureMonths] = useState<number>(12);
  const [lockInMonths, setLockInMonths] = useState<number>(10);
  const [securityDepositMonths, setSecurityDepositMonths] = useState<number>(3.0);
  const [escalationPercentage, setEscalationPercentage] = useState<number>(10.0);

  // Signatory
  const [signatoryName, setSignatoryName] = useState("");
  const [signatoryDesignation, setSignatoryDesignation] = useState("");
  const [signatoryPan, setSignatoryPan] = useState("");
  const [signatoryIdType, setSignatoryIdType] = useState<'pan' | 'aadhaar'>('pan');
  const [agreementDate, setAgreementDate] = useState(
    new Date().toISOString().split("T")[0]
  );

  // Notes
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // Fetch lead data and accepted proposals when dialog opens
  useEffect(() => {
    if (open) {
      setLoadingData(true);
      Promise.all([
        fetch(`/api/leads/${leadId}`).then((r) => r.json()),
        fetch(`/api/proposals?lead_id=${leadId}&status=accepted`).then((r) => r.json()),
      ])
        .then(([leadJson, proposalsJson]) => {
          const l = leadJson.data as Lead | undefined;
          if (l) {
            setLead(l);
            setCompany(l.company || "");
            setPanNumber(l.pan_number || "");
            setGstNumber(l.gst_number || "");
            setStreet(l.street || "");
            setCity(l.city || "");
            setState(l.state || "");
            setZipCode(l.zip_code || "");
            setCountry(l.country || "");
            if (l.seat_capacity) setSeats(l.seat_capacity);
            if (l.location_id) setLocationId(l.location_id);
          }
          setProposals(proposalsJson.data || []);
        })
        .catch(() => {})
        .finally(() => setLoadingData(false));
    }
  }, [open, leadId]);

  const selectedProposal = useMemo(
    () => proposals.find((p) => p.id === selectedProposalId) || null,
    [proposals, selectedProposalId]
  );

  // Auto-populate from selected proposal
  useEffect(() => {
    if (selectedProposal) {
      setMonthlyFee(selectedProposal.total_amount);
      if (selectedProposal.location_id) {
        setLocationId(selectedProposal.location_id);
      }
      // Prefill complimentary services from proposal description
      if (selectedProposal.description) {
        setComplimentaryServices(selectedProposal.description);
      }
      // Prefill notes from proposal notes
      if (selectedProposal.notes) {
        setNotes(selectedProposal.notes);
      }
      // Prefill workspace description from proposal title + items summary
      if (selectedProposal.title) {
        const itemsSummary = selectedProposal.items
          ?.map((item: { description: string; quantity: number; unit?: string }) =>
            `${item.quantity}${item.unit ? " " + item.unit : ""} ${item.description}`
          )
          .join(", ");
        setWorkspaceDescription(
          itemsSummary ? `${selectedProposal.title} — ${itemsSummary}` : selectedProposal.title
        );
      }
    }
  }, [selectedProposal]);

  // Calculated fields
  const calculatedEndDate = useMemo(() => {
    if (!startDate || !tenureMonths) return "";
    const start = new Date(startDate);
    start.setMonth(start.getMonth() + tenureMonths);
    return start.toISOString().split("T")[0];
  }, [startDate, tenureMonths]);

  const ifrsdAmount = monthlyFee * securityDepositMonths;
  const noticePeriodMonths = Math.max(0, tenureMonths - lockInMonths);

  const handleTenureChange = (val: string) => {
    const t = parseInt(val);
    setTenureMonths(t);
    if (lockInMonths > t) setLockInMonths(t);
  };

  const missingCompany = !company.trim();
  const missingAddress = !street.trim() && !city.trim();

  const resetForm = () => {
    setSource("direct");
    setSelectedProposalId("");
    setCompany("");
    setPanNumber("");
    setGstNumber("");
    setStreet("");
    setCity("");
    setState("");
    setZipCode("");
    setCountry("");
    setLocationId(null);
    setWorkspaceDescription("");
    setParkingSpace("");
    setComplimentaryServices("");
    setMonthlyFee(0);
    setBillingCycle("");
    setSeats(1);
    setStartDate("");
    setTenureMonths(12);
    setLockInMonths(10);
    setSecurityDepositMonths(3.0);
    setEscalationPercentage(10.0);
    setSignatoryName("");
    setSignatoryDesignation("");
    setSignatoryPan("");
    setAgreementDate(new Date().toISOString().split("T")[0]);
    setNotes("");
    setLead(null);
    setProposals([]);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!company.trim()) {
      toast.error("Company/Member name is required for the agreement");
      return;
    }
    if (!workspaceDescription.trim()) {
      toast.error("Workspace description is required");
      return;
    }
    if (!locationId) {
      toast.error("Please select a location");
      return;
    }
    if (monthlyFee <= 0) {
      toast.error("Monthly membership fee must be positive");
      return;
    }
    if (!billingCycle) {
      toast.error("Please select a billing cycle");
      return;
    }
    if (!startDate) {
      toast.error("Please select a start date");
      return;
    }
    if (!tenureMonths) {
      toast.error("Please select a tenure");
      return;
    }
    if (seats <= 0) {
      toast.error("Seats must be a positive number");
      return;
    }
    if (!signatoryName.trim()) {
      toast.error("Member signatory name is required");
      return;
    }
    if (!signatoryDesignation.trim()) {
      toast.error("Member signatory designation is required");
      return;
    }

    setSubmitting(true);

    // Save updated lead data back to lead record
    const leadUpdates: Record<string, string | undefined> = {};
    if (company.trim() !== (lead?.company || "")) leadUpdates.company = company.trim();
    if (panNumber.trim() !== (lead?.pan_number || "")) leadUpdates.pan_number = panNumber.trim();
    if (gstNumber.trim() !== (lead?.gst_number || "")) leadUpdates.gst_number = gstNumber.trim();
    if (street.trim() !== (lead?.street || "")) leadUpdates.street = street.trim();
    if (city.trim() !== (lead?.city || "")) leadUpdates.city = city.trim();
    if (state.trim() !== (lead?.state || "")) leadUpdates.state = state.trim();
    if (zipCode.trim() !== (lead?.zip_code || "")) leadUpdates.zip_code = zipCode.trim();
    if (country.trim() !== (lead?.country || "")) leadUpdates.country = country.trim();

    if (Object.keys(leadUpdates).length > 0) {
      await fetch(`/api/leads/${leadId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(leadUpdates),
      }).catch(() => {});
    }

    const body = {
      lead_id: leadId,
      proposal_id: source === "proposal" ? selectedProposalId : undefined,
      location_id: locationId || undefined,
      billing_cycle: billingCycle,
      tenure_months: tenureMonths,
      start_date: startDate,
      seats,
      monthly_membership_fee: monthlyFee,
      workspace_description: workspaceDescription.trim(),
      parking_space: parkingSpace.trim() || undefined,
      complimentary_services: complimentaryServices.trim() || undefined,
      security_deposit_months: securityDepositMonths,
      escalation_percentage: escalationPercentage,
      notice_period_months: noticePeriodMonths,
      member_signatory_name: signatoryName.trim(),
      member_signatory_designation: signatoryDesignation.trim(),
      member_signatory_pan: signatoryPan.trim() || undefined,
      member_signatory_id_type: signatoryIdType,
      agreement_date: agreementDate,
      notes: notes.trim() || undefined,
      pan_number: panNumber.trim() || undefined,
    };

    const res = await fetch("/api/contracts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    setSubmitting(false);
    if (res.ok) {
      toast.success("Membership Agreement created successfully");
      resetForm();
      onOpenChange(false);
      onSuccess();
    } else {
      const err = await res.json().catch(() => null);
      toast.error(err?.error || "Failed to create agreement");
    }
  };

  const handleOpenChange = (value: boolean) => {
    if (!value) resetForm();
    onOpenChange(value);
  };

  if (loadingData) {
    return (
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent className="max-w-3xl">
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            <span className="ml-2 text-muted-foreground">Loading lead data...</span>
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Create Membership Agreement</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-6">
          {/* Section 1: Source */}
          <div className="space-y-3">
            <Label className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              Source
            </Label>
            <div className="flex gap-2">
              <Button
                type="button"
                variant={source === "direct" ? "default" : "outline"}
                size="sm"
                onClick={() => { setSource("direct"); setSelectedProposalId(""); }}
              >
                Direct Agreement
              </Button>
              <Button
                type="button"
                variant={source === "proposal" ? "default" : "outline"}
                size="sm"
                onClick={() => setSource("proposal")}
                disabled={proposals.length === 0}
              >
                From Proposal {proposals.length === 0 && "(None accepted)"}
              </Button>
            </div>

            {source === "proposal" && (
              <div className="space-y-2">
                <Select value={selectedProposalId} onValueChange={setSelectedProposalId}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select an accepted proposal" />
                  </SelectTrigger>
                  <SelectContent>
                    {proposals.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.proposal_number} - {p.title} - {formatCurrency(p.total_amount)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>

          {/* Section 2: Member Details */}
          <div className="space-y-3">
            <Label className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              Member Details
            </Label>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>
                  Company / Member Name <span className="text-destructive">*</span>
                </Label>
                <div className="relative">
                  <Input
                    value={company}
                    onChange={(e) => setCompany(e.target.value)}
                    placeholder="Company name"
                    className={missingCompany ? "border-yellow-400 bg-yellow-50" : ""}
                  />
                  {missingCompany && (
                    <div className="flex items-center gap-1 mt-1 text-xs text-yellow-600">
                      <AlertTriangle className="h-3 w-3" />
                      Required for agreement
                    </div>
                  )}
                </div>
              </div>
              <div className="space-y-2">
                <Label>PAN Number</Label>
                <Input
                  value={panNumber}
                  onChange={(e) => setPanNumber(e.target.value.toUpperCase())}
                  placeholder="e.g. AABCA1234E"
                  maxLength={10}
                  className={!panNumber.trim() ? "border-yellow-400 bg-yellow-50" : ""}
                />
                {!panNumber.trim() && (
                  <div className="flex items-center gap-1 text-xs text-yellow-600">
                    <AlertTriangle className="h-3 w-3" />
                    Recommended for agreement
                  </div>
                )}
              </div>
              <div className="space-y-2">
                <Label>GSTIN</Label>
                <Input
                  value={gstNumber}
                  onChange={(e) => setGstNumber(e.target.value.toUpperCase())}
                  placeholder="e.g. 33AABCA1234E1Z5"
                  maxLength={15}
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label>Registered Office Address</Label>
              <Input
                value={street}
                onChange={(e) => setStreet(e.target.value)}
                placeholder="Street address"
                className={missingAddress ? "border-yellow-400 bg-yellow-50" : ""}
              />
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                <Input value={city} onChange={(e) => setCity(e.target.value)} placeholder="City" />
                <Input value={state} onChange={(e) => setState(e.target.value)} placeholder="State" />
                <Input value={zipCode} onChange={(e) => setZipCode(e.target.value)} placeholder="PIN Code" />
                <Input value={country} onChange={(e) => setCountry(e.target.value)} placeholder="Country" />
              </div>
              {missingAddress && (
                <div className="flex items-center gap-1 text-xs text-yellow-600">
                  <AlertTriangle className="h-3 w-3" />
                  Address recommended for agreement
                </div>
              )}
            </div>
          </div>

          {/* Section 3: Agreement Details */}
          <div className="space-y-3">
            <Label className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              Agreement Details
            </Label>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>
                  Location <span className="text-destructive">*</span>
                </Label>
                <LocationSelector
                  value={locationId}
                  onValueChange={setLocationId}
                  placeholder="Select center"
                  required
                />
              </div>
              <div className="space-y-2">
                <Label>
                  Workspace Description <span className="text-destructive">*</span>
                </Label>
                <Input
                  value={workspaceDescription}
                  onChange={(e) => setWorkspaceDescription(e.target.value)}
                  placeholder="e.g. 5 Dedicated Desks — Zone B"
                />
              </div>
              <div className="space-y-2">
                <Label>Parking Space</Label>
                <Input
                  value={parkingSpace}
                  onChange={(e) => setParkingSpace(e.target.value)}
                  placeholder="e.g. 2 Car + 3 Bike"
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label>Complimentary Services</Label>
              <Textarea
                value={complimentaryServices}
                onChange={(e) => setComplimentaryServices(e.target.value)}
                placeholder="e.g. 4 hrs conference room/month, 100 B&W prints/month"
                rows={2}
              />
            </div>
          </div>

          {/* Section 4: Commercial Terms */}
          <div className="space-y-3">
            <Label className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              Commercial Terms
            </Label>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div className="space-y-2">
                <Label>
                  Monthly Membership Fee <span className="text-destructive">*</span>
                </Label>
                <Input
                  type="number"
                  min={0}
                  value={monthlyFee || ""}
                  onChange={(e) => setMonthlyFee(Number(e.target.value) || 0)}
                  placeholder="e.g. 75000"
                />
              </div>
              <div className="space-y-2">
                <Label>
                  Billing Cycle <span className="text-destructive">*</span>
                </Label>
                <Select value={billingCycle} onValueChange={setBillingCycle}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select cycle" />
                  </SelectTrigger>
                  <SelectContent>
                    {BILLING_CYCLES.map((cycle) => (
                      <SelectItem key={cycle} value={cycle}>
                        {BILLING_CYCLE_LABELS[cycle]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>
                  Seats <span className="text-destructive">*</span>
                </Label>
                <Input
                  type="number"
                  min={1}
                  value={seats}
                  onChange={(e) => setSeats(parseInt(e.target.value) || 0)}
                />
              </div>
              <div className="space-y-2">
                <Label>
                  Commencement Date <span className="text-destructive">*</span>
                </Label>
                <Input
                  type="date"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label>
                  Tenure <span className="text-destructive">*</span>
                </Label>
                <Select value={String(tenureMonths)} onValueChange={handleTenureChange}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {[6, 12, 18, 24, 36].map((m) => (
                      <SelectItem key={m} value={String(m)}>
                        {m} months
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>
                  Lock-in Period <span className="text-destructive">*</span>
                </Label>
                <Select value={String(lockInMonths)} onValueChange={(v) => setLockInMonths(parseInt(v))}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Array.from({ length: tenureMonths }, (_, i) => i + 1).map((m) => (
                      <SelectItem key={m} value={String(m)}>
                        {m} month{m !== 1 ? "s" : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Security Deposit (x Monthly Fee)</Label>
                <Input
                  type="number"
                  min={0}
                  step={0.5}
                  value={securityDepositMonths}
                  onChange={(e) => setSecurityDepositMonths(Number(e.target.value) || 0)}
                />
              </div>
              <div className="space-y-2">
                <Label>Escalation %</Label>
                <Input
                  type="number"
                  min={0}
                  max={100}
                  value={escalationPercentage}
                  onChange={(e) => setEscalationPercentage(Number(e.target.value) || 0)}
                />
              </div>
            </div>

            {/* Calculated summary */}
            {monthlyFee > 0 && startDate && (
              <div className="rounded-md border bg-muted/30 p-4 text-sm space-y-1">
                {calculatedEndDate && (
                  <p>
                    <span className="text-muted-foreground">End Date:</span>{" "}
                    <span className="font-medium">
                      {new Date(calculatedEndDate).toLocaleDateString("en-IN", {
                        year: "numeric", month: "short", day: "numeric",
                      })}
                    </span>
                  </p>
                )}
                <p>
                  <span className="text-muted-foreground">Lock-in / Commitment Term:</span>{" "}
                  <span className="font-medium">{lockInMonths} months</span>
                </p>
                <p>
                  <span className="text-muted-foreground">Notice Period:</span>{" "}
                  <span className="font-medium">{noticePeriodMonths} months</span>
                </p>
                <p>
                  <span className="text-muted-foreground">Security Deposit (IFRSD):</span>{" "}
                  <span className="font-medium">{formatCurrency(ifrsdAmount)}</span>
                  <span className="text-muted-foreground text-xs ml-1">({securityDepositMonths}x)</span>
                </p>
                <p>
                  <span className="text-muted-foreground">Monthly Fee:</span>{" "}
                  <span className="font-medium">{formatCurrency(monthlyFee)}</span>
                  <span className="text-muted-foreground text-xs ml-1">+ 18% GST ({formatCurrency(monthlyFee * 0.18)})</span>
                </p>
                <p>
                  <span className="text-muted-foreground">Monthly Fee incl. GST:</span>{" "}
                  <span className="font-semibold">{formatCurrency(monthlyFee * 1.18)}</span>
                </p>
              </div>
            )}
          </div>

          {/* Section 5: Signatory */}
          <div className="space-y-3">
            <Label className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              Member Signatory
            </Label>
            <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
              <div className="space-y-2">
                <Label>
                  Authorized Signatory <span className="text-destructive">*</span>
                </Label>
                <Input
                  value={signatoryName}
                  onChange={(e) => setSignatoryName(e.target.value)}
                  placeholder="Full name"
                />
              </div>
              <div className="space-y-2">
                <Label>
                  Designation <span className="text-destructive">*</span>
                </Label>
                <Input
                  value={signatoryDesignation}
                  onChange={(e) => setSignatoryDesignation(e.target.value)}
                  placeholder="e.g. Managing Director"
                />
              </div>
              <div className="space-y-2">
                <Label>Signatory ID Type</Label>
                <Select
                  value={signatoryIdType}
                  onValueChange={(v) => {
                    setSignatoryIdType(v as 'pan' | 'aadhaar');
                    setSignatoryPan(""); // clear on type switch
                  }}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="pan">PAN</SelectItem>
                    <SelectItem value="aadhaar">Aadhaar</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>
                  {signatoryIdType === 'aadhaar' ? 'Signatory Aadhaar' : 'Signatory PAN'}
                </Label>
                <Input
                  value={signatoryPan}
                  onChange={(e) => {
                    const val = e.target.value;
                    if (signatoryIdType === 'aadhaar') {
                      // Allow only digits for Aadhaar
                      setSignatoryPan(val.replace(/\D/g, ""));
                    } else {
                      setSignatoryPan(val.toUpperCase());
                    }
                  }}
                  placeholder={signatoryIdType === 'aadhaar' ? '12-digit Aadhaar number' : 'e.g. ABCDE1234F'}
                  maxLength={signatoryIdType === 'aadhaar' ? 12 : 10}
                  inputMode={signatoryIdType === 'aadhaar' ? 'numeric' : 'text'}
                />
              </div>
              <div className="space-y-2">
                <Label>
                  Agreement Date <span className="text-destructive">*</span>
                </Label>
                <Input
                  type="date"
                  value={agreementDate}
                  onChange={(e) => setAgreementDate(e.target.value)}
                />
              </div>
            </div>
          </div>

          {/* Section 6: Notes */}
          <div className="space-y-2">
            <Label>Internal Notes</Label>
            <Textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Internal notes (not shown in agreement)..."
              rows={2}
            />
          </div>

          {/* KYC Documents Required */}
          {lead?.entity_type && KYC_DOCUMENTS[lead.entity_type] && (
            <div className="rounded-md border border-amber-300 bg-amber-50 p-4 space-y-2">
              <div className="flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 text-amber-600" />
                <Label className="text-sm font-semibold text-amber-800">
                  KYC Documents Required — {ENTITY_TYPE_LABELS[lead.entity_type] || lead.entity_type}
                </Label>
              </div>
              <p className="text-xs text-amber-700">
                Collect these documents from the customer for contract activation:
              </p>
              <ul className="text-xs text-amber-800 space-y-1 ml-5 list-disc">
                {KYC_DOCUMENTS[lead.entity_type].map((doc) => (
                  <li key={doc}>{doc}</li>
                ))}
              </ul>
            </div>
          )}
          {!lead?.entity_type && (
            <div className="rounded-md border border-red-200 bg-red-50 p-3">
              <div className="flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 text-red-500" />
                <p className="text-xs text-red-700">
                  Customer profile type not set on lead. Go to the lead page to set entity type (Individual, Company, LLP, etc.) for KYC document requirements.
                </p>
              </div>
            </div>
          )}

          {/* Actions */}
          <div className="flex justify-end gap-2 pt-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => handleOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Create Agreement
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
