"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Loader2,
  AlertTriangle,
  CheckCircle2,
  ArrowLeft,
  ArrowRight,
  Plus,
  Trash2,
  Eye,
  Copy,
  Check,
  ExternalLink,
  Mail,
  RefreshCw,
  Clock,
  XCircle,
  PenLine,
} from "lucide-react";
import { toast } from "sonner";
import { BILLING_CYCLES, BILLING_CYCLE_LABELS, KYC_DOCUMENTS, ENTITY_TYPE_LABELS } from "@/lib/constants";
import { formatCurrency, formatDate, preventEnterSubmit, cn } from "@/lib/utils";
import { LocationSelector } from "@/components/shared/location-selector";
import { SpaceAllocationSelector } from "@/components/spaces/space-allocation-selector";
import { PageBreadcrumb } from "@/components/page-breadcrumb";
import { ContractDocumentsTab } from "@/components/contracts/contract-documents-tab";
import { ContractFacilitiesSection } from "@/components/contracts/contract-facilities-section";
import { ContractQuotasSection } from "@/components/contracts/contract-quotas-section";
import { ContractElectricityTab } from "@/components/contracts/contract-electricity-tab";
import { ContractContactsPanel } from "@/components/contracts/contract-contacts-panel";
import { ContractMembersAccessSection } from "@/components/contracts/contract-members-access-section";
import { ContractVouchersSection } from "@/components/contracts/contract-vouchers-section";
import { ContractAddonsSection } from "@/components/contracts/contract-addons-section";
import { ContractDepositTopupsSection } from "@/components/contracts/contract-deposit-topups-section";
import { ContractDepositSection } from "@/components/contracts/contract-deposit-section";
import { ContractSpaceManager, validateSpaceAllocation } from "@/components/contracts/contract-space-manager";
import { SeatOccupantsPanel } from "@/components/spaces/seat-occupants-panel";
import { ContractMoratoriumSection } from "@/components/contracts/contract-moratorium-section";
import { ContractDepositAdjustmentsSection } from "@/components/contracts/contract-deposit-adjustments-section";
import { ContractServiceUsageSection } from "@/components/contracts/contract-service-usage-section";
import { useCurrentUser } from "@/providers/current-user-provider";
import { useLeegalityEnabled } from "@/hooks/use-leegality-enabled";
import { createClient as createBrowserClient } from "@/lib/supabase/client";
import { prepareUpload, UploadTooLargeError } from "@/lib/uploads/upload-gate";
import { generateStampReference } from "@/lib/company-stamp";
import type { Proposal, Lead, Contract, ContractSpaceAllocation } from "@/types";

// Contract Onboarding Wizard — full local test build covering all 12 steps
// derived from the 13-step handoff spec (handoff_contract_UI_wizard/README.md).
// Steps 1–2 merge "Link Proposal & Member Details" and "Agreement, Commercial
// Terms & Signatory" — see the comment on handleCreateDraft for why (POST
// /api/contracts requires member_signatory_* fields at creation time, and
// there's no PATCH path to backfill them afterwards).
//
// Recurring Add-ons and Deposit Top-ups were never in the original 13-step
// spec — added afterwards, folded into steps 3 and 10 respectively rather
// than as separate steps, matching their placement on the real contract page.
//
// Steps 3–12 all operate against the real persisted contract/lead: rate
// phases are a full-replace PUT; KYC/facilities/quotas/electricity/contacts/
// addons/deposit-topups/members/vouchers all reuse the existing section
// components as-is (no reimplementation); billing emails live on the lead,
// same PATCH /api/leads/{id} endpoint as step 1; e-sign/stamp ports the real
// contract page's handlers (handleGeneratePDFBase64 et al.) since PDF
// generation is a pure, importable utility, not a reusable component. There's
// no "Back" into steps 1–2 once the draft exists — re-submitting that form
// would create a second contract, since POST /api/contracts has no upsert
// semantics.
//
// Step 10 (Activate) is the one place this wizard diverges from a pure UI
// reshuffle: CONTRACT_STATUS_TRANSITIONS has no draft→active edge, only
// draft→sent→accepted→active, so "Activate Contract" drives that whole
// chain in the background — confirmed against a real test contract that
// none of the intermediate transitions (sent, accepted) fire emails or
// other side effects. Matches the product decision from the handoff review:
// KYC stays a client-only informational gate (not server-enforced, same as
// today), and there's no "blank start" mode (every contract is
// proposal-linked, matching POST /api/contracts's real requirement).
//
// Step 11 (e-Sign/Stamp): "Send for e-Signing" hits the real Leegality API
// (live credentials are configured in this environment) — be deliberate
// about clicking it outside a genuine test. "Stamp with company seal" and
// document upload are internal-only and safe to test freely.
//
// Entry point is not wired up yet — this route is reachable only by direct
// URL for local testing: /contracts/onboarding?lead_id=<uuid>[&proposal_id=<uuid>]

const STEPS = [
  { id: 1, label: "Proposal & Member" },
  { id: 2, label: "Agreement & Signatory" },
  { id: 3, label: "Add-ons, Rate & Space" },
  { id: 4, label: "KYC Documents" },
  { id: 5, label: "Facilities & Quotas" },
  { id: 6, label: "Electricity" },
  { id: 7, label: "Billing Mode" },
  { id: 8, label: "Billing Emails" },
  { id: 9, label: "Contacts" },
  { id: 10, label: "Activate" },
  { id: 11, label: "e-Sign / Stamp" },
  { id: 12, label: "Members & Vouchers" },
] as const;

const STATUS_ORDER = ["draft", "sent", "accepted", "active"] as const;

function StepBar({ active }: { active: number }) {
  return (
    <div className="flex items-center gap-0">
      {STEPS.map((step, i) => {
        const done = step.id < active;
        const current = step.id === active;
        return (
          <div key={step.id} className="flex items-center">
            <div className="flex flex-col items-center gap-1">
              <div
                className={cn(
                  "w-7 h-7 rounded-full flex items-center justify-center text-xs font-semibold border-2 transition-all",
                  done
                    ? "bg-green-500 border-green-500 text-white"
                    : current
                    ? "bg-[#015E65] border-[#015E65] text-white shadow-sm"
                    : "bg-background border-border text-muted-foreground"
                )}
              >
                {done ? <CheckCircle2 size={14} strokeWidth={2.5} /> : step.id}
              </div>
              <span
                className={cn(
                  "text-[10px] font-medium whitespace-nowrap",
                  done ? "text-green-600" : current ? "text-[#015E65]" : "text-muted-foreground"
                )}
              >
                {step.label}
              </span>
            </div>
            {i < STEPS.length - 1 && (
              <div
                className={cn(
                  "h-0.5 w-10 mb-4 mx-1 transition-colors",
                  step.id < active ? "bg-green-400" : "bg-border"
                )}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

function GateRow({ label, ok, detail }: { label: string; ok: boolean; detail: string }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5 border-b last:border-b-0">
      <div className="flex items-center gap-2">
        <div
          className={cn(
            "w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold shrink-0",
            ok ? "bg-green-100 text-green-700" : "bg-amber-100 text-amber-700"
          )}
        >
          {ok ? "✓" : "!"}
        </div>
        <span className="text-sm">{label}</span>
      </div>
      <span className="text-xs text-muted-foreground">{detail}</span>
    </div>
  );
}

export default function ContractOnboardingPage() {
  return (
    <Suspense fallback={<div className="py-12 text-center text-muted-foreground">Loading…</div>}>
      <ContractOnboardingWizard />
    </Suspense>
  );
}

function ContractOnboardingWizard() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const leadId = searchParams.get("lead_id");
  const defaultProposalId = searchParams.get("proposal_id") || undefined;

  const { user: currentUser } = useCurrentUser();
  const userRole = currentUser?.role ?? null;
  const { enabled: leegalityEnabled } = useLeegalityEnabled();

  const [step, setStep] = useState<1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12>(1);

  // Set once the draft contract is created at the end of step 2. Steps 3–4
  // operate against this real contract, not client-side wizard state.
  const [contractId, setContractId] = useState<string | null>(null);
  const [contractNumber, setContractNumber] = useState<string | null>(null);
  const [kycSatisfied, setKycSatisfied] = useState(false);
  const [kycStatus, setKycStatus] = useState({ total: 0, approved: 0, deferred: 0 });

  // Space allocation (step 3, post-creation full manager) — mirrors ContractSpaceManager's
  // onAllocationsChange pattern from the real contract page, so activation can run the same
  // validateSpaceAllocation check and SeatOccupantsPanel can render off the same array.
  const [spaceAllocations, setSpaceAllocations] = useState<ContractSpaceAllocation[]>([]);
  const [spaceWarningOpen, setSpaceWarningOpen] = useState(false);
  const [deferredActivateOpen, setDeferredActivateOpen] = useState(false);

  // Rate phases (step 3, optional) — kept as strings while editing so an
  // empty/partial number field doesn't fight the input; coerced to numbers
  // only when saving.
  const [ratePhases, setRatePhases] = useState<
    Array<{ durationMonths: string; monthlyRate: string; endDate: string }>
  >([]);
  const [savingPhases, setSavingPhases] = useState(false);

  // Printer department ID (step 5) — separate from the facilities/quotas
  // sections below it, which manage their own state/API calls internally.
  const [departmentId, setDepartmentId] = useState("");
  const [savedDepartmentId, setSavedDepartmentId] = useState<string | null>(null);
  const [savingDepartmentId, setSavingDepartmentId] = useState(false);

  // Billing mode (step 7) and billing emails (step 8) — billing emails live
  // on the lead, not the contract (PATCH /api/leads/{id}, same endpoint as
  // step 1), per the corrected README.
  const [billingMode, setBillingMode] = useState<"proforma_first" | "gst_direct">("proforma_first");
  const [savingBillingMode, setSavingBillingMode] = useState(false);
  const [billingEmails, setBillingEmails] = useState<string[]>([]);
  const [savingBillingEmails, setSavingBillingEmails] = useState(false);

  // Activation (step 10) — the checklist below is informational only, read
  // fresh from the server on entering this step. It is NOT the source of
  // truth for whether activation is allowed: per the corrected README, the
  // PATCH's error response is authoritative, since server state (e.g. a
  // webhook flipping payment status) can be more current than this snapshot.
  const [activationContract, setActivationContract] = useState<Contract | null>(null);
  const [activationProposal, setActivationProposal] = useState<{
    payment_status?: string;
    deposit_payment_status?: string;
    security_deposit_months?: number;
    deposit_claimed_by_contract_id?: string | null;
  } | null>(null);
  const [loadingActivationData, setLoadingActivationData] = useState(false);
  const [overrideReason, setOverrideReason] = useState("");
  const [activating, setActivating] = useState(false);
  const [activated, setActivated] = useState(false);

  // e-Sign / Stamp (step 11) — ports the real contract page's handlers
  // (handleGeneratePDFBase64 / handleInitiateSigning / handleOpenStampPreview
  // / handleStampSignSeal / handleSignedDocUpload) rather than reimplementing
  // PDF generation; they only ever depended on the contract object + id.
  const [fullContract, setFullContract] = useState<Contract | null>(null);
  const [loadingFullContract, setLoadingFullContract] = useState(false);
  const [signSending, setSignSending] = useState(false);
  const [stamping, setStamping] = useState(false);
  const [stampPreview, setStampPreview] = useState<{ pdfBase64: string; stampRef: string; previewUrl: string } | null>(
    null
  );
  const [uploadingSignedDoc, setUploadingSignedDoc] = useState(false);
  const [copiedLessor, setCopiedLessor] = useState(false);
  const [copiedLessee, setCopiedLessee] = useState(false);
  const [checkingSigningStatus, setCheckingSigningStatus] = useState(false);

  const [lead, setLead] = useState<Lead | null>(null);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [loadingData, setLoadingData] = useState(false);

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

  // Commercial terms — monthlyFee is always inherited from the linked
  // proposal server-side (createContractSchema ignores it), so it's a
  // read-only display here, not an editable field.
  const [monthlyFee, setMonthlyFee] = useState<number>(0);
  const [billingCycle, setBillingCycle] = useState("");
  const [seats, setSeats] = useState<number>(1);
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [tenureMonths, setTenureMonths] = useState<number>(12);
  const [lockInMonths, setLockInMonths] = useState<number>(10);
  const [noticePeriodMonths, setNoticePeriodMonths] = useState<number>(2);
  const [securityDepositMonths, setSecurityDepositMonths] = useState<number>(3.0);
  const [escalationPercentage, setEscalationPercentage] = useState<number>(10.0);

  // Signatory — collected here (not in a later "Space Allocation" step) since
  // POST /api/contracts requires these fields and there's no PATCH path to
  // set them after creation.
  const [signatoryName, setSignatoryName] = useState("");
  const [signatoryDesignation, setSignatoryDesignation] = useState("");
  const [signatoryPan, setSignatoryPan] = useState("");
  const [signatoryIdType, setSignatoryIdType] = useState<"pan" | "aadhaar">("pan");
  const [agreementDate, setAgreementDate] = useState(new Date().toISOString().split("T")[0]);

  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // Space allocation — optional, created after the contract exists.
  const [selectedSpaceUnitIds, setSelectedSpaceUnitIds] = useState<string[]>([]);

  useEffect(() => {
    if (!leadId) return;
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
          setBillingEmails(l.billing_emails && l.billing_emails.length > 0 ? l.billing_emails : [""]);
        }
        const loaded: Proposal[] = proposalsJson.data || [];
        setProposals(loaded);
        if (defaultProposalId && loaded.some((p) => p.id === defaultProposalId)) {
          setSelectedProposalId(defaultProposalId);
        }
      })
      .catch(() => toast.error("Failed to load lead/proposal data"))
      .finally(() => setLoadingData(false));
  }, [leadId, defaultProposalId]);

  const selectedProposal = useMemo(
    () => proposals.find((p) => p.id === selectedProposalId) || null,
    [proposals, selectedProposalId]
  );

  const proposalComplimentaryItems = useMemo(() => {
    if (!selectedProposal) return [];
    const items = (selectedProposal as unknown as {
      complimentary_items?: Array<{ name: string; unit: string; quantity: number; price_per_unit: number }>;
    }).complimentary_items;
    return (items || []).filter((i) => i.name?.trim() && i.unit?.trim());
  }, [selectedProposal]);

  // Auto-populate from selected proposal
  useEffect(() => {
    if (!selectedProposal) return;
    setMonthlyFee(selectedProposal.subtotal ?? selectedProposal.total_amount);
    const proposalSeats = (selectedProposal.items ?? [])
      .filter((i) => (i.unit_price ?? 0) > 0)
      .reduce((sum, i) => sum + (i.quantity || 0), 0);
    if (proposalSeats > 0) setSeats(proposalSeats);
    if (selectedProposal.location_id) setLocationId(selectedProposal.location_id);
    if (selectedProposal.prorata_paid_date || selectedProposal.occupation_start_date) {
      setStartDate(selectedProposal.prorata_paid_date || selectedProposal.occupation_start_date || "");
    }
    if (selectedProposal.security_deposit_months) {
      setSecurityDepositMonths(selectedProposal.security_deposit_months);
    }
    if (selectedProposal.description) setComplimentaryServices(selectedProposal.description);
    if (selectedProposal.notes) setNotes(selectedProposal.notes);
    if (selectedProposal.title) {
      const itemsSummary = selectedProposal.items
        ?.map((item) => `${item.quantity}${item.unit ? " " + item.unit : ""} ${item.description}`)
        .join(", ");
      setWorkspaceDescription(itemsSummary ? `${selectedProposal.title} — ${itemsSummary}` : selectedProposal.title);
    }
  }, [selectedProposal]);

  const derivedTenureMonths = useMemo(() => {
    if (!startDate || !endDate || endDate < startDate) return 0;
    const s = new Date(startDate + "T00:00:00Z");
    const e = new Date(endDate + "T00:00:00Z");
    e.setUTCDate(e.getUTCDate() + 1);
    let months = (e.getUTCFullYear() - s.getUTCFullYear()) * 12 + (e.getUTCMonth() - s.getUTCMonth());
    if (e.getUTCDate() < s.getUTCDate()) months -= 1;
    return Math.max(1, months);
  }, [startDate, endDate]);

  const durationLabel = useMemo(() => {
    if (!startDate || !endDate || endDate < startDate) return "";
    const s = new Date(startDate + "T00:00:00Z");
    const e = new Date(endDate + "T00:00:00Z");
    e.setUTCDate(e.getUTCDate() + 1);
    let months = (e.getUTCFullYear() - s.getUTCFullYear()) * 12 + (e.getUTCMonth() - s.getUTCMonth());
    let days = e.getUTCDate() - s.getUTCDate();
    if (days < 0) {
      months -= 1;
      days += new Date(Date.UTC(e.getUTCFullYear(), e.getUTCMonth(), 0)).getUTCDate();
    }
    const parts: string[] = [];
    if (months > 0) parts.push(`${months} month${months !== 1 ? "s" : ""}`);
    if (days > 0) parts.push(`${days} day${days !== 1 ? "s" : ""}`);
    return parts.join(", ") || "0 days";
  }, [startDate, endDate]);

  const ifrsdAmount = monthlyFee * securityDepositMonths;
  const maxNoticePeriod = Math.max(3, derivedTenureMonths - lockInMonths);

  useEffect(() => {
    if (startDate && !endDate && tenureMonths) {
      const s = new Date(startDate + "T00:00:00Z");
      s.setUTCMonth(s.getUTCMonth() + tenureMonths);
      s.setUTCDate(s.getUTCDate() - 1);
      setEndDate(s.toISOString().split("T")[0]);
    }
  }, [startDate, endDate, tenureMonths]);

  useEffect(() => {
    if (derivedTenureMonths > 0) {
      setLockInMonths((prev) => Math.min(prev, derivedTenureMonths));
      setNoticePeriodMonths((prev) => Math.min(prev, Math.max(3, derivedTenureMonths)));
    }
  }, [derivedTenureMonths]);

  const handleTenureChange = useCallback(
    (val: string) => {
      const t = parseInt(val);
      setTenureMonths(t);
      if (startDate) {
        const s = new Date(startDate + "T00:00:00Z");
        s.setUTCMonth(s.getUTCMonth() + t);
        s.setUTCDate(s.getUTCDate() - 1);
        setEndDate(s.toISOString().split("T")[0]);
      }
    },
    [startDate]
  );

  const handleLockInChange = useCallback(
    (val: string) => {
      const l = parseInt(val);
      setLockInMonths(l);
      const newMax = Math.max(3, derivedTenureMonths - l);
      setNoticePeriodMonths((prev) => (prev > newMax ? newMax : prev));
    },
    [derivedTenureMonths]
  );

  const missingCompany = !company.trim();
  const missingAddress = !street.trim() && !city.trim();

  const goNext = useCallback(() => {
    if (!selectedProposalId) {
      toast.error("Please select an accepted proposal to link to this contract");
      return;
    }
    if (!company.trim()) {
      toast.error("Company/Member name is required for the agreement");
      return;
    }
    setStep(2);
  }, [selectedProposalId, company]);

  const handleCreateContract = useCallback(async () => {
    if (!leadId) return;
    if (!workspaceDescription.trim()) {
      toast.error("Workspace description is required");
      return;
    }
    if (!locationId) {
      toast.error("Please select a location");
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
    if (!endDate) {
      toast.error("Please select an end date");
      return;
    }
    if (endDate < startDate) {
      toast.error("End date must be on or after the start date");
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
      const leadRes = await fetch(`/api/leads/${leadId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(leadUpdates),
      }).catch(() => null);
      if (!leadRes || !leadRes.ok) {
        const err = await leadRes?.json().catch(() => null);
        toast.error(
          err?.error ||
            "Failed to save the member detail changes — the contract will still be created, but re-check the lead's company/PAN/GST/address afterward."
        );
      }
    }

    const body = {
      lead_id: leadId,
      proposal_id: selectedProposalId,
      location_id: locationId || undefined,
      billing_cycle: billingCycle,
      tenure_months: derivedTenureMonths,
      start_date: startDate,
      end_date: endDate,
      seats,
      monthly_membership_fee: monthlyFee,
      workspace_description: workspaceDescription.trim(),
      parking_space: parkingSpace.trim() || undefined,
      complimentary_services: complimentaryServices.trim() || undefined,
      security_deposit_months: securityDepositMonths,
      escalation_percentage: escalationPercentage,
      notice_period_months: noticePeriodMonths,
      lock_in_months: lockInMonths,
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

    if (!res.ok) {
      setSubmitting(false);
      const err = await res.json().catch(() => null);
      toast.error(err?.error || "Failed to create agreement");
      return;
    }

    const contractJson = await res.json();
    const newContractId: string = contractJson.data?.id;
    const newContractNumber: string | undefined = contractJson.data?.contract_number;

    if (newContractId && selectedSpaceUnitIds.length > 0) {
      const allocResults = await Promise.all(
        selectedSpaceUnitIds.map((unitId) =>
          fetch(`/api/contracts/${newContractId}/space-allocations`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ space_unit_id: unitId, start_date: startDate }),
          }).then((r) => r.ok)
        )
      );
      const failedCount = allocResults.filter((ok) => !ok).length;
      if (failedCount > 0) {
        toast.error(
          `${failedCount} of ${selectedSpaceUnitIds.length} space unit(s) failed to allocate — check Space Unit Assignment on the full contract page.`
        );
      }
    }

    setSubmitting(false);
    setContractId(newContractId);
    setContractNumber(newContractNumber || null);
    toast.success(`Draft agreement ${newContractNumber || ""} created — continuing to Rate Schedule & KYC`);
    setStep(3);
  }, [
    leadId, workspaceDescription, locationId, billingCycle, startDate, endDate, seats,
    signatoryName, signatoryDesignation, lead, company, panNumber, gstNumber, street, city,
    state, zipCode, country, selectedProposalId, derivedTenureMonths, monthlyFee, parkingSpace,
    complimentaryServices, securityDepositMonths, escalationPercentage, noticePeriodMonths,
    lockInMonths, signatoryPan, signatoryIdType, agreementDate, notes, selectedSpaceUnitIds,
  ]);

  const addRatePhase = useCallback(() => {
    setRatePhases((prev) => [
      ...prev,
      { durationMonths: "6", monthlyRate: String(monthlyFee), endDate: "" },
    ]);
  }, [monthlyFee]);

  const updateRatePhase = useCallback((idx: number, field: "durationMonths" | "monthlyRate" | "endDate", value: string) => {
    setRatePhases((prev) => prev.map((p, i) => (i === idx ? { ...p, [field]: value } : p)));
  }, []);

  const removeRatePhase = useCallback((idx: number) => {
    setRatePhases((prev) => prev.filter((_, i) => i !== idx));
  }, []);

  const saveRatePhasesAndContinue = useCallback(async () => {
    if (!contractId) return;
    if (ratePhases.length === 0) {
      setStep(4);
      return;
    }
    for (const p of ratePhases) {
      if (!p.durationMonths || Number(p.durationMonths) <= 0) {
        toast.error("Each phase needs a duration in months (1 or more)");
        return;
      }
      if (p.monthlyRate === "" || Number(p.monthlyRate) < 0) {
        toast.error("Each phase needs a monthly rate (0 or more)");
        return;
      }
    }
    setSavingPhases(true);
    const res = await fetch(`/api/contracts/${contractId}/rate-phases`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        phases: ratePhases.map((p, i) => ({
          phase_order: i + 1,
          duration_months: Number(p.durationMonths),
          monthly_rate: Number(p.monthlyRate),
          end_date: p.endDate || undefined,
        })),
      }),
    });
    setSavingPhases(false);
    if (!res.ok) {
      const err = await res.json().catch(() => null);
      toast.error(err?.error || "Failed to save rate phases");
      return;
    }
    toast.success("Rate schedule saved");
    setStep(4);
  }, [contractId, ratePhases]);

  const handleKycStatusChange = useCallback((allSatisfied: boolean, total: number, approved: number, deferred: number) => {
    setKycSatisfied(allSatisfied);
    setKycStatus({ total, approved, deferred });
  }, []);

  const handleSpaceAllocationsChange = useCallback((allocs: ContractSpaceAllocation[]) => {
    setSpaceAllocations(allocs);
  }, []);

  const saveDepartmentId = useCallback(async () => {
    if (!contractId) return;
    setSavingDepartmentId(true);
    const res = await fetch(`/api/contracts/${contractId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ department_id: departmentId.trim() || null }),
    });
    setSavingDepartmentId(false);
    if (!res.ok) {
      const err = await res.json().catch(() => null);
      toast.error(err?.error || "Failed to save department ID");
      return;
    }
    setSavedDepartmentId(departmentId.trim() || null);
    toast.success(departmentId.trim() ? "Department ID saved" : "Department ID cleared");
  }, [contractId, departmentId]);

  const saveBillingModeAndContinue = useCallback(async () => {
    if (!contractId) return;
    setSavingBillingMode(true);
    const res = await fetch(`/api/contracts/${contractId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ billing_mode: billingMode }),
    });
    setSavingBillingMode(false);
    if (!res.ok) {
      const err = await res.json().catch(() => null);
      toast.error(err?.error || "Failed to save billing mode");
      return;
    }
    toast.success("Billing mode saved");
    setStep(8);
  }, [contractId, billingMode]);

  const updateBillingEmail = useCallback((idx: number, value: string) => {
    setBillingEmails((prev) => prev.map((e, i) => (i === idx ? value : e)));
  }, []);
  const removeBillingEmail = useCallback((idx: number) => {
    setBillingEmails((prev) => prev.filter((_, i) => i !== idx));
  }, []);
  const addBillingEmail = useCallback(() => {
    setBillingEmails((prev) => [...prev, ""]);
  }, []);

  const saveBillingEmailsAndContinue = useCallback(async () => {
    if (!leadId) return;
    const cleaned = billingEmails.map((e) => e.trim()).filter(Boolean);
    setSavingBillingEmails(true);
    const res = await fetch(`/api/leads/${leadId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ billing_emails: cleaned }),
    });
    setSavingBillingEmails(false);
    if (!res.ok) {
      const err = await res.json().catch(() => null);
      toast.error(err?.error || "Failed to save billing emails");
      return;
    }
    toast.success("Billing emails saved");
    setStep(9);
  }, [leadId, billingEmails]);

  const fetchActivationData = useCallback(async () => {
    if (!contractId) return;
    setLoadingActivationData(true);
    try {
      const json = await fetch(`/api/contracts/${contractId}`).then((r) => r.json());
      const c = json.data;
      setActivationContract(c || null);
      if (c?.proposal_id) {
        const pj = await fetch(`/api/proposals/${c.proposal_id}`).then((r) => r.json());
        setActivationProposal(pj.data || null);
      }
    } catch {
      toast.error("Failed to load activation status");
    } finally {
      setLoadingActivationData(false);
    }
  }, [contractId]);

  useEffect(() => {
    if (step !== 10 || !contractId) return;
    fetchActivationData();
  }, [step, contractId, fetchActivationData]);

  // Drives the contract through its real status transitions
  // (draft → sent → accepted → active) invisibly, since the API has no
  // direct draft→active shortcut (CONTRACT_STATUS_TRANSITIONS only allows
  // draft→sent). Resumes from wherever the contract currently is, so retrying
  // after a blocked attempt (e.g. after recording a payment elsewhere) only
  // runs the remaining transitions. The gate checklist above is a preview —
  // whichever PATCH call actually fails is the authoritative reason.
  const runActivation = useCallback(async () => {
    if (!contractId) return;
    setActivating(true);
    const curRes = await fetch(`/api/contracts/${contractId}`).catch(() => null);
    if (!curRes || !curRes.ok) {
      setActivating(false);
      toast.error("Failed to check the contract's current status — try again.");
      return;
    }
    const cur = await curRes.json().catch(() => null);
    const currentStatus = cur?.data?.status as string | undefined;
    if (!currentStatus) {
      setActivating(false);
      toast.error("Failed to check the contract's current status — try again.");
      return;
    }
    const startIdx = STATUS_ORDER.indexOf(currentStatus as (typeof STATUS_ORDER)[number]);
    if (startIdx < 0 || startIdx >= STATUS_ORDER.length - 1) {
      setActivating(false);
      if (currentStatus === "active") {
        setActivated(true);
        toast.success("Contract is already active");
      } else {
        toast.error(`Contract is in status "${currentStatus}" — can't activate from here. Check the full contract page.`);
      }
      return;
    }
    for (let i = startIdx; i < STATUS_ORDER.length - 1; i++) {
      const nextStatus = STATUS_ORDER[i + 1];
      const body: Record<string, string> = { status: nextStatus };
      if (nextStatus === "active" && overrideReason.trim()) {
        body.payment_override_reason = overrideReason.trim();
      }
      const res = await fetch(`/api/contracts/${contractId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => null);
        toast.error(err?.error || `Failed to move contract to "${nextStatus}"`);
        setActivating(false);
        // Re-fetch, since an earlier transition in this same run (e.g.
        // draft→sent) may have succeeded before this one failed.
        fetch(`/api/contracts/${contractId}`)
          .then((r) => r.json())
          .then((j) =>
            setActivationContract((prev) => (prev ? { ...prev, status: j.data?.status || prev.status } : prev))
          )
          .catch(() => {});
        return;
      }
    }
    setActivating(false);
    setActivated(true);
    setActivationContract((prev) => (prev ? { ...prev, status: "active" } : prev));
    toast.success("Contract activated");
  }, [contractId, overrideReason]);

  // Mirrors the real contract page's attemptActivation(): checks assigned
  // space vs. contract seats first, and only proceeds straight to
  // runActivation() when allocation is sufficient — otherwise the user must
  // explicitly confirm past the under-allocation warning dialog.
  const attemptActivation = useCallback(() => {
    const validation = validateSpaceAllocation(spaceAllocations, seats);
    if (validation.isUnderAllocated) {
      setSpaceWarningOpen(true);
      return;
    }
    runActivation();
  }, [spaceAllocations, seats, runActivation]);

  const confirmActivationWithSpaceWarning = useCallback(() => {
    setSpaceWarningOpen(false);
    runActivation();
  }, [runActivation]);

  // Entry point for the "Activate Contract" button — mirrors the real page's
  // deferred-KYC confirmation gate, which sits in front of attemptActivation().
  const handleActivateClick = useCallback(() => {
    if (kycStatus.deferred > 0) {
      setDeferredActivateOpen(true);
      return;
    }
    attemptActivation();
  }, [kycStatus.deferred, attemptActivation]);

  const fetchFullContract = useCallback(async () => {
    if (!contractId) return;
    setLoadingFullContract(true);
    const json = await fetch(`/api/contracts/${contractId}`).then((r) => r.json()).catch(() => null);
    setFullContract(json?.data || null);
    setLoadingFullContract(false);
  }, [contractId]);

  useEffect(() => {
    if ((step === 11 || step === 12) && contractId && !fullContract) {
      fetchFullContract();
    }
  }, [step, contractId, fullContract, fetchFullContract]);

  const generatePDFBase64 = useCallback(
    async (options?: { applyCompanyStamp?: boolean; stampRef?: string }) => {
      if (!fullContract) throw new Error("Contract not loaded");
      const { generateMembershipAgreementPDF } = await import("@/lib/pdf-generator");
      const doc = generateMembershipAgreementPDF(fullContract, fullContract.lead, fullContract.location, options);
      const arrayBuffer = doc.output("arraybuffer");
      const bytes = new Uint8Array(arrayBuffer);
      let binary = "";
      for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
      return btoa(binary);
    },
    [fullContract]
  );

  const handleInitiateSigning = useCallback(async () => {
    if (!contractId) return;
    setSignSending(true);
    try {
      const pdfBase64 = await generatePDFBase64();
      const res = await fetch(`/api/contracts/${contractId}/sign`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "initiate", pdf_base64: pdfBase64 }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => null);
        toast.error(err?.error || "Failed to send for e-signing");
        return;
      }
      toast.success("Sent for e-signing via Leegality");
      await fetchFullContract();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to generate the agreement PDF");
    } finally {
      setSignSending(false);
    }
  }, [contractId, generatePDFBase64, fetchFullContract]);

  const copyToClipboard = useCallback((text: string, who: "lessor" | "lessee") => {
    navigator.clipboard.writeText(text);
    if (who === "lessor") {
      setCopiedLessor(true);
      setTimeout(() => setCopiedLessor(false), 2000);
    } else {
      setCopiedLessee(true);
      setTimeout(() => setCopiedLessee(false), 2000);
    }
  }, []);

  const handleCheckSigningStatus = useCallback(async () => {
    if (!contractId) return;
    setCheckingSigningStatus(true);
    try {
      const res = await fetch(`/api/contracts/${contractId}/sign`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "check_status" }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        toast.error(json?.error || "Failed to check signing status");
        return;
      }
      const status = json?.data?.status;
      toast.success(status === "COMPLETED" ? "Agreement fully signed!" : `Signing status: ${status}`);
    } finally {
      setCheckingSigningStatus(false);
      await fetchFullContract();
    }
  }, [contractId, fetchFullContract]);

  const handleViewSignedDoc = useCallback(async () => {
    if (!fullContract?.signed_document_id) return;
    try {
      const res = await fetch(`/api/documents/${fullContract.signed_document_id}/view`);
      if (res.ok) {
        const { signedUrl } = await res.json();
        window.open(signedUrl, "_blank");
        return;
      }
    } catch {
      // fall through to error toast below
    }
    toast.error("Failed to get download URL");
  }, [fullContract]);

  const handleOpenStampPreview = useCallback(async () => {
    setStamping(true);
    try {
      const stampRef = generateStampReference();
      const pdfBase64 = await generatePDFBase64({ applyCompanyStamp: true, stampRef });
      const byteChars = atob(pdfBase64);
      const bytes = new Uint8Array(byteChars.length);
      for (let i = 0; i < byteChars.length; i++) bytes[i] = byteChars.charCodeAt(i);
      const previewUrl = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
      setStampPreview({ pdfBase64, stampRef, previewUrl });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to generate the stamped PDF");
    } finally {
      setStamping(false);
    }
  }, [generatePDFBase64]);

  const closeStampPreview = useCallback(() => {
    setStampPreview((prev) => {
      if (prev) URL.revokeObjectURL(prev.previewUrl);
      return null;
    });
  }, []);

  const handleConfirmStamp = useCallback(async () => {
    if (!contractId || !stampPreview) return;
    setStamping(true);
    const res = await fetch(`/api/contracts/${contractId}/stamp-sign-seal`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pdfBase64: stampPreview.pdfBase64, stampRef: stampPreview.stampRef }),
    });
    setStamping(false);
    if (!res.ok) {
      const err = await res.json().catch(() => null);
      toast.error(err?.error || "Failed to stamp the agreement");
      return;
    }
    toast.success("Stamped with company seal");
    closeStampPreview();
    await fetchFullContract();
  }, [contractId, stampPreview, fetchFullContract, closeStampPreview]);

  const handleSignedDocUpload = useCallback(
    async (file: File) => {
      if (!contractId || !leadId) return;
      setUploadingSignedDoc(true);
      try {
        const prepared = await prepareUpload(file);
        if (!prepared) {
          toast.error("Unsupported file type");
          return;
        }
        const urlRes = await fetch("/api/documents/upload-url", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ fileName: prepared.name, mimeType: prepared.type, path: `signed-contracts/${contractId}` }),
        });
        if (!urlRes.ok) {
          const err = await urlRes.json().catch(() => null);
          toast.error(err?.error || "Failed to get an upload URL");
          return;
        }
        const { token, path } = await urlRes.json();
        const supabase = createBrowserClient();
        const { error: uploadErr } = await supabase.storage
          .from("crm-documents")
          .uploadToSignedUrl(path, token, prepared);
        if (uploadErr) {
          toast.error(uploadErr.message || "Upload failed");
          return;
        }
        const registerRes = await fetch("/api/documents/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: `Signed Agreement — ${fullContract?.contract_number || ""}`,
            fileName: prepared.name,
            filePath: path,
            mimeType: prepared.type,
            sizeBytes: prepared.size,
            category: "signed_contract",
            leadId,
          }),
        });
        if (!registerRes.ok) {
          const err = await registerRes.json().catch(() => null);
          toast.error(err?.error || "Failed to register the uploaded document");
          return;
        }
        const { data: doc } = await registerRes.json();
        const patchRes = await fetch(`/api/contracts/${contractId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ signed_document_id: doc.id }),
        });
        if (!patchRes.ok) {
          toast.error("Uploaded, but failed to link the document to the contract");
          return;
        }
        toast.success("Signed document uploaded");
        await fetchFullContract();
      } catch (e) {
        if (e instanceof UploadTooLargeError) {
          toast.error(e.message);
        } else {
          toast.error(e instanceof Error ? e.message : "Upload failed");
        }
      } finally {
        setUploadingSignedDoc(false);
      }
    },
    [contractId, leadId, fullContract, fetchFullContract]
  );

  if (!leadId) {
    return (
      <div className="max-w-2xl mx-auto py-12">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Contract Onboarding Wizard — local test entry</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground space-y-2">
            <p>This route isn&apos;t wired into any navigation yet — it&apos;s reachable only by direct URL for local testing.</p>
            <p>
              Append <code className="bg-muted px-1 py-0.5 rounded">?lead_id=&lt;uuid&gt;</code> to the URL
              (and optionally <code className="bg-muted px-1 py-0.5 rounded">&amp;proposal_id=&lt;uuid&gt;</code> to preselect
              an accepted proposal), pointing at a test lead that has at least one accepted proposal.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <PageBreadcrumb current={{ label: "Contract Onboarding" }} fallbackParent={{ href: "/contracts", label: "Contracts" }} />

      <div className="flex flex-wrap items-center justify-between gap-y-3 gap-x-4">
        <div>
          <h1 className="text-xl font-semibold">Contract Onboarding — {company || "New Member"}</h1>
          <p className="text-sm text-muted-foreground">
            {contractNumber ? `${contractNumber} — ${activated ? "Active" : "Draft"}` : "Draft"} — local test build
          </p>
        </div>
        <div className="max-w-full overflow-x-auto">
          <StepBar active={step} />
        </div>
      </div>

      {loadingData ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          <span className="ml-2 text-muted-foreground">Loading lead data…</span>
        </div>
      ) : (
        <form onKeyDown={preventEnterSubmit} className="space-y-6">
          {step === 1 && (
            <>
              <Card>
                <CardHeader>
                  <CardTitle className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                    Accepted Proposal <span className="text-destructive">*</span>
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  {proposals.length === 0 ? (
                    <div className="rounded-md border border-amber-300 bg-amber-50 p-4 space-y-1">
                      <div className="flex items-center gap-2">
                        <AlertTriangle className="h-4 w-4 text-amber-600 shrink-0" />
                        <p className="text-sm font-medium text-amber-800">No accepted proposals found</p>
                      </div>
                      <p className="text-xs text-amber-700 ml-6">
                        A contract can only be created from an accepted proposal. Accept a proposal for this lead first.
                      </p>
                    </div>
                  ) : (
                    <>
                      <Select value={selectedProposalId} onValueChange={setSelectedProposalId}>
                        <SelectTrigger>
                          <SelectValue placeholder="Select an accepted proposal…" />
                        </SelectTrigger>
                        <SelectContent>
                          {proposals.map((p) => (
                            <SelectItem key={p.id} value={p.id}>
                              {p.proposal_number} — {p.title} — {formatCurrency(p.total_amount)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>

                      {selectedProposal && (
                        <div className="rounded-md border border-[#015E65]/20 bg-[#015E65]/5 p-3 space-y-2">
                          <p className="text-xs font-semibold text-[#015E65] flex items-center gap-1.5">
                            <CheckCircle2 className="h-3.5 w-3.5" />
                            Commercials carried forward from {selectedProposal.proposal_number}
                          </p>
                          <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs">
                            <span className="text-muted-foreground">Monthly fee</span>
                            <span className="font-medium tabular-nums">
                              {formatCurrency(selectedProposal.subtotal ?? selectedProposal.total_amount)}
                            </span>
                            {selectedProposal.tax_percentage > 0 && (
                              <>
                                <span className="text-muted-foreground">GST ({selectedProposal.tax_percentage}%)</span>
                                <span className="font-medium tabular-nums">{formatCurrency(selectedProposal.tax_amount)}</span>
                              </>
                            )}
                            <span className="text-muted-foreground pt-1 border-t border-[#015E65]/10 font-semibold">Total</span>
                            <span className="font-semibold tabular-nums pt-1 border-t border-[#015E65]/10">
                              {formatCurrency(selectedProposal.total_amount)}
                            </span>
                          </div>
                          {proposalComplimentaryItems.length > 0 && (
                            <div className="pt-1 border-t border-[#015E65]/10 space-y-1">
                              <p className="text-[10px] font-semibold text-[#015E65] uppercase tracking-wide">
                                {proposalComplimentaryItems.length} complimentary service
                                {proposalComplimentaryItems.length !== 1 ? "s" : ""} auto-configured
                              </p>
                              {proposalComplimentaryItems.map((item, idx) => (
                                <div key={idx} className="flex items-center justify-between text-xs">
                                  <span className="font-medium text-foreground">{item.name}</span>
                                  <span className="text-muted-foreground tabular-nums">
                                    {item.quantity} {item.unit}/mo free
                                    {item.price_per_unit > 0
                                      ? ` · ₹${Number(item.price_per_unit).toLocaleString("en-IN")}/${item.unit} beyond`
                                      : " · no overage charge"}
                                  </span>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                    </>
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                    Member Details
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label>
                        Company / Member Name <span className="text-destructive">*</span>
                      </Label>
                      <Input
                        value={company}
                        onChange={(e) => setCompany(e.target.value)}
                        placeholder="Company name"
                        className={missingCompany ? "border-yellow-400 bg-yellow-50" : ""}
                      />
                      {missingCompany && (
                        <div className="flex items-center gap-1 text-xs text-yellow-600">
                          <AlertTriangle className="h-3 w-3" />
                          Required for agreement
                        </div>
                      )}
                    </div>
                    <div className="space-y-2">
                      <Label>PAN Number</Label>
                      <Input
                        value={panNumber}
                        onChange={(e) => setPanNumber(e.target.value.toUpperCase())}
                        placeholder="e.g. AABCA1234E"
                        maxLength={10}
                      />
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
                  </div>
                </CardContent>
              </Card>

              <div className="flex justify-end pt-2">
                <Button type="button" onClick={goNext} disabled={proposals.length === 0}>
                  Next
                  <ArrowRight className="ml-2 h-4 w-4" />
                </Button>
              </div>
            </>
          )}

          {step === 2 && (
            <>
              <Card>
                <CardHeader>
                  <CardTitle className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                    Agreement Details
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label>
                        Location <span className="text-destructive">*</span>
                      </Label>
                      <LocationSelector value={locationId} onValueChange={setLocationId} placeholder="Select center" required />
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
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                    Commercial Terms
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                    <div className="space-y-2">
                      <Label>Monthly Membership Fee</Label>
                      <Input value={formatCurrency(monthlyFee)} disabled className="bg-muted/40" />
                      <p className="text-xs text-muted-foreground">Set by the linked proposal — not editable here.</p>
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
                      <Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
                    </div>
                    <div className="space-y-2">
                      <Label>
                        End Date <span className="text-destructive">*</span>
                      </Label>
                      <Input
                        type="date"
                        value={endDate}
                        min={startDate || undefined}
                        onChange={(e) => setEndDate(e.target.value)}
                      />
                      {durationLabel && <p className="text-xs text-muted-foreground">Duration: {durationLabel}</p>}
                    </div>
                    <div className="space-y-2">
                      <Label>Tenure (quick-fill)</Label>
                      <Select value={String(tenureMonths)} onValueChange={handleTenureChange}>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {Array.from({ length: 18 }, (_, i) => i + 1).map((m) => (
                            <SelectItem key={m} value={String(m)}>
                              {m} month{m !== 1 ? "s" : ""}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-2">
                      <Label>
                        Lock-in Period <span className="text-destructive">*</span>
                      </Label>
                      <Select value={String(lockInMonths)} onValueChange={handleLockInChange}>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {Array.from({ length: Math.min(Math.max(derivedTenureMonths, 1), 18) }, (_, i) => i + 1).map((m) => (
                            <SelectItem key={m} value={String(m)}>
                              {m} month{m !== 1 ? "s" : ""}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-2">
                      <Label>
                        Notice Period <span className="text-destructive">*</span>
                      </Label>
                      <Select value={String(noticePeriodMonths)} onValueChange={(v) => setNoticePeriodMonths(parseInt(v))}>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {Array.from({ length: maxNoticePeriod + 1 }, (_, i) => i).map((m) => (
                            <SelectItem key={m} value={String(m)}>
                              {m === 0 ? "None (0 months)" : `${m} month${m !== 1 ? "s" : ""}`}
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

                  {monthlyFee > 0 && startDate && (
                    <div className="rounded-md border bg-muted/30 p-4 text-sm space-y-1">
                      <p>
                        <span className="text-muted-foreground">Term:</span>{" "}
                        <span className="font-medium">{durationLabel || "—"}</span>
                      </p>
                      <p>
                        <span className="text-muted-foreground">Security Deposit (IFRSD):</span>{" "}
                        <span className="font-medium">{formatCurrency(ifrsdAmount)}</span>
                      </p>
                      <p>
                        <span className="text-muted-foreground">Monthly Fee incl. GST:</span>{" "}
                        <span className="font-semibold">
                          {formatCurrency(monthlyFee * (1 + (selectedProposal?.tax_percentage ?? 18) / 100))}
                        </span>
                      </p>
                    </div>
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                    Member Signatory
                  </CardTitle>
                </CardHeader>
                <CardContent>
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
                          setSignatoryIdType(v as "pan" | "aadhaar");
                          setSignatoryPan("");
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
                      <Label>{signatoryIdType === "aadhaar" ? "Signatory Aadhaar" : "Signatory PAN"}</Label>
                      <Input
                        value={signatoryPan}
                        onChange={(e) => {
                          const val = e.target.value;
                          setSignatoryPan(signatoryIdType === "aadhaar" ? val.replace(/\D/g, "") : val.toUpperCase());
                        }}
                        placeholder={signatoryIdType === "aadhaar" ? "12-digit Aadhaar number" : "e.g. ABCDE1234F"}
                        maxLength={signatoryIdType === "aadhaar" ? 12 : 10}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label>
                        Agreement Date <span className="text-destructive">*</span>
                      </Label>
                      <Input type="date" value={agreementDate} onChange={(e) => setAgreementDate(e.target.value)} />
                    </div>
                  </div>
                </CardContent>
              </Card>

              {locationId && (
                <Card>
                  <CardHeader>
                    <CardTitle className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                      Space Unit Assignment (optional)
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <SpaceAllocationSelector
                      locationId={locationId}
                      selectedUnitIds={selectedSpaceUnitIds}
                      onChange={setSelectedSpaceUnitIds}
                    />
                  </CardContent>
                </Card>
              )}

              <Card>
                <CardHeader>
                  <CardTitle className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                    Internal Notes
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <Textarea
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    placeholder="Internal notes (not shown in agreement)…"
                    rows={2}
                  />
                </CardContent>
              </Card>

              {lead?.entity_type && KYC_DOCUMENTS[lead.entity_type] && (
                <div className="rounded-md border border-amber-300 bg-amber-50 p-4 space-y-2">
                  <div className="flex items-center gap-2">
                    <AlertTriangle className="h-4 w-4 text-amber-600" />
                    <Label className="text-sm font-semibold text-amber-800">
                      KYC Documents Required — {ENTITY_TYPE_LABELS[lead.entity_type] || lead.entity_type}
                    </Label>
                  </div>
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

              <div className="flex justify-between pt-2">
                <Button type="button" variant="outline" onClick={() => setStep(1)}>
                  <ArrowLeft className="mr-2 h-4 w-4" />
                  Back
                </Button>
                <Button type="button" onClick={handleCreateContract} disabled={submitting}>
                  {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  Create Agreement
                </Button>
              </div>
            </>
          )}

          {step === 3 && contractId && (
            <>
              <div className="rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground">
                Draft agreement <span className="font-medium text-foreground">{contractNumber}</span> created.
                Add recurring line items (name boards, parking, lockers), replace the flat monthly fee (₹
                {monthlyFee}) with a step schedule, and/or refine space unit assignment below — all optional here,
                and space allocation is checked again (softly) at activation.
              </div>

              <ContractAddonsSection
                contractId={contractId}
                contractStartDate={startDate}
                contractEndDate={endDate}
                taxPercentage={selectedProposal?.tax_percentage ?? 18}
              />

              <Card>
                <CardHeader>
                  <CardTitle className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                    Tiered Rate Schedule (optional)
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  {ratePhases.map((phase, idx) => (
                    <div key={idx} className="grid grid-cols-[auto_1fr_1fr_1fr_auto] gap-3 items-end">
                      <div className="text-xs font-medium text-muted-foreground pb-2 w-14">Phase {idx + 1}</div>
                      <div className="space-y-1">
                        <Label className="text-xs">Duration (months)</Label>
                        <Input
                          type="number"
                          min={1}
                          value={phase.durationMonths}
                          onChange={(e) => updateRatePhase(idx, "durationMonths", e.target.value)}
                        />
                      </div>
                      <div className="space-y-1">
                        <Label className="text-xs">Monthly rate (₹)</Label>
                        <Input
                          type="number"
                          min={0}
                          value={phase.monthlyRate}
                          onChange={(e) => updateRatePhase(idx, "monthlyRate", e.target.value)}
                        />
                      </div>
                      <div className="space-y-1">
                        <Label className="text-xs">End date (optional)</Label>
                        <Input
                          type="date"
                          value={phase.endDate}
                          onChange={(e) => updateRatePhase(idx, "endDate", e.target.value)}
                        />
                      </div>
                      <Button type="button" variant="ghost" size="icon" onClick={() => removeRatePhase(idx)}>
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    </div>
                  ))}
                  <Button type="button" variant="outline" size="sm" onClick={addRatePhase}>
                    <Plus className="mr-1 h-3.5 w-3.5" />
                    Add phase
                  </Button>
                  {ratePhases.length > 0 && (
                    <p className="text-xs text-muted-foreground">
                      Each phase&apos;s rate must be at least the contracted monthly fee (₹{monthlyFee}) — the
                      server rejects anything lower.
                    </p>
                  )}
                </CardContent>
              </Card>

              <ContractSpaceManager
                contractId={contractId}
                locationId={locationId}
                contractSeats={seats}
                contractStatus="draft"
                contractStartDate={startDate}
                contractEndDate={endDate}
                onAllocationsChange={handleSpaceAllocationsChange}
              />
              {locationId && spaceAllocations.length > 0 && (
                <Card>
                  <CardContent className="pt-4">
                    <SeatOccupantsPanel contractId={contractId} locationId={locationId} allocations={spaceAllocations} />
                  </CardContent>
                </Card>
              )}

              <div className="flex justify-end pt-2">
                <Button type="button" onClick={saveRatePhasesAndContinue} disabled={savingPhases}>
                  {savingPhases && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  {ratePhases.length > 0 ? "Save & Continue" : "Skip — Continue"}
                  <ArrowRight className="ml-2 h-4 w-4" />
                </Button>
              </div>
            </>
          )}

          {step === 4 && contractId && (
            <>
              <ContractDocumentsTab contractId={contractId} userRole={userRole} onKycStatusChange={handleKycStatusChange} />

              <div className="flex justify-end pt-2">
                <Button type="button" onClick={() => setStep(5)}>
                  Continue
                  <ArrowRight className="ml-2 h-4 w-4" />
                </Button>
              </div>
              {!kycSatisfied && (
                <p className="text-xs text-muted-foreground text-right">
                  KYC isn&apos;t fully resolved yet — that&apos;s fine here, it&apos;s only checked at activation
                  (client-side), same as today.
                </p>
              )}
            </>
          )}

          {step === 5 && contractId && (
            <>
              <Card>
                <CardHeader>
                  <CardTitle className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                    Printer Department ID
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-2">
                  <div className="flex gap-2 items-start">
                    <div className="flex-1 space-y-1">
                      <Input
                        value={departmentId}
                        onChange={(e) => setDepartmentId(e.target.value)}
                        placeholder="Unique per location — maps to the print server report"
                      />
                      {savedDepartmentId && (
                        <p className="text-xs text-muted-foreground">Saved: {savedDepartmentId}</p>
                      )}
                    </div>
                    <Button type="button" variant="outline" onClick={saveDepartmentId} disabled={savingDepartmentId}>
                      {savingDepartmentId && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                      Save
                    </Button>
                  </div>
                </CardContent>
              </Card>

              <ContractFacilitiesSection contractId={contractId} locationId={locationId} readOnly={false} />
              <ContractQuotasSection contractId={contractId} readOnly={false} />

              <div className="flex justify-end pt-2">
                <Button type="button" onClick={() => setStep(6)}>
                  Continue
                  <ArrowRight className="ml-2 h-4 w-4" />
                </Button>
              </div>
            </>
          )}

          {step === 6 && contractId && (
            <>
              <ContractElectricityTab
                contractId={contractId}
                canEdit={userRole ? ["admin", "manager"].includes(userRole) : false}
              />

              <div className="flex justify-end pt-2">
                <Button type="button" onClick={() => setStep(7)}>
                  Continue
                  <ArrowRight className="ml-2 h-4 w-4" />
                </Button>
              </div>
            </>
          )}

          {step === 7 && contractId && (
            <>
              <Card>
                <CardHeader>
                  <CardTitle className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                    Invoice Type &amp; Billing Mode
                  </CardTitle>
                </CardHeader>
                <CardContent className="flex flex-col gap-3">
                  <button
                    type="button"
                    onClick={() => setBillingMode("proforma_first")}
                    className={cn(
                      "text-left rounded-lg border p-4 cursor-pointer transition-colors",
                      billingMode === "proforma_first" ? "border-[#015E65] bg-[#015E65]/5" : "border-border bg-background"
                    )}
                  >
                    <div className="font-medium text-sm mb-1">Proforma-First</div>
                    <div className="text-xs text-muted-foreground">
                      Issue a Proforma Invoice each cycle; the GST invoice follows once payment clears. Default and
                      recommended.
                    </div>
                  </button>
                  <button
                    type="button"
                    onClick={() => setBillingMode("gst_direct")}
                    className={cn(
                      "text-left rounded-lg border p-4 cursor-pointer transition-colors",
                      billingMode === "gst_direct" ? "border-[#015E65] bg-[#015E65]/5" : "border-border bg-background"
                    )}
                  >
                    <div className="font-medium text-sm mb-1">GST-Direct</div>
                    <div className="text-xs text-muted-foreground">
                      Skip the proforma step and issue the GST invoice directly each cycle.
                    </div>
                  </button>
                </CardContent>
              </Card>

              <div className="flex justify-end pt-2">
                <Button type="button" onClick={saveBillingModeAndContinue} disabled={savingBillingMode}>
                  {savingBillingMode && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  Save &amp; Continue
                  <ArrowRight className="ml-2 h-4 w-4" />
                </Button>
              </div>
            </>
          )}

          {step === 8 && contractId && (
            <>
              <Card>
                <CardHeader>
                  <CardTitle className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                    Billing Email Addresses
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-2">
                  <p className="text-xs text-muted-foreground pb-1">
                    Stored on the lead ({lead?.company || "this member"}) — used for invoices/statements CC across
                    all their contracts, not just this one.
                  </p>
                  {billingEmails.map((email, idx) => (
                    <div key={idx} className="flex items-center gap-2">
                      <Input
                        value={email}
                        onChange={(e) => updateBillingEmail(idx, e.target.value)}
                        placeholder="finance@company.com"
                      />
                      <Button type="button" variant="ghost" size="icon" onClick={() => removeBillingEmail(idx)}>
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    </div>
                  ))}
                  <Button type="button" variant="outline" size="sm" onClick={addBillingEmail}>
                    <Plus className="mr-1 h-3.5 w-3.5" />
                    Add email
                  </Button>
                </CardContent>
              </Card>

              <div className="flex justify-end pt-2">
                <Button type="button" onClick={saveBillingEmailsAndContinue} disabled={savingBillingEmails}>
                  {savingBillingEmails && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  Save &amp; Continue
                  <ArrowRight className="ml-2 h-4 w-4" />
                </Button>
              </div>
            </>
          )}

          {step === 9 && contractId && (
            <>
              <ContractContactsPanel contractId={contractId} leadId={leadId} />

              <div className="flex justify-end pt-2">
                <Button type="button" onClick={() => setStep(10)}>
                  Continue
                  <ArrowRight className="ml-2 h-4 w-4" />
                </Button>
              </div>
            </>
          )}

          {step === 10 && contractId && (
            <>
              {activated ? (
                <div className="rounded-lg border border-green-200 bg-green-50 p-4 flex items-center gap-3">
                  <CheckCircle2 className="h-6 w-6 text-green-600 shrink-0" />
                  <div>
                    <div className="font-medium text-sm text-green-900">Contract Active — {contractNumber}</div>
                    <div className="text-xs text-green-700">Continue to e-Sign / Stamp and Members below.</div>
                  </div>
                </div>
              ) : (
                <>
                  <div className="rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground">
                    This checklist is a preview, read fresh from the server — it is not the source of truth.
                    Clicking &quot;Activate&quot; drives the contract through its real status transitions
                    (draft → sent → accepted → active); whichever step actually fails is the authoritative reason,
                    even if everything below looks green.
                  </div>

                  <Card>
                    <CardHeader>
                      <CardTitle className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                        Activation Checklist
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      {loadingActivationData ? (
                        <div className="flex items-center gap-2 text-sm text-muted-foreground">
                          <Loader2 className="h-4 w-4 animate-spin" />
                          Loading current status…
                        </div>
                      ) : (
                        <>
                          <GateRow label="Proposal linked" ok={!!activationProposal} detail={selectedProposal?.proposal_number || "—"} />
                          <GateRow
                            label="Security deposit collected"
                            ok={
                              (activationProposal?.security_deposit_months ?? 0) === 0 ||
                              (activationProposal?.deposit_payment_status === "paid" &&
                                (!activationProposal?.deposit_claimed_by_contract_id ||
                                  activationProposal.deposit_claimed_by_contract_id === contractId))
                            }
                            detail={
                              (activationProposal?.security_deposit_months ?? 0) === 0
                                ? "Not required"
                                : activationProposal?.deposit_claimed_by_contract_id &&
                                  activationProposal.deposit_claimed_by_contract_id !== contractId
                                ? "Already claimed by another contract off this proposal — collect a separate deposit, or use the override"
                                : activationProposal?.deposit_payment_status === "paid"
                                ? "Received"
                                : "Pending — record it from the proposal page"
                            }
                          />
                          <GateRow
                            label="Pro-rata / first invoice paid"
                            ok={activationProposal?.payment_status === "paid"}
                            detail={activationProposal?.payment_status === "paid" ? "Paid" : "Pending — record it from the proposal page"}
                          />
                          <GateRow
                            label="KYC documents satisfied"
                            ok={kycSatisfied}
                            detail={kycSatisfied ? "Complete" : "Incomplete — not server-enforced, informational only"}
                          />
                          <GateRow
                            label="Escalation rate approved"
                            ok={!["pending", "rejected"].includes(activationContract?.escalation_approval_status || "")}
                            detail={activationContract?.escalation_approval_status || "No pending negotiation"}
                          />
                        </>
                      )}
                    </CardContent>
                  </Card>

                  {activationContract && (
                    <ContractDepositSection
                      proposal={selectedProposal}
                      contract={activationContract}
                      depositCarriedFrom={activationContract.deposit_carried_from}
                      leadId={leadId ?? undefined}
                      depositShortfall={activationContract.deposit_shortfall}
                    />
                  )}

                  <ContractDepositTopupsSection
                    contractId={contractId}
                    currentUserRole={userRole ?? ""}
                    depositShortfall={activationContract?.deposit_shortfall}
                    onShortfallCollected={fetchActivationData}
                  />

                  <ContractDepositAdjustmentsSection
                    contractId={contractId}
                    currentUserId={currentUser?.id ?? null}
                    currentUserRole={userRole ?? ""}
                  />

                  {userRole === "admin" && (
                    <Card>
                      <CardHeader>
                        <CardTitle className="text-sm font-semibold uppercase tracking-wide text-amber-700">
                          Admin Override
                        </CardTitle>
                      </CardHeader>
                      <CardContent className="space-y-2">
                        <p className="text-xs text-muted-foreground">
                          Bypasses the payment gates above if provided — logged to the audit trail. Leave blank for
                          a normal activation.
                        </p>
                        <Input
                          value={overrideReason}
                          onChange={(e) => setOverrideReason(e.target.value)}
                          placeholder="Reason (e.g. Legacy contract migration)"
                        />
                      </CardContent>
                    </Card>
                  )}

                  <div className="flex justify-end pt-2">
                    <Button type="button" onClick={handleActivateClick} disabled={activating || loadingActivationData}>
                      {activating && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                      Activate Contract
                    </Button>
                  </div>
                </>
              )}

              <div className="flex justify-end gap-2 pt-2">
                <Button type="button" variant="outline" onClick={() => router.push(`/contracts/${contractId}`)}>
                  Finish for now — View Contract
                </Button>
                {activated && (
                  <Button type="button" onClick={() => setStep(11)}>
                    Continue
                    <ArrowRight className="ml-2 h-4 w-4" />
                  </Button>
                )}
              </div>

              <Dialog open={deferredActivateOpen} onOpenChange={setDeferredActivateOpen}>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                      <AlertTriangle className="h-4 w-4 text-amber-600" />
                      Activate with Deferred KYC Documents
                    </DialogTitle>
                    <DialogDescription>
                      {kycStatus.deferred} KYC document{kycStatus.deferred > 1 ? "s are" : " is"} deferred. The
                      account will not be fully KYC-compliant until {kycStatus.deferred > 1 ? "they are" : "it is"}{" "}
                      collected.
                    </DialogDescription>
                  </DialogHeader>
                  <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-800">
                    <p className="font-semibold mb-1">Deferred documents must still be collected.</p>
                    <p className="text-xs">
                      Activating this contract does not waive the deferred requirements. They will remain visible
                      across all lead interactions until fulfilled.
                    </p>
                  </div>
                  <DialogFooter>
                    <Button variant="outline" onClick={() => setDeferredActivateOpen(false)}>
                      Cancel
                    </Button>
                    <Button
                      className="bg-amber-600 hover:bg-amber-700 text-white"
                      disabled={activating}
                      onClick={() => {
                        setDeferredActivateOpen(false);
                        attemptActivation();
                      }}
                    >
                      {activating && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                      Activate Anyway
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>

              <Dialog open={spaceWarningOpen} onOpenChange={setSpaceWarningOpen}>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                      <AlertTriangle className="h-4 w-4 text-amber-600" />
                      Fewer Seats Assigned Than Sold
                    </DialogTitle>
                    <DialogDescription>
                      {(() => {
                        const v = validateSpaceAllocation(spaceAllocations, seats);
                        return `${v.allocatedSeats} of ${v.contractSeats} seats have a space unit assigned (${v.shortfall} short). You can still activate and assign the remaining units later.`;
                      })()}
                    </DialogDescription>
                  </DialogHeader>
                  <DialogFooter>
                    <Button variant="outline" onClick={() => setSpaceWarningOpen(false)}>
                      Cancel
                    </Button>
                    <Button
                      className="bg-amber-600 hover:bg-amber-700 text-white"
                      disabled={activating}
                      onClick={confirmActivationWithSpaceWarning}
                    >
                      {activating && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                      Activate Anyway
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            </>
          )}

          {step === 11 && contractId && (
            <>
              {loadingFullContract || !fullContract ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground py-8 justify-center">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Loading contract…
                </div>
              ) : (
                <>
                  <Card>
                    <CardHeader>
                      <CardTitle className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                        e-Sign / Company Stamp
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      <p className="text-xs text-muted-foreground">
                        Route the signed agreement through Leegality, apply TWV&apos;s own stamp manually, or upload
                        an already-signed copy.
                      </p>
                      <div className="flex flex-wrap gap-2">
                        <Button
                          type="button"
                          onClick={handleInitiateSigning}
                          disabled={
                            signSending ||
                            !!fullContract.leegality_document_id ||
                            !leegalityEnabled ||
                            ["rejected", "terminated", "completed"].includes(fullContract.status)
                          }
                          title={leegalityEnabled ? undefined : "E-signing is turned off — see Settings → E-Signing. Use company stamp or upload a manually signed document instead."}
                        >
                          {signSending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                          {fullContract.leegality_document_id ? "Already sent for e-Signing" : "Send for e-Signing"}
                        </Button>
                        {userRole === "admin" && (
                          <Button type="button" variant="outline" onClick={handleOpenStampPreview} disabled={stamping || !!fullContract.signed_document_id}>
                            {stamping && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                            Stamp with company seal
                          </Button>
                        )}
                        <label>
                          <input
                            type="file"
                            accept=".pdf,.jpg,.jpeg,.png"
                            className="hidden"
                            disabled={uploadingSignedDoc}
                            onChange={(e) => {
                              const file = e.target.files?.[0];
                              if (file) handleSignedDocUpload(file);
                              e.target.value = "";
                            }}
                          />
                          <Button type="button" variant="outline" asChild disabled={uploadingSignedDoc}>
                            <span>
                              {uploadingSignedDoc && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                              Upload signed document
                            </span>
                          </Button>
                        </label>
                      </div>

                      {stampPreview && (
                        <div className="rounded-md border border-amber-300 bg-amber-50 p-3 space-y-2">
                          <p className="text-xs text-amber-800">
                            Stamp reference <span className="font-mono font-semibold">{stampPreview.stampRef}</span>{" "}
                            generated.{" "}
                            <a
                              href={stampPreview.previewUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="underline font-medium"
                            >
                              Open preview PDF
                            </a>{" "}
                            to check seal placement before confirming.
                          </p>
                          <div className="flex gap-2">
                            <Button type="button" size="sm" onClick={handleConfirmStamp} disabled={stamping}>
                              {stamping && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                              Confirm &amp; Stamp
                            </Button>
                            <Button type="button" size="sm" variant="ghost" onClick={closeStampPreview}>
                              Cancel
                            </Button>
                          </div>
                        </div>
                      )}

                      {fullContract.signed_document_id ? (
                        <div className="rounded-md bg-muted/30 p-3 text-sm space-y-2">
                          <div>
                            <span className="font-medium">Signed document on file</span>
                            {fullContract.stamp_reference && (
                              <span className="text-muted-foreground"> — stamped ({fullContract.stamp_reference})</span>
                            )}
                          </div>
                          <Button type="button" size="sm" variant="outline" onClick={handleViewSignedDoc}>
                            <Eye className="mr-1.5 h-3.5 w-3.5" />
                            View
                          </Button>
                        </div>
                      ) : fullContract.leegality_status ? (
                        <div className="rounded-md bg-muted/30 p-3 text-sm">
                          <span className="font-medium">Leegality status:</span> {fullContract.leegality_status}
                        </div>
                      ) : (
                        <p className="text-xs text-muted-foreground">Not yet signed or stamped.</p>
                      )}
                      {!fullContract.signed_document_id && (
                        <p className="text-xs text-amber-600 flex items-center gap-1">
                          <AlertTriangle className="h-3 w-3" />
                          Required before issuing vouchers (next step)
                        </p>
                      )}
                    </CardContent>
                  </Card>

                  {fullContract.leegality_document_id && (
                    <Card>
                      <CardHeader>
                        <CardTitle className="text-sm font-semibold uppercase tracking-wide text-muted-foreground flex items-center justify-between">
                          <span className="flex items-center gap-2">
                            <PenLine className="h-4 w-4" />
                            Digital Signing
                          </span>
                          {fullContract.leegality_status === "COMPLETED" ? (
                            <Badge className="bg-green-100 text-green-700 border-green-200">
                              <CheckCircle2 className="h-3 w-3 mr-1" /> Fully Signed
                            </Badge>
                          ) : fullContract.leegality_status === "EXPIRED" ? (
                            <Badge variant="destructive">
                              <XCircle className="h-3 w-3 mr-1" /> Expired
                            </Badge>
                          ) : fullContract.leegality_status === "CANCELLED" ? (
                            <Badge variant="destructive">
                              <XCircle className="h-3 w-3 mr-1" /> Cancelled
                            </Badge>
                          ) : (
                            <Badge className="bg-amber-100 text-amber-700 border-amber-200">
                              <Clock className="h-3 w-3 mr-1" /> Awaiting Signatures
                            </Badge>
                          )}
                        </CardTitle>
                      </CardHeader>
                      <CardContent className="space-y-4 text-sm">
                        {fullContract.signed_at && (
                          <p className="text-xs text-green-600 font-medium">
                            ✓ Completed on {formatDate(fullContract.signed_at)}
                          </p>
                        )}

                        {fullContract.leegality_sign_url && fullContract.leegality_status !== "COMPLETED" && (
                          <div className="space-y-1.5">
                            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                              TWV Signing Link
                            </p>
                            <div className="flex items-center gap-2">
                              <a
                                href={fullContract.leegality_sign_url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="flex-1 text-xs text-primary hover:underline truncate font-mono bg-muted px-2 py-1.5 rounded"
                              >
                                {fullContract.leegality_sign_url}
                              </a>
                              <Button
                                type="button"
                                size="icon"
                                variant="outline"
                                className="h-7 w-7 shrink-0"
                                onClick={() => copyToClipboard(fullContract.leegality_sign_url!, "lessor")}
                                title="Copy TWV signing link"
                              >
                                {copiedLessor ? (
                                  <Check className="h-3.5 w-3.5 text-green-600" />
                                ) : (
                                  <Copy className="h-3.5 w-3.5" />
                                )}
                              </Button>
                              <a href={fullContract.leegality_sign_url} target="_blank" rel="noopener noreferrer">
                                <Button type="button" size="icon" variant="outline" className="h-7 w-7 shrink-0" title="Open in new tab">
                                  <ExternalLink className="h-3.5 w-3.5" />
                                </Button>
                              </a>
                            </div>
                          </div>
                        )}

                        {fullContract.leegality_status !== "COMPLETED" && (
                          <div className="space-y-1.5">
                            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                              Customer Signing
                            </p>
                            {fullContract.leegality_lessee_sign_url ? (
                              <>
                                <div className="flex items-center gap-2">
                                  <a
                                    href={fullContract.leegality_lessee_sign_url}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="flex-1 text-xs text-primary hover:underline truncate font-mono bg-muted px-2 py-1.5 rounded"
                                  >
                                    {fullContract.leegality_lessee_sign_url}
                                  </a>
                                  <Button
                                    type="button"
                                    size="icon"
                                    variant="outline"
                                    className="h-7 w-7 shrink-0"
                                    onClick={() => copyToClipboard(fullContract.leegality_lessee_sign_url!, "lessee")}
                                    title="Copy customer signing link"
                                  >
                                    {copiedLessee ? (
                                      <Check className="h-3.5 w-3.5 text-green-600" />
                                    ) : (
                                      <Copy className="h-3.5 w-3.5" />
                                    )}
                                  </Button>
                                  <a href={fullContract.leegality_lessee_sign_url} target="_blank" rel="noopener noreferrer">
                                    <Button type="button" size="icon" variant="outline" className="h-7 w-7 shrink-0" title="Open in new tab">
                                      <ExternalLink className="h-3.5 w-3.5" />
                                    </Button>
                                  </a>
                                </div>
                                <p className="text-xs text-muted-foreground">
                                  Send this link to the customer to sign via Aadhaar eSign
                                </p>
                              </>
                            ) : (
                              <div className="flex items-center gap-2 bg-muted/50 rounded px-2.5 py-2">
                                <Mail className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                                <p className="text-xs text-muted-foreground">
                                  Aadhaar eSign invitation sent to customer&apos;s email by Leegality
                                </p>
                              </div>
                            )}
                          </div>
                        )}

                        <p className="text-xs text-muted-foreground font-mono">Ref: {fullContract.leegality_document_id}</p>

                        {fullContract.leegality_status !== "COMPLETED" && (
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            className="w-full"
                            onClick={handleCheckSigningStatus}
                            disabled={checkingSigningStatus}
                          >
                            {checkingSigningStatus ? (
                              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                            )}
                            Refresh Signing Status
                          </Button>
                        )}

                        {(fullContract.leegality_status === "EXPIRED" || fullContract.leegality_status === "CANCELLED") && (
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            className="w-full"
                            onClick={handleInitiateSigning}
                            disabled={signSending}
                          >
                            {signSending ? (
                              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <PenLine className="mr-1.5 h-3.5 w-3.5" />
                            )}
                            Resend for Signing
                          </Button>
                        )}
                      </CardContent>
                    </Card>
                  )}

                  <div className="flex justify-end pt-2">
                    <Button type="button" onClick={() => setStep(12)}>
                      Continue
                      <ArrowRight className="ml-2 h-4 w-4" />
                    </Button>
                  </div>
                </>
              )}
            </>
          )}

          {step === 12 && contractId && fullContract && (
            <>
              <ContractMembersAccessSection
                contractId={contractId}
                seats={fullContract.seats}
                contractStatus={fullContract.status}
              />
              <ContractVouchersSection
                contractId={contractId}
                seats={fullContract.seats}
                contractStatus={fullContract.status}
                startDate={fullContract.start_date}
                endDate={fullContract.end_date}
                tenureMonths={fullContract.tenure_months}
                signedDocumentId={fullContract.signed_document_id}
                leadEmail={lead?.email}
                locationId={fullContract.location_id}
                printerDepartmentId={fullContract.department_id ?? undefined}
                onDepartmentIdUpdate={fetchFullContract}
              />

              <ContractMoratoriumSection contract={fullContract} currentUserRole={userRole ?? ""} />
              <ContractServiceUsageSection contractId={contractId} />

              <div className="flex justify-end pt-2">
                <Button type="button" onClick={() => router.push(`/contracts/${contractId}`)}>
                  Done — View Contract
                  <ArrowRight className="ml-2 h-4 w-4" />
                </Button>
              </div>
            </>
          )}
        </form>
      )}
    </div>
  );
}
