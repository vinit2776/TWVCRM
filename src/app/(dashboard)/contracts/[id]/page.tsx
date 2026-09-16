"use client";

import { use, useState, useEffect, useCallback, useRef } from "react";
import { useCurrentUser } from "@/providers/current-user-provider";
import { createClient as createBrowserClient } from "@/lib/supabase/client";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  ArrowLeft,
  CheckCircle2,
  XCircle,
  Download,
  Loader2,
  Upload,
  FileText,
  Eye,
  RefreshCw,
  AlertTriangle,
  Mail,
  Send,
  PenLine,
  ExternalLink,
  Clock,
  Copy,
  Check,
  Pencil,
  Stamp,
  CalendarPlus,
  Minus,
  Plus,
  Link2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/shared/loading-skeleton";
import { ContractVouchersSection } from "@/components/contracts/contract-vouchers-section";
import { ContractMembersAccessSection } from "@/components/contracts/contract-members-access-section";
import { ContractFacilitiesSection } from "@/components/contracts/contract-facilities-section";
import { ContractQuotasSection } from "@/components/contracts/contract-quotas-section";
import { ContractAddonsSection } from "@/components/contracts/contract-addons-section";
import { ContractRatePhasesSection } from "@/components/contracts/contract-rate-phases-section";
import { ContractDocumentsTab } from "@/components/contracts/contract-documents-tab";
import { ContractElectricityTab } from "@/components/contracts/contract-electricity-tab";
import { ContractBillingSection } from "@/components/accounting/contract-billing-section";
import { ContractMoratoriumSection } from "@/components/contracts/contract-moratorium-section";
import { ContractDepositSection } from "@/components/contracts/contract-deposit-section";
import { ContractDepositAdjustmentsSection } from "@/components/contracts/contract-deposit-adjustments-section";
import { ContractDepositTopupsSection } from "@/components/contracts/contract-deposit-topups-section";
import { ContractInvoicesSection } from "@/components/contracts/contract-invoices-section";
import { ContractAttributedInvoicesSection } from "@/components/contracts/contract-attributed-invoices-section";
import { ContractAccessLogsSection } from "@/components/contracts/contract-access-logs-section";
import { ContractBookingsSection } from "@/components/contracts/contract-bookings-section";
import { ContractServiceUsageSection } from "@/components/contracts/contract-service-usage-section";
import { EmailDocumentDialog } from "@/components/shared/email-document-dialog";
import { AgreementDocumentHistory } from "@/components/agreements/agreement-document-history";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  CONTRACT_STATUS_LABELS,
  CONTRACT_STATUS_COLORS,
  CONTRACT_QUOTA_LOCKED_STATUSES,
  CONTRACT_QUOTA_ROLES,
  BILLING_CYCLE_LABELS,
  KYC_DOCUMENTS,
  ENTITY_TYPE_LABELS,
  ACTIVATION_UNBLOCKING_PURPOSE,
} from "@/lib/constants";
import { formatDate, formatCurrency } from "@/lib/utils";
import { ContractLifecycle } from "@/components/contracts/contract-lifecycle";
import {
  ContractRenewalDialog,
  DeclineRenewalDialog,
  CancelRenewalDialog,
  EscalationWaiverSection,
} from "@/components/contracts/contract-renewal-dialog";
import { ContractRenewalEditDialog } from "@/components/contracts/contract-renewal-edit-dialog";
import { ContractExtendDialog } from "@/components/contracts/contract-extend-dialog";
import { InfoTooltip } from "@/components/ui/info-tooltip";
import { ContractContactsPanel } from "@/components/contracts/contract-contacts-panel";
import { ContractSpaceManager, validateSpaceAllocation } from "@/components/contracts/contract-space-manager";
import { toast } from "sonner";
// lucide-react icons imported above via main import block
import { prepareUpload, UploadTooLargeError } from "@/lib/uploads/upload-gate";
import { SeatOccupantsPanel } from "@/components/spaces/seat-occupants-panel";
import { ContractChainStrip } from "@/components/contracts/contract-chain-strip";
import { ContractProrataSection } from "@/components/contracts/contract-prorata-section";
import { QueryButton } from "@/components/queries/query-button";
import { useLeegalityEnabled } from "@/hooks/use-leegality-enabled";
import { commitmentDifferences } from "@/lib/contract-commitment";
import type { Contract, ContractSpaceAllocation } from "@/types";

export default function ContractDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();
  const [contract, setContract] = useState<Contract | null>(null);
  const [loading, setLoading] = useState(true);
  const [editingPoNumber, setEditingPoNumber] = useState(false);
  const [poNumberValue, setPoNumberValue] = useState("");
  const [savingPoNumber, setSavingPoNumber] = useState(false);
  const [statusUpdating, setStatusUpdating] = useState(false);
  const [terminateOpen, setTerminateOpen] = useState(false);
  const [terminating, setTerminating] = useState(false);
  const [terminationReason, setTerminationReason] = useState("");
  const [uploadingSignedDoc, setUploadingSignedDoc] = useState(false);
  const [stampingSignSeal, setStampingSignSeal] = useState(false);
  const [stampConfirmOpen, setStampConfirmOpen] = useState(false);
  const [stampPreviewLoading, setStampPreviewLoading] = useState(false);
  const [stampPreviewUrl, setStampPreviewUrl] = useState<string | null>(null);
  const [stampPreviewPdfBase64, setStampPreviewPdfBase64] = useState<string | null>(null);
  const [stampPreviewRef, setStampPreviewRef] = useState<string | null>(null);
  const [cancelStampOpen, setCancelStampOpen] = useState(false);
  const [cancellingStamp, setCancellingStamp] = useState(false);
  const [stampError, setStampError] = useState<string | null>(null);
  const [cancelSigningOpen, setCancelSigningOpen] = useState(false);
  const [cancellingSigning, setCancellingSigning] = useState(false);
  const [signCancelError, setSignCancelError] = useState<string | null>(null);
  // "generate" regenerates the agreement fresh (stamp-sign-seal); "existing"
  // overlays the stamp onto an already-uploaded signed document instead —
  // same preview dialog, different source PDF and commit endpoint.
  const [stampMode, setStampMode] = useState<"generate" | "existing">("generate");
  const [stampExistingPreviewLoading, setStampExistingPreviewLoading] = useState(false);
  // An arbitrary uploaded PDF has no known layout, so neither the page nor
  // the position within it is reliable (a trailing KYC/enclosure table can
  // push the signature block off the last page, and a fixed corner anchor
  // can land on top of unrelated content) — cache the source bytes so the
  // admin can pick the page and click exactly where the stamp should go,
  // rendered from a pristine copy each time so nothing stacks.
  const [stampExistingSourceBytes, setStampExistingSourceBytes] = useState<Uint8Array | null>(null);
  const [stampExistingOriginalUrl, setStampExistingOriginalUrl] = useState<string | null>(null);
  const [stampExistingPageCount, setStampExistingPageCount] = useState(0);
  const [stampExistingTargetPage, setStampExistingTargetPage] = useState(1);
  const [stampExistingRendering, setStampExistingRendering] = useState(false);
  // Rendered raster of the current page (pdfjs-dist) for click-to-place, and
  // the normalized (0..1) point the admin clicked — null until they click,
  // which gates "Confirm & save" so nothing saves at a default guessed spot.
  const [stampExistingPageImageUrl, setStampExistingPageImageUrl] = useState<string | null>(null);
  const [stampExistingPageImageLoading, setStampExistingPageImageLoading] = useState(false);
  const [stampExistingClickRatio, setStampExistingClickRatio] = useState<{ x: number; y: number } | null>(null);
  const [emailDialogOpen, setEmailDialogOpen] = useState(false);
  // Manual override for the agreement PDF's DRAFT watermark. Freely
  // togglable once start_date is confirmed (see generateMembershipAgreementPDF).
  // While unconfirmed, the checkbox renders checked + soft-disabled — clicking
  // it opens signatureStartDateDialogOpen instead of toggling directly (see
  // handleWatermarkCheckboxClick).
  const [includeDraftWatermark, setIncludeDraftWatermark] = useState(false);
  const [signatureStartDateDialogOpen, setSignatureStartDateDialogOpen] = useState(false);
  const [signatureStartDateInput, setSignatureStartDateInput] = useState("");
  const [downloadingForSignature, setDownloadingForSignature] = useState(false);
  const [initiatingSigning, setInitiatingSigning] = useState(false);
  const [checkingSigningStatus, setCheckingSigningStatus] = useState(false);
  const [copiedLessor, setCopiedLessor] = useState(false);
  const [copiedLessee, setCopiedLessee] = useState(false);
  const [renewDialogOpen, setRenewDialogOpen] = useState(false);
  const [extendDialogOpen, setExtendDialogOpen] = useState(false);
  const [declineDialogOpen, setDeclineDialogOpen] = useState(false);
  const [cancelRenewalDialogOpen, setCancelRenewalDialogOpen] = useState(false);
  const [editTermsDialogOpen, setEditTermsDialogOpen] = useState(false);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [renewalDraft, setRenewalDraft] = useState<any>(null);
  const signedDocInputRef = useRef<HTMLInputElement>(null);

  const copyToClipboard = (text: string, who: "lessor" | "lessee") => {
    navigator.clipboard.writeText(text);
    if (who === "lessor") { setCopiedLessor(true); setTimeout(() => setCopiedLessor(false), 2000); }
    else { setCopiedLessee(true); setTimeout(() => setCopiedLessee(false), 2000); }
  };

  const { user } = useCurrentUser();
  const userRole = user?.role ?? null;
  const { enabled: leegalityEnabled } = useLeegalityEnabled();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [linkedProposal, setLinkedProposal] = useState<any>(null);
  // Ad-hoc invoices (proforma_invoices) attributed/attributable to this
  // contract, plus the proposal's own pro-rata billing statement amount —
  // both feed the activation-gate hint's "link an ad-hoc invoice instead"
  // affordance below. Refreshed by the same onAttributionChanged hook the
  // Ad-hoc Invoices card already calls, so linking from either place updates
  // this too.
  const [prorataAttribution, setProrataAttribution] = useState<{
    attributed: Array<{ id: string; invoice_number: string; status: string; total_amount: number; attribution_purpose: string | null }>;
    candidates: Array<{ id: string; invoice_number: string; status: string; total_amount: number }>;
    expectedAmount: number | null;
  }>({ attributed: [], candidates: [], expectedAmount: null });
  const [linkingInvoiceId, setLinkingInvoiceId] = useState<string | null>(null);
  const [overrideReason, setOverrideReason] = useState("");
  const [kycStatus, setKycStatus] = useState<{ allSatisfied: boolean; total: number; approved: number; deferred: number }>({ allSatisfied: true, total: 0, approved: 0, deferred: 0 });
  const [showOverride, setShowOverride] = useState(false);
  const [deferredActivateOpen, setDeferredActivateOpen] = useState(false);
  const [spaceWarningOpen, setSpaceWarningOpen] = useState(false);
  const [pendingActivateArgs, setPendingActivateArgs] = useState<{ overrideReason?: string } | null>(null);

  // Assigned spaces
  const [spaceAllocations, setSpaceAllocations] = useState<ContractSpaceAllocation[]>([]);

  const handleSpaceAllocationsChange = useCallback((allocs: ContractSpaceAllocation[]) => {
    setSpaceAllocations(allocs);
  }, []);

  const handleKycStatusChange = useCallback((allSatisfied: boolean, total: number, approved: number, deferred: number) => {
    setKycStatus({ allSatisfied, total, approved, deferred });
  }, []);

  const fetchContract = useCallback(async (showSpinner = true) => {
    if (showSpinner) setLoading(true);
    const res = await fetch(`/api/contracts/${id}`);
    if (res.ok) {
      const json = await res.json();
      setContract(json.data || null);

      // Fetch linked proposal and renewal draft in parallel (both are independent of each other)
      const proposalId = json.data?.proposal_id;
      const hasRenewalDraft = ["renewal_in_progress", "renewed"].includes(json.data?.status);

      const [proposalResult, renewalResult, attributionResult, prorataStatementResult] = await Promise.allSettled([
        proposalId
          ? fetch(`/api/proposals/${proposalId}`).then(r => r.json())
          : Promise.resolve(null),
        hasRenewalDraft
          ? fetch(`/api/contracts?parent_contract_id=${id}&is_renewal=true&limit=1`).then(r => r.json())
          : Promise.resolve(null),
        proposalId
          ? fetch(`/api/contracts/${id}/attributed-invoices`).then(r => r.json())
          : Promise.resolve(null),
        proposalId
          ? fetch(`/api/billing-statements?proposal_id=${proposalId}&limit=1`).then(r => r.json())
          : Promise.resolve(null),
      ]);

      if (proposalId) {
        setLinkedProposal(
          proposalResult.status === "fulfilled" ? (proposalResult.value?.data || null) : null
        );

        const attribution = attributionResult.status === "fulfilled" ? attributionResult.value?.data : null;
        const prorataStatement = prorataStatementResult.status === "fulfilled"
          ? (prorataStatementResult.value?.data || [])[0]
          : null;
        setProrataAttribution({
          attributed: attribution?.attributed || [],
          candidates: attribution?.candidates || [],
          expectedAmount: prorataStatement?.total_amount ?? null,
        });
      } else {
        setProrataAttribution({ attributed: [], candidates: [], expectedAmount: null });
      }

      if (hasRenewalDraft) {
        const drafts = renewalResult.status === "fulfilled" ? (renewalResult.value?.data || []) : [];
        setRenewalDraft(drafts.length > 0 ? drafts[0] : null);
      } else {
        setRenewalDraft(null);
      }
    }
    if (showSpinner) setLoading(false);
  }, [id]);

  useEffect(() => {
    fetchContract(true);
  }, [fetchContract]);

  /** Links a candidate ad-hoc invoice as the pro-rata/first invoice from the
   *  blocked-activation hint, mirroring the "Attribute an invoice" dialog
   *  further down the page — same endpoint, same role gate (admin/accounts). */
  const handleLinkProrataInvoice = async (invoiceId: string) => {
    setLinkingInvoiceId(invoiceId);
    try {
      const res = await fetch(`/api/invoices/${invoiceId}/attribution`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contract_id: id, purpose: ACTIVATION_UNBLOCKING_PURPOSE }),
      });
      const json = await res.json().catch(() => null);
      if (res.ok) {
        toast.success("Invoice linked as the pro-rata / first invoice");
        await fetchContract(false);
      } else {
        toast.error(json?.error || "Failed to link invoice");
      }
    } catch {
      toast.error("Failed to link invoice");
    } finally {
      setLinkingInvoiceId(null);
    }
  };

  /** Wraps activation to check space allocation first */
  const attemptActivation = (overrideReason?: string) => {
    const validation = validateSpaceAllocation(spaceAllocations, contract?.seats ?? 1);
    if (validation.isUnderAllocated) {
      // Show warning but still allow activation
      setPendingActivateArgs({ overrideReason });
      setSpaceWarningOpen(true);
      return;
    }
    handleStatusUpdate("active", overrideReason);
  };

  const confirmActivationWithSpaceWarning = () => {
    setSpaceWarningOpen(false);
    handleStatusUpdate("active", pendingActivateArgs?.overrideReason);
    setPendingActivateArgs(null);
  };

  const handleStatusUpdate = async (newStatus: string, paymentOverrideReason?: string) => {
    setStatusUpdating(true);
    const payload: Record<string, unknown> = { status: newStatus };
    if (paymentOverrideReason) payload.payment_override_reason = paymentOverrideReason;

    const res = await fetch(`/api/contracts/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (res.ok) {
      const statusLabel = CONTRACT_STATUS_LABELS[newStatus] || newStatus;
      toast.success(`Contract marked as ${statusLabel}`);
      fetchContract(false);
    } else {
      const err = await res.json().catch(() => null);
      toast.error(err?.error || `Failed to update contract status`);
    }
    setStatusUpdating(false);
  };

  const handleTerminate = async () => {
    if (!terminationReason.trim()) {
      toast.error("Please provide a termination reason");
      return;
    }
    setTerminating(true);
    const res = await fetch(`/api/contracts/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        status: "terminated",
        termination_reason: terminationReason.trim(),
      }),
    });
    if (res.ok) {
      toast.success("Contract terminated");
      setTerminateOpen(false);
      setTerminationReason("");
      fetchContract(false);
    } else {
      const err = await res.json().catch(() => null);
      toast.error(err?.error || "Failed to terminate contract");
    }
    setTerminating(false);
  };

  const handleSavePoNumber = async () => {
    setSavingPoNumber(true);
    const res = await fetch(`/api/contracts/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ po_number: poNumberValue.trim() || null }),
    });
    setSavingPoNumber(false);
    if (res.ok) {
      toast.success(poNumberValue.trim() ? "Customer PO number saved" : "Customer PO number cleared");
      setEditingPoNumber(false);
      fetchContract(false);
    } else {
      const err = await res.json().catch(() => null);
      toast.error(err?.error || "Failed to save");
    }
  };

  const handleDownloadPDF = async () => {
    if (!contract) return;
    // Once stamped, the signed_document is the document of record — serve that
    // instead of silently regenerating a fresh, unstamped PDF from live data.
    if (contract.signed_document?.id) {
      await handleViewSignedDoc();
      return;
    }
    const { generateMembershipAgreementPDF } = await import("@/lib/pdf-generator");
    const doc = generateMembershipAgreementPDF(
      contract,
      contract.lead || undefined,
      contract.location || undefined,
      { watermarkDraft: includeDraftWatermark }
    );
    doc.save(`${contract.contract_number}.pdf`);
  };

  // The DRAFT-watermark checkbox stays visible pre-confirmation but is
  // soft-disabled (styled disabled, not the native `disabled` attribute —
  // that would swallow the click entirely). Clicking it while unconfirmed
  // opens a prompt for the date to use on this one download instead of
  // toggling includeDraftWatermark directly, since removing the watermark
  // for real still requires knowing what date to print.
  const handleWatermarkCheckboxClick = () => {
    if (!contract) return;
    if (contract.start_date_confirmed) {
      setIncludeDraftWatermark((v) => !v);
      return;
    }
    setSignatureStartDateInput(contract.start_date || "");
    setSignatureStartDateDialogOpen(true);
  };

  // Alternative to Download PDF for the pre-confirmation gap: start_date
  // isn't locked yet, so the regular download is always watermarked. This
  // generates a clean copy using an admin-entered date instead — for this
  // one download only. It never writes contract.start_date or
  // start_date_confirmed; that stays untouched until the real pro-rata
  // payment locks it in. If the real date later differs from what's
  // printed here, the contract page flags it as stale.
  const handleDownloadForSignature = async () => {
    if (!contract || !signatureStartDateInput) return;
    setDownloadingForSignature(true);
    try {
      const { generateMembershipAgreementPDF } = await import("@/lib/pdf-generator");
      const doc = generateMembershipAgreementPDF(
        contract,
        contract.lead || undefined,
        contract.location || undefined,
        { forSignatureDownload: true, signatureStartDateOverride: signatureStartDateInput }
      );
      doc.save(`${contract.contract_number}-for-signature.pdf`);
      const res = await fetch(`/api/contracts/${id}/mark-signature-copy`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ signatureStartDate: signatureStartDateInput }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => null);
        toast.error(err?.error || "Downloaded, but failed to record the signature-copy date");
      }
      setSignatureStartDateDialogOpen(false);
      fetchContract(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to generate the signature copy");
    } finally {
      setDownloadingForSignature(false);
    }
  };

  const handleGeneratePDFBase64 = async (options?: { applyCompanyStamp?: boolean; stampRef?: string; watermarkDraft?: boolean }): Promise<string> => {
    if (!contract) return "";
    const { generateMembershipAgreementPDF } = await import("@/lib/pdf-generator");
    const doc = generateMembershipAgreementPDF(
      contract,
      contract.lead || undefined,
      contract.location || undefined,
      options
    );
    const arrayBuffer = doc.output("arraybuffer");
    const bytes = new Uint8Array(arrayBuffer);
    let binary = "";
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  };

  // Email dialog calls onGeneratePDF() with no arguments — thread the
  // watermark toggle through as a closure instead of a call-site option, so
  // handleGeneratePDFBase64 stays generic for the stamp/e-sign call sites
  // (which never honor the manual toggle — see the watermarkDraft option's
  // doc comment in generateMembershipAgreementPDF).
  const handleGeneratePDFForEmail = () => handleGeneratePDFBase64({ watermarkDraft: includeDraftWatermark });

  const handleOpenEmailDialog = () => {
    setEmailDialogOpen(true);
  };

  const handleSignedDocUpload = async (raw: File) => {
    if (!contract) return;
    setUploadingSignedDoc(true);

    try {
      // Normalize before upload: PDFs → stripped, images → JPEG 2048px.
      const file = await prepareUpload(raw);
      if (!file) return;

      // Step 1: get signed upload URL — file goes directly to Supabase, bypassing Vercel's 4.5MB limit
      const urlRes = await fetch("/api/documents/upload-url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fileName: file.name,
          mimeType: file.type,
          path: "signed-contracts",
        }),
      });
      if (!urlRes.ok) {
        const urlErr = await urlRes.json().catch(() => null);
        throw new Error(urlErr?.error || "Failed to get upload URL");
      }
      const { token, path: filePath } = await urlRes.json();

      // Step 2: upload directly to Supabase Storage via the browser client
      const supabase = createBrowserClient();
      const { error: storageError } = await supabase.storage
        .from("crm-documents")
        .uploadToSignedUrl(filePath, token, file, { contentType: file.type || "application/octet-stream" });
      if (storageError) throw new Error(storageError.message);

      // Step 3: create document DB record
      const regRes = await fetch("/api/documents/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: `Signed Contract - ${contract.contract_number}`,
          fileName: file.name,
          filePath,
          mimeType: file.type,
          sizeBytes: file.size,
          category: "signed_contract",
          leadId: contract.lead_id,
        }),
      });
      if (!regRes.ok) {
        const regErr = await regRes.json().catch(() => null);
        throw new Error(regErr?.error || "Failed to register document");
      }
      const { data: doc } = await regRes.json();

      // Step 4: link to contract
      const patchRes = await fetch(`/api/contracts/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ signed_document_id: doc.id }),
      });

      if (patchRes.ok) {
        toast.success("Signed contract uploaded successfully");
        fetchContract(false);
      } else {
        const err = await patchRes.json().catch(() => null);
        toast.error(err?.error || "Failed to link document to contract");
      }
    } catch (e) {
      if (e instanceof UploadTooLargeError) {
        toast.error(e.message);
      } else {
        toast.error(e instanceof Error ? e.message : "Failed to upload document");
      }
    } finally {
      setUploadingSignedDoc(false);
    }
  };

  const closeStampPreview = () => {
    setStampConfirmOpen(false);
    if (stampPreviewUrl) URL.revokeObjectURL(stampPreviewUrl);
    if (stampExistingOriginalUrl) URL.revokeObjectURL(stampExistingOriginalUrl);
    setStampPreviewUrl(null);
    setStampPreviewPdfBase64(null);
    setStampPreviewRef(null);
    setStampError(null);
    setStampExistingSourceBytes(null);
    setStampExistingOriginalUrl(null);
    setStampExistingPageCount(0);
    setStampExistingTargetPage(1);
    setStampExistingPageImageUrl(null);
    setStampExistingClickRatio(null);
  };

  const handleOpenStampPreview = async () => {
    if (!contract) return;
    setStampMode("generate");
    setStampPreviewLoading(true);
    setStampError(null);
    try {
      const { generateStampReference } = await import("@/lib/company-stamp");
      const stampRef = generateStampReference();
      const pdfBase64 = await handleGeneratePDFBase64({ applyCompanyStamp: true, stampRef });
      const bytes = Uint8Array.from(atob(pdfBase64), (c) => c.charCodeAt(0));
      const blobUrl = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
      setStampPreviewUrl(blobUrl);
      setStampPreviewPdfBase64(pdfBase64);
      setStampPreviewRef(stampRef);
      // Just open the confirmation dialog — don't auto-open a new tab here.
      // Auto-opening stole focus to the PDF tab before the user ever saw the
      // dialog's own "Open preview PDF" button; let them choose when to look.
      setStampConfirmOpen(true);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to generate preview");
    } finally {
      setStampPreviewLoading(false);
    }
  };

  // Bytes → base64 without Buffer (browser context). Chunked to stay well
  // under the string-arg limits some engines impose on String.fromCharCode.
  const bytesToBase64 = (bytes: Uint8Array): string => {
    let binary = "";
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
  };

  // pdfjs-dist needs a worker script; loading it from jsdelivr (pinned to
  // the exact installed version) sidesteps bundler-specific worker-asset
  // wiring for Next.js/Turbopack, which isn't set up in this project.
  const getPdfJs = async () => {
    const pdfjsLib = await import("pdfjs-dist");
    pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${pdfjsLib.version}/build/pdf.worker.min.mjs`;
    return pdfjsLib;
  };

  // Rasterizes one page of `sourceBytes` for the click-to-place picker.
  // Passes a copy to pdfjs — it can transfer/detach the buffer it's given,
  // and the same bytes get reloaded by pdf-lib afterward to draw the stamp.
  const renderStampExistingPageImage = async (sourceBytes: Uint8Array, pageNumber: number) => {
    setStampExistingPageImageLoading(true);
    try {
      const pdfjsLib = await getPdfJs();
      const pdf = await pdfjsLib.getDocument({ data: sourceBytes.slice() }).promise;
      const page = await pdf.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 1.5 });
      const canvas = document.createElement("canvas");
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Canvas rendering isn't supported in this browser");
      await page.render({ canvas, canvasContext: ctx, viewport }).promise;
      setStampExistingPageImageUrl(canvas.toDataURL("image/png"));
    } finally {
      setStampExistingPageImageLoading(false);
    }
  };

  // Draws TWV's signature + seal centered on the admin's clicked point
  // (normalized 0..1 within the page) onto one page of a pristine copy of
  // `sourceBytes` (an arbitrary uploaded PDF — layout unknown to us), and
  // pushes the result into the shared preview dialog state. Re-loading from
  // the cached original each call means re-clicking never stacks stamps.
  const renderExistingStampPreview = async (
    sourceBytes: Uint8Array,
    pageNumber: number,
    stampRef: string,
    xRatio: number,
    yRatio: number
  ) => {
    const { PDFDocument, StandardFonts, rgb } = await import("pdf-lib");
    const { COMPANY_SIGNATURE_BASE64 } = await import("@/lib/signature-data");
    const { COMPANY_SEAL_BASE64 } = await import("@/lib/seal-data");

    const pdfDoc = await PDFDocument.load(sourceBytes);
    const pages = pdfDoc.getPages();
    const targetIndex = Math.min(Math.max(pageNumber, 1), pages.length) - 1;
    const targetPage = pages[targetIndex];
    const { width, height } = targetPage.getSize();

    const dataUriToBytes = (dataUri: string) =>
      Uint8Array.from(atob(dataUri.split(",")[1]), (c) => c.charCodeAt(0));

    const sigImage = await pdfDoc.embedPng(dataUriToBytes(COMPANY_SIGNATURE_BASE64));
    const sealImage = await pdfDoc.embedPng(dataUriToBytes(COMPANY_SEAL_BASE64));
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);

    const sealSize = 44;
    const sigH = 26;
    const sigW = sigH * (sigImage.width / sigImage.height);
    const gap = 6;
    const clusterWidth = sigW + gap + sealSize;
    const clusterHeight = Math.max(sigH, sealSize);
    const margin = 4;

    // PDF origin is bottom-left; the click ratio is measured from the
    // top-left of the rendered image, so the y-axis flips here.
    const clickX = xRatio * width;
    const clickY = height - yRatio * height;

    const clusterLeft = Math.min(Math.max(clickX - clusterWidth / 2, margin), width - clusterWidth - margin);
    const clusterBottom = Math.min(
      Math.max(clickY - clusterHeight / 2, margin + 12),
      height - clusterHeight - margin
    );

    const sigX = clusterLeft;
    const sigY = clusterBottom + (clusterHeight - sigH) / 2;
    const sealX = sigX + sigW + gap;
    const sealY = clusterBottom + (clusterHeight - sealSize) / 2;

    targetPage.drawImage(sigImage, { x: sigX, y: sigY, width: sigW, height: sigH });
    targetPage.drawImage(sealImage, { x: sealX, y: sealY, width: sealSize, height: sealSize });
    targetPage.drawText(`TWV Ref: ${stampRef}`, {
      x: sigX,
      y: clusterBottom - 9,
      size: 5.5,
      font,
      color: rgb(0.5, 0.5, 0.5),
    });

    const stampedBytes = await pdfDoc.save();
    const pdfBase64 = bytesToBase64(stampedBytes);
    const blobUrl = URL.createObjectURL(new Blob([new Uint8Array(stampedBytes)], { type: "application/pdf" }));

    setStampPreviewUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return blobUrl;
    });
    setStampPreviewPdfBase64(pdfBase64);
  };

  // Overlays TWV's signature + seal directly onto the document already
  // uploaded as signed_document (e.g. a customer-signed scan), instead of
  // regenerating the agreement from scratch — preserves the customer's
  // actual signature, unlike handleOpenStampPreview above. An arbitrary
  // upload has no known layout (a trailing enclosure/KYC table can push the
  // real signature block off the last page, or share a page with unrelated
  // content), so the admin picks the page and clicks exactly where the
  // stamp should sit rather than trusting a guessed corner.
  const handleOpenStampExistingPreview = async () => {
    if (!contract?.signed_document?.id) return;
    setStampMode("existing");
    setStampExistingPreviewLoading(true);
    setStampError(null);
    try {
      const viewRes = await fetch(`/api/documents/${contract.signed_document.id}/view`);
      if (!viewRes.ok) throw new Error("Failed to get the uploaded document's URL");
      const { signedUrl } = await viewRes.json();
      const fileRes = await fetch(signedUrl);
      if (!fileRes.ok) throw new Error("Failed to download the uploaded document");
      const fileBytes = new Uint8Array(await fileRes.arrayBuffer());

      const { PDFDocument } = await import("pdf-lib");
      const { generateStampReference } = await import("@/lib/company-stamp");

      const probeDoc = await PDFDocument.load(fileBytes);
      const pageCount = probeDoc.getPageCount();
      const defaultPage = pageCount;
      const stampRef = generateStampReference();

      setStampExistingSourceBytes(fileBytes);
      setStampExistingOriginalUrl(URL.createObjectURL(new Blob([new Uint8Array(fileBytes)], { type: "application/pdf" })));
      setStampExistingPageCount(pageCount);
      setStampExistingTargetPage(defaultPage);
      setStampExistingClickRatio(null);
      setStampPreviewRef(stampRef);
      setStampPreviewUrl(null);
      setStampPreviewPdfBase64(null);

      await renderStampExistingPageImage(fileBytes, defaultPage);
      setStampConfirmOpen(true);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to generate preview");
    } finally {
      setStampExistingPreviewLoading(false);
    }
  };

  const handleStampExistingPageChange = async (pageNumber: number) => {
    if (!stampExistingSourceBytes) return;
    const clamped = Math.min(Math.max(pageNumber, 1), stampExistingPageCount || 1);
    setStampExistingTargetPage(clamped);
    // Force a fresh click on the new page — a point that made sense on the
    // old page has no relation to this one.
    setStampExistingClickRatio(null);
    setStampPreviewUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });
    setStampPreviewPdfBase64(null);
    try {
      await renderStampExistingPageImage(stampExistingSourceBytes, clamped);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to render that page");
    }
  };

  const handleStampExistingImageClick = async (e: React.MouseEvent<HTMLImageElement>) => {
    if (!stampExistingSourceBytes || !stampPreviewRef) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const xRatio = Math.min(Math.max((e.clientX - rect.left) / rect.width, 0), 1);
    const yRatio = Math.min(Math.max((e.clientY - rect.top) / rect.height, 0), 1);
    setStampExistingClickRatio({ x: xRatio, y: yRatio });
    setStampExistingRendering(true);
    try {
      await renderExistingStampPreview(stampExistingSourceBytes, stampExistingTargetPage, stampPreviewRef, xRatio, yRatio);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to update preview");
    } finally {
      setStampExistingRendering(false);
    }
  };

  const handleStampSignSeal = async () => {
    if (!contract || !stampPreviewPdfBase64 || !stampPreviewRef) return;
    setStampingSignSeal(true);
    setStampError(null);
    try {
      const endpoint =
        stampMode === "existing"
          ? `/api/contracts/${id}/stamp-existing-document`
          : `/api/contracts/${id}/stamp-sign-seal`;
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pdfBase64: stampPreviewPdfBase64, stampRef: stampPreviewRef }),
      });
      if (res.ok) {
        toast.success(`Contract stamped with company sign & seal (${stampPreviewRef})`);
        closeStampPreview();
        fetchContract(false);
      } else {
        const err = await res.json().catch(() => null);
        setStampError(err?.error || "Failed to stamp contract");
      }
    } catch (e) {
      setStampError(e instanceof Error ? e.message : "Failed to stamp contract");
    } finally {
      setStampingSignSeal(false);
    }
  };

  const handleCancelStamp = async () => {
    if (!contract) return;
    setCancellingStamp(true);
    setStampError(null);
    try {
      const res = await fetch(`/api/contracts/${id}/cancel-stamp`, { method: "POST" });
      if (res.ok) {
        toast.success("Sign & seal stamp cancelled — the plain agreement is available again");
        setCancelStampOpen(false);
        fetchContract(false);
      } else {
        const err = await res.json().catch(() => null);
        setStampError(err?.error || "Failed to cancel the stamp");
      }
    } catch (e) {
      setStampError(e instanceof Error ? e.message : "Failed to cancel the stamp");
    } finally {
      setCancellingStamp(false);
    }
  };

  const handleViewSignedDoc = async () => {
    if (!contract?.signed_document?.id) return;
    try {
      const res = await fetch(`/api/documents/${contract.signed_document.id}/view`);
      if (res.ok) {
        const { signedUrl } = await res.json();
        window.open(signedUrl, "_blank");
        return;
      }
    } catch {
      // fall through to error
    }
    toast.error("Failed to get download URL");
  };

  const handleInitiateSigning = async () => {
    if (!contract) return;
    setInitiatingSigning(true);

    // Generate PDF client-side (jsPDF is browser-only)
    const pdfBase64 = await handleGeneratePDFBase64();
    if (!pdfBase64) {
      toast.error("Failed to generate PDF");
      setInitiatingSigning(false);
      return;
    }

    const res = await fetch(`/api/contracts/${id}/sign`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "initiate", pdf_base64: pdfBase64 }),
    });

    if (res.ok) {
      toast.success("Agreement sent for e-stamping and signing");
      fetchContract(false);
    } else {
      const err = await res.json().catch(() => null);
      toast.error(err?.error || "Failed to initiate signing");
    }
    setInitiatingSigning(false);
  };

  const handleCheckSigningStatus = async () => {
    if (!contract) return;
    setCheckingSigningStatus(true);

    const res = await fetch(`/api/contracts/${id}/sign`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "check_status" }),
    });

    if (res.ok) {
      const json = await res.json();
      const status = json.data?.status;
      if (status === "COMPLETED") {
        toast.success("Agreement fully signed!");
      } else {
        toast.info(`Signing status: ${status}`);
      }
      fetchContract(false);
    } else {
      const err = await res.json().catch(() => null);
      toast.error(err?.error || "Failed to check signing status");
    }
    setCheckingSigningStatus(false);
  };

  const handleCancelSigning = async () => {
    if (!contract) return;
    setCancellingSigning(true);
    setSignCancelError(null);
    try {
      const res = await fetch(`/api/contracts/${id}/sign`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "cancel" }),
      });
      if (res.ok) {
        toast.success("E-signing request cancelled — the customer's signing link no longer works");
        setCancelSigningOpen(false);
        fetchContract(false);
      } else {
        const err = await res.json().catch(() => null);
        setSignCancelError(err?.error || "Failed to cancel the e-signing request");
      }
    } catch (e) {
      setSignCancelError(e instanceof Error ? e.message : "Failed to cancel the e-signing request");
    } finally {
      setCancellingSigning(false);
    }
  };

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-4 w-48" />
        <div className="grid grid-cols-2 gap-4 mt-8">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-12" />
          ))}
        </div>
      </div>
    );
  }

  if (!contract) {
    return (
      <div className="text-center py-12">
        <h2 className="text-xl font-semibold">Contract not found</h2>
        <Button variant="outline" className="mt-4" onClick={() => router.push("/contracts")}>
          Back to Contracts
        </Button>
      </div>
    );
  }

  // Prefer the contract's own snapshotted amount (populated at activation —
  // a negotiated deposit can differ from the months × rate formula) and
  // fall back to the formula only pre-activation, when nothing's snapshotted yet.
  const securityDeposit = contract.security_deposit_amount
    ? contract.security_deposit_amount
    : (contract.security_deposit_months ?? 3) * (contract.subtotal ?? contract.total_amount);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={() => router.push("/contracts")}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-bold font-mono">{contract.contract_number}</h1>
              <Badge variant="secondary" className={CONTRACT_STATUS_COLORS[contract.status]}>
                {CONTRACT_STATUS_LABELS[contract.status]}
              </Badge>
              {contract.signed_document && (
                <Badge className="bg-green-100 text-green-700 border-green-200">
                  <CheckCircle2 className="h-3 w-3 mr-1" /> Signed
                </Badge>
              )}
            </div>
            <p className="text-sm text-muted-foreground">
              {contract.title}
              {contract.location && (
                <span className="ml-2 inline-flex items-center gap-1 text-xs bg-muted px-1.5 py-0.5 rounded">{contract.location.name}</span>
              )}
            </p>
            <div className="mt-2">
              <QueryButton entityType="contract" entityId={contract.id} />
            </div>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {/* Status-based action buttons */}
          {/* Send for e-Signing — available on any pre-terminal status while signing hasn't started */}
          {!contract.leegality_document_id &&
            !["rejected", "terminated", "completed"].includes(contract.status) && (
              <Button
                onClick={handleInitiateSigning}
                disabled={initiatingSigning || !leegalityEnabled}
                title={leegalityEnabled ? undefined : "E-signing is turned off — see Settings → E-Signing. Use company stamp or upload a manually signed document instead."}
              >
                {initiatingSigning ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <PenLine className="mr-2 h-4 w-4" />
                )}
                Send for e-Signing
              </Button>
            )}

          {/* Manual/offline alternative to e-Signing — admin applies TWV's own
              stamp instead of routing the lessor side through Leegality. */}
          {!contract.signed_document && userRole === "admin" && (
            <Button
              variant="outline"
              onClick={handleOpenStampPreview}
              disabled={stampPreviewLoading || uploadingSignedDoc}
            >
              {stampPreviewLoading ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Stamp className="mr-2 h-4 w-4" />
              )}
              Stamp with company seal
            </Button>
          )}

          {/* Stamp an already-uploaded signed document (e.g. a customer-signed
              scan) instead of regenerating the agreement — preserves the
              customer's actual signature. Only offered while that document
              hasn't already been through either stamp flow. */}
          {contract.signed_document && !contract.stamp_reference && userRole === "admin" && (
            <Button
              variant="outline"
              onClick={handleOpenStampExistingPreview}
              disabled={stampExistingPreviewLoading}
            >
              {stampExistingPreviewLoading ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Stamp className="mr-2 h-4 w-4" />
              )}
              Stamp uploaded document
            </Button>
          )}

          {contract.signed_document && contract.stamp_reference && userRole === "admin" && (
            <Button variant="outline" onClick={() => { setStampError(null); setCancelStampOpen(true); }}>
              <XCircle className="mr-2 h-4 w-4" />
              Cancel sign & seal
            </Button>
          )}

          {contract.status === "draft" && !contract.signed_document && (
            <Button variant="outline" onClick={handleOpenEmailDialog} disabled={statusUpdating}>
              <Send className="mr-2 h-4 w-4" />
              Send Agreement
            </Button>
          )}
          {/* A draft with a signed agreement already attached (e.g. uploaded
              off-band before Send Agreement was ever clicked) has no other
              path forward — Send Agreement only shows while signed_document
              is unset. Let an admin or manager jump straight to Accepted so
              Activate becomes reachable. */}
          {contract.status === "draft" && contract.signed_document && ["admin", "manager"].includes(userRole ?? "") && (
            <Button variant="outline" onClick={() => handleStatusUpdate("accepted")} disabled={statusUpdating}>
              {statusUpdating ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <CheckCircle2 className="mr-2 h-4 w-4" />}
              Mark Accepted (Signed)
            </Button>
          )}
          {contract.status === "sent" && (
            <>
              <Button variant="outline" onClick={() => handleStatusUpdate("viewed")} disabled={statusUpdating}>
                {statusUpdating ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Eye className="mr-2 h-4 w-4" />}
                Mark Viewed
              </Button>
              <Button variant="outline" onClick={() => handleStatusUpdate("accepted")} disabled={statusUpdating}>
                {statusUpdating ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <CheckCircle2 className="mr-2 h-4 w-4" />}
                Accept
              </Button>
              <Button variant="destructive" onClick={() => handleStatusUpdate("rejected")} disabled={statusUpdating}>
                <XCircle className="mr-2 h-4 w-4" />
                Reject
              </Button>
            </>
          )}
          {contract.status === "viewed" && (
            <>
              <Button variant="outline" onClick={() => handleStatusUpdate("accepted")} disabled={statusUpdating}>
                {statusUpdating ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <CheckCircle2 className="mr-2 h-4 w-4" />}
                Accept
              </Button>
              <Button variant="destructive" onClick={() => handleStatusUpdate("rejected")} disabled={statusUpdating}>
                <XCircle className="mr-2 h-4 w-4" />
                Reject
              </Button>
            </>
          )}
          {contract.status === "accepted" && (() => {
            // Mirrors the server-side hard gate in /api/contracts/[id] (PATCH, status=active):
            // renewals (deposit_carried_from set) skip the proposal requirement entirely;
            // everything else must have a linked, paid proposal — an absent proposal_id is
            // not "nothing to check", it's a blocker.
            const isRenewal = !!contract.deposit_carried_from;
            const proposalMissing = !isRenewal && !contract.proposal_id;
            // A paid ad-hoc invoice attributed as the pro-rata/first invoice
            // satisfies this the same way proposal.payment_status does — see
            // the identical OR in /api/contracts/[id]'s PATCH handler. Without
            // this, linking one from the "Ad-hoc Invoices" card below (or the
            // hint here) would never actually unblock the Activate button.
            const paidProrataInvoice = prorataAttribution.attributed.find(
              (inv) => inv.attribution_purpose === ACTIVATION_UNBLOCKING_PURPOSE && inv.status === "paid"
            );
            const linkedUnpaidProrataInvoice = prorataAttribution.attributed.find(
              (inv) => inv.attribution_purpose === ACTIVATION_UNBLOCKING_PURPOSE && inv.status !== "paid"
            );
            const proposalPaid = isRenewal
              || (!!contract.proposal_id && (linkedProposal?.payment_status === "paid" || !!paidProrataInvoice));
            const depositRequired = linkedProposal ? Number(linkedProposal.security_deposit_months || 0) > 0 : false;
            // A proposal's collected deposit belongs to whichever contract first
            // claims it at activation (see contracts/[id]/route.ts) — if a
            // different contract already claimed it, this proposal's "paid"
            // status doesn't cover this contract too.
            const depositClaimedByOther = !!linkedProposal?.deposit_claimed_by_contract_id
              && linkedProposal.deposit_claimed_by_contract_id !== contract.id;
            const depositPaid = isRenewal || !depositRequired
              || (!!contract.proposal_id && linkedProposal?.deposit_payment_status === "paid" && !depositClaimedByOther);
            const kycComplete = kycStatus.total === 0 || kycStatus.allSatisfied;
            // Renewals don't gate on pro-rata: it's a continuation, not a new
            // occupancy, and the partial first month (when the new term starts
            // mid-month) bills automatically like any contract's first month —
            // see contracts/[id]/route.ts activation handler.
            const canActivate = !proposalMissing && proposalPaid && depositPaid && kycComplete;
            const hasDeferred = kycStatus.deferred > 0;

            // Closest-amount-first so the invoice that most plausibly *is* the
            // pro-rata payment (just raised as an ad-hoc invoice instead of
            // through the proposal) surfaces before unrelated charges.
            const expectedAmount = prorataAttribution.expectedAmount;
            const prorataCandidates = expectedAmount == null
              ? prorataAttribution.candidates
              : [...prorataAttribution.candidates].sort(
                  (a, b) => Math.abs(a.total_amount - expectedAmount) - Math.abs(b.total_amount - expectedAmount)
                );
            const canLinkInvoice = ["admin", "accounts"].includes(userRole ?? "");

            return canActivate ? (
              <Button
                variant="outline"
                onClick={() => hasDeferred ? setDeferredActivateOpen(true) : attemptActivation()}
                disabled={statusUpdating}
                className={hasDeferred ? "border-amber-400 text-amber-800 hover:bg-amber-50" : ""}
              >
                {statusUpdating ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <CheckCircle2 className="mr-2 h-4 w-4" />}
                Activate{hasDeferred ? " (KYC Pending)" : ""}
              </Button>
            ) : (
              <div className="space-y-2">
                <div className="flex items-center gap-3">
                  <Button variant="outline" disabled className="opacity-50">
                    <CheckCircle2 className="mr-2 h-4 w-4" />
                    Activate
                  </Button>
                  <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-3 py-2">
                    <p className="font-semibold mb-1">Cannot activate until:</p>
                    {proposalMissing && <p>• A proposal is linked to this contract</p>}
                    {!proposalMissing && !proposalPaid && (
                      <div>
                        <p>• Proposal payment collected</p>
                        {linkedUnpaidProrataInvoice ? (
                          <p className="mt-1 pl-3 text-amber-800">
                            Linked ad-hoc invoice <span className="font-mono">{linkedUnpaidProrataInvoice.invoice_number}</span>
                            {" "}({formatCurrency(linkedUnpaidProrataInvoice.total_amount)}) is <strong>{linkedUnpaidProrataInvoice.status}</strong> —
                            {" "}will unlock activation once it&apos;s marked paid.
                          </p>
                        ) : canLinkInvoice && prorataCandidates.length > 0 ? (
                          <div className="mt-1.5 pl-3 space-y-1 border-l-2 border-amber-200">
                            <p className="text-amber-800">Or link an ad-hoc invoice already raised for this customer:</p>
                            {prorataCandidates.slice(0, 3).map((inv) => {
                              const isLikelyMatch = expectedAmount != null && Math.abs(inv.total_amount - expectedAmount) < 1;
                              return (
                                <div key={inv.id} className="flex items-center gap-2">
                                  <Link2 className="h-3 w-3 shrink-0 text-amber-600" />
                                  <span className="font-mono">{inv.invoice_number}</span>
                                  <span>{formatCurrency(inv.total_amount)}</span>
                                  <Badge variant="outline" className="text-[10px] py-0">{inv.status}</Badge>
                                  {isLikelyMatch && (
                                    <Badge variant="outline" className="text-[10px] py-0 border-emerald-300 text-emerald-700 bg-emerald-50">
                                      Likely match
                                    </Badge>
                                  )}
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    className="h-5 px-1.5 text-[11px] text-amber-800 hover:text-amber-900"
                                    disabled={linkingInvoiceId === inv.id}
                                    onClick={() => handleLinkProrataInvoice(inv.id)}
                                  >
                                    {linkingInvoiceId === inv.id ? <Loader2 className="h-3 w-3 animate-spin" /> : "Link"}
                                  </Button>
                                </div>
                              );
                            })}
                          </div>
                        ) : !canLinkInvoice && prorataCandidates.length > 0 ? (
                          <p className="mt-1 pl-3 text-amber-700">
                            {prorataCandidates.length} ad-hoc invoice{prorataCandidates.length === 1 ? "" : "s"} for this customer could cover this —
                            {" "}ask an admin or accounts teammate to link one below.
                          </p>
                        ) : null}
                      </div>
                    )}
                    {!proposalMissing && !depositPaid && (
                      <p>
                        • {depositClaimedByOther
                          ? "Security deposit — already claimed by another contract activated from this same proposal. Collect a separate deposit for this contract."
                          : "Security deposit collected"}
                      </p>
                    )}
                    {!kycComplete && (
                      <p>• KYC documents — {kycStatus.approved} approved, {kycStatus.deferred} deferred, {kycStatus.total - kycStatus.approved - kycStatus.deferred} still missing ({kycStatus.approved + kycStatus.deferred}/{kycStatus.total} satisfied)</p>
                    )}
                  </div>
                </div>
                {userRole === "admin" && (
                  <div className="border border-dashed border-amber-300 rounded-lg p-3 bg-amber-50/50">
                    {!showOverride ? (
                      <button
                        className="text-xs text-amber-700 underline hover:text-amber-900"
                        onClick={() => setShowOverride(true)}
                      >
                        Admin: Override payment requirement
                      </button>
                    ) : (
                      <div className="space-y-2">
                        <p className="text-xs font-semibold text-amber-800">Admin Override — this will be logged</p>
                        <input
                          type="text"
                          value={overrideReason}
                          onChange={(e) => setOverrideReason(e.target.value)}
                          placeholder="Reason (e.g., Legacy contract migration)"
                          className="w-full text-sm border rounded px-3 py-1.5"
                        />
                        <Button
                          size="sm"
                          variant="outline"
                          className="border-amber-400 text-amber-800 hover:bg-amber-100"
                          disabled={!overrideReason.trim() || statusUpdating}
                          onClick={() => attemptActivation(overrideReason.trim())}
                        >
                          {statusUpdating ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : null}
                          Activate with Override
                        </Button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })()}
          {contract.status === "active" && ["admin", "manager"].includes(userRole ?? "") && (
            <Button variant="destructive" onClick={() => setTerminateOpen(true)}>
              <XCircle className="mr-2 h-4 w-4" />
              Terminate
            </Button>
          )}
          {/* Email button for sent/viewed/accepted/rejected — hidden once stamped,
              since the email dialog always sends a freshly generated (unstamped)
              PDF and re-sending that as if it were still under review would be
              misleading once a signed copy exists. */}
          {["sent", "viewed", "accepted", "rejected"].includes(contract.status) && !contract.signed_document && (
            <Button variant="outline" onClick={() => setEmailDialogOpen(true)}>
              <Mail className="mr-2 h-4 w-4" />
              Email
            </Button>
          )}
          <Button variant="outline" onClick={handleDownloadPDF}>
            <Download className="mr-2 h-4 w-4" />
            Download PDF
          </Button>
          {/* Watermark is forced on until start_date locks. Always visible so
              it's clear the watermark exists and why it can't be removed yet
              — soft-disabled (not the native `disabled` attribute, which
              would swallow the click) while unconfirmed: clicking it opens a
              prompt for the date to print on a one-off signature copy
              instead of toggling directly. Once confirmed, behaves as a
              normal toggle for Download PDF + Email. */}
          {["admin", "manager", "sales_rep"].includes(userRole ?? "") && (
            <label
              className={`flex items-center gap-1.5 text-xs border rounded-md px-2.5 select-none ${
                contract.start_date_confirmed
                  ? "text-muted-foreground cursor-pointer"
                  : "text-muted-foreground/70 cursor-not-allowed"
              }`}
            >
              <Checkbox
                checked={contract.start_date_confirmed ? includeDraftWatermark : true}
                onCheckedChange={handleWatermarkCheckboxClick}
              />
              Include DRAFT watermark
            </label>
          )}
          {contract.is_renewal && contract.parent_contract_id && (
            <Button
              variant="outline"
              onClick={() => {
                window.open(`/api/contracts/${contract.id}/addendum`, "_blank");
              }}
            >
              <FileText className="mr-2 h-4 w-4" />
              Addendum
            </Button>
          )}
          {contract.is_renewal && contract.status === "draft" && ["admin", "manager", "sales_rep"].includes(userRole ?? "") && (
            <Button variant="outline" onClick={() => setEditTermsDialogOpen(true)}>
              <Pencil className="mr-2 h-4 w-4" />
              Edit Terms
            </Button>
          )}
        </div>
      </div>

      {/* Contract Chain Strip — shows history when contract is part of a renewal chain */}
      {contract.lead_id && (
        <ContractChainStrip contractId={contract.id} leadId={contract.lead_id} />
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Main Content */}
        <div className="lg:col-span-2 space-y-6">
          {/* Pro-Rata Collection Card — renewal contracts starting mid-month */}
          {contract.is_renewal && contract.prorata_payment_status !== "not_applicable" && (
            <ContractProrataSection
              contract={contract}
              userRole={userRole}
              onSuccess={() => fetchContract(false)}
            />
          )}

          {/* Stale signature-copy warning — the start date changed since a
              watermark-free copy went out for physical signature, so that
              copy no longer matches and needs to be re-sent. */}
          {contract.signature_copy_generated_at &&
            contract.signature_copy_start_date !== contract.start_date && (
              <div className="flex items-center gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3">
                <AlertTriangle className="h-4 w-4 text-amber-600 shrink-0" />
                <div className="flex-1 text-sm text-amber-800">
                  <span className="font-medium">Start date changed since a signature copy was sent</span>
                  <span className="mx-1">—</span>
                  the copy sent for signature had start date{" "}
                  {contract.signature_copy_start_date
                    ? formatDate(contract.signature_copy_start_date)
                    : "unknown"}
                  , it&apos;s now {formatDate(contract.start_date)}. Send an updated copy for
                  signature.
                </div>
              </div>
            )}

          {/* Renewal Chain Banner — visible on renewal contracts */}
          {contract.is_renewal && contract.parent_contract_id && (
            <div className="flex items-center gap-3 rounded-lg border border-blue-200 bg-blue-50 px-4 py-3">
              <RefreshCw className="h-4 w-4 text-blue-600 shrink-0" />
              <div className="flex-1 text-sm text-blue-800">
                <span className="font-medium">Renewal contract</span>
                {contract.renewal_sequence && contract.renewal_sequence > 1 && (
                  <span> (V{contract.renewal_sequence})</span>
                )}
                <span className="mx-1">—</span>
                <Link
                  href={`/contracts/${contract.parent_contract_id}`}
                  className="text-blue-700 hover:underline font-medium"
                >
                  View parent contract →
                </Link>
              </div>
              {contract.deposit_carried_from && (
                Number(contract.deposit_shortfall || 0) > 0 ? (
                  <Badge variant="secondary" className="bg-amber-100 text-amber-700 text-[10px] shrink-0">
                    Deposit shortfall: {formatCurrency(Number(contract.deposit_shortfall || 0))}
                  </Badge>
                ) : (
                  <Badge variant="secondary" className="bg-green-100 text-green-700 text-[10px] shrink-0">
                    Deposit pooled
                  </Badge>
                )
              )}
              {contract.escalation_waived && (
                <Badge variant="secondary" className="bg-amber-100 text-amber-700 text-[10px] shrink-0">
                  Escalation waived
                </Badge>
              )}
            </div>
          )}

          {/* Overview Card */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Overview</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
                {contract.lead && (
                  <>
                    <div>
                      <p className="text-muted-foreground text-xs">Lead</p>
                      <Link
                        href={`/leads/${contract.lead.id}`}
                        className="text-primary hover:underline font-medium"
                      >
                        {contract.lead.first_name} {contract.lead.last_name}
                      </Link>
                    </div>
                    {contract.lead.company && (
                      <div>
                        <p className="text-muted-foreground text-xs">Company</p>
                        <p>{contract.lead.company}</p>
                      </div>
                    )}
                    {contract.lead.email && (
                      <div>
                        <p className="text-muted-foreground text-xs">Email</p>
                        <p>{contract.lead.email}</p>
                      </div>
                    )}
                    {contract.lead.pan_number && (
                      <div>
                        <p className="text-muted-foreground text-xs">PAN</p>
                        <p className="font-mono">{contract.lead.pan_number}</p>
                      </div>
                    )}
                    {contract.lead.gst_number && (
                      <div>
                        <p className="text-muted-foreground text-xs">GSTIN</p>
                        <p className="font-mono">{contract.lead.gst_number}</p>
                      </div>
                    )}
                    {contract.lead.entity_type && (
                      <div>
                        <p className="text-muted-foreground text-xs">Entity Type</p>
                        <p>{ENTITY_TYPE_LABELS[contract.lead.entity_type] || contract.lead.entity_type}</p>
                      </div>
                    )}
                  </>
                )}
                {contract.is_renewal && contract.parent_contract_id ? (
                  <div>
                    <p className="text-muted-foreground text-xs">Parent Contract</p>
                    <Link
                      href={`/contracts/${contract.parent_contract_id}`}
                      className="text-primary hover:underline font-medium font-mono text-xs"
                    >
                      {contract.parent_contract?.contract_number ?? "View parent contract"}
                    </Link>
                  </div>
                ) : contract.proposal && (
                  <div>
                    <p className="text-muted-foreground text-xs">Proposal</p>
                    <Link
                      href={`/proposals/${contract.proposal.id}`}
                      className="text-primary hover:underline font-medium font-mono text-xs"
                    >
                      {contract.proposal.proposal_number}
                    </Link>
                  </div>
                )}
              </div>
              <Separator className="my-4" />
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
                <div>
                  <p className="text-muted-foreground text-xs">Monthly Fee</p>
                  <p className="font-bold text-lg">{formatCurrency(contract.subtotal ?? contract.total_amount)}</p>
                  {contract.tax_percentage > 0 && (
                    <p className="text-muted-foreground text-xs mt-0.5">{formatCurrency(contract.total_amount)} incl. {contract.tax_percentage}% GST</p>
                  )}
                </div>
                <div>
                  <p className="text-muted-foreground text-xs">Tax ({contract.tax_percentage}%)</p>
                  <p className="font-medium">{formatCurrency(contract.tax_amount)}</p>
                </div>
                <div>
                  <p className="text-muted-foreground text-xs">Security Deposit</p>
                  {(contract.security_deposit_months ?? 3) === 0 ? (
                    <>
                      <p className="font-medium">Waived</p>
                      {linkedProposal?.deposit_waiver_verified_by_user?.full_name && (
                        <Link
                          href={`/proposals/${linkedProposal.id}#deposit-waiver-gate`}
                          className="text-[10px] text-green-600 mt-0.5 hover:underline block"
                        >
                          ✓ Waived off by {linkedProposal.deposit_waiver_verified_by_user.full_name}
                        </Link>
                      )}
                    </>
                  ) : contract.deposit_carried_from ? (
                    <>
                      <p className="font-medium">{formatCurrency(securityDeposit)}</p>
                      <p className="text-[10px] text-green-600 mt-0.5">✓ Pooled with customer</p>
                    </>
                  ) : (CONTRACT_QUOTA_LOCKED_STATUSES as readonly string[]).includes(contract.status) ? (
                    // Post-activation: the contract owns its own deposit snapshot now
                    // (see contracts/[id]/route.ts) — no proposal dependency, so this
                    // works for legacy/no-proposal contracts too.
                    contract.deposit_payment_status === "paid" ? (
                      <>
                        <p className="font-medium">
                          {formatCurrency(Number(contract.deposit_payment_amount || contract.security_deposit_amount || securityDeposit))}
                        </p>
                        <p className="text-[10px] text-green-600 mt-0.5">✓ Received</p>
                      </>
                    ) : (
                      <p className="font-medium text-amber-600">Pending</p>
                    )
                  ) : linkedProposal?.deposit_payment_status === "paid" ? (
                    <Link href={`/proposals/${linkedProposal.id}#security-deposit`} className="block hover:underline">
                      <p className="font-medium">
                        {formatCurrency(Number(linkedProposal.deposit_payment_amount || linkedProposal.security_deposit_amount || securityDeposit))}
                      </p>
                      <p className="text-[10px] text-green-600 mt-0.5">✓ Received — view payment details</p>
                    </Link>
                  ) : (
                    <p className="font-medium text-amber-600">Pending</p>
                  )}
                  {contract.deposit_shortfall != null && contract.deposit_shortfall > 0 && (
                    <p className="text-[10px] text-amber-600 mt-0.5">
                      Shortfall: {formatCurrency(contract.deposit_shortfall)}
                    </p>
                  )}
                </div>
                <div>
                  <p className="text-muted-foreground text-xs">Seats</p>
                  <p className="font-medium">{contract.seats}</p>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Recurring Add-ons */}
          <ContractAddonsSection
            contractId={id}
            contractStartDate={contract.start_date}
            contractEndDate={contract.end_date}
            taxPercentage={contract.tax_percentage ?? 18}
          />

          {/* Tiered Rate Schedule — only editable pre-activation, mirrors the
              API's own lock gate (same statuses as quota locking). */}
          <ContractRatePhasesSection
            contractId={id}
            tenureMonths={contract.tenure_months}
            baseMonthlyRate={contract.subtotal ?? contract.total_amount}
            phases={contract.rate_phases ?? []}
            phaseStartDate={contract.phase_start_date || contract.start_date}
            canEdit={
              ["admin", "manager", "sales_rep"].includes(userRole ?? "") &&
              !(CONTRACT_QUOTA_LOCKED_STATUSES as readonly string[]).includes(contract.status)
            }
            onPhasesUpdated={() => fetchContract(false)}
          />

          {/* Security Deposit Snapshot — renders pre-activation off the linked
              proposal, or post-activation off the contract's own snapshot
              even when no proposal is (or ever was) linked. */}
          {(linkedProposal || (CONTRACT_QUOTA_LOCKED_STATUSES as readonly string[]).includes(contract.status)) && (
            <ContractDepositSection
              proposal={linkedProposal}
              contract={contract}
              depositCarriedFrom={contract.deposit_carried_from}
              leadId={contract.lead_id || undefined}
              depositShortfall={contract.deposit_shortfall}
            />
          )}

          {/* Deposit Top-ups — collect additional deposit, incl. renewal-escalation shortfall */}
          <ContractDepositTopupsSection
            contractId={id}
            currentUserRole={userRole ?? ""}
            depositShortfall={contract.deposit_shortfall}
            onShortfallCollected={() => fetchContract(false)}
          />

          {/* Deposit Adjustments — pending approvals + history */}
          <ContractDepositAdjustmentsSection
            contractId={id}
            currentUserId={user?.id ?? null}
            currentUserRole={userRole ?? ""}
          />

          {/* Monthly Invoices (proforma + GST invoice) + billing mode toggle */}
          <ContractInvoicesSection
            contractId={id}
            billingMode={contract.billing_mode}
            contractStatus={contract.status}
            proposalId={contract.proposal_id}
            proposalNumber={contract.proposal?.proposal_number}
            prorataPaymentStatus={contract.proposal?.payment_status}
            prorataPaymentReceivedAt={contract.proposal?.payment_received_at}
            billingCycle={contract.billing_cycle}
            nextBillingDate={contract.next_billing_date}
            startDate={contract.start_date}
            endDate={contract.end_date}
            createdAt={contract.created_at}
          />

          {/* Ad-hoc lead invoices attributed to this contract */}
          <ContractAttributedInvoicesSection
            contractId={id}
            currentUserRole={userRole ?? ""}
            onAttributionChanged={() => fetchContract(false)}
          />

          {/* Agreement Details Card */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Agreement Details</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
                {contract.workspace_description && (
                  <div className="sm:col-span-2">
                    <p className="text-muted-foreground text-xs">Workspace Description</p>
                    <p>{contract.workspace_description}</p>
                  </div>
                )}
                {contract.parking_space && (
                  <div>
                    <p className="text-muted-foreground text-xs">Parking Space</p>
                    <p>{contract.parking_space}</p>
                  </div>
                )}
                {contract.complimentary_services && (
                  <div className="sm:col-span-2">
                    <p className="text-muted-foreground text-xs">Complimentary Services</p>
                    <p className="whitespace-pre-wrap">{contract.complimentary_services}</p>
                  </div>
                )}
                <div>
                  <p className="text-muted-foreground text-xs">Security Deposit</p>
                  <p>{(contract.security_deposit_months ?? 3) === 0 ? "Waived" : `${contract.security_deposit_months ?? 3}x Monthly Fee = ${formatCurrency(securityDeposit)}`}</p>
                </div>
                <div>
                  <p className="text-muted-foreground text-xs">Annual Escalation</p>
                  <p>
                    {contract.escalation_percentage || 10}%
                    {contract.escalation_waived && (
                      <span className="ml-1.5 text-[10px] text-amber-600 font-medium">(waived)</span>
                    )}
                  </p>
                </div>
                {contract.lock_in_months != null && (
                  <div>
                    <p className="text-muted-foreground text-xs">Lock-in Period</p>
                    <p>{contract.lock_in_months} month{contract.lock_in_months !== 1 ? "s" : ""}</p>
                  </div>
                )}
                <div>
                  <p className="text-muted-foreground text-xs">Notice Period</p>
                  <p>{contract.notice_period_months || 2} months</p>
                </div>
                {contract.commitment_override_reason && (
                  <div className="sm:col-span-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
                    <p className="font-medium">
                      Terms overridden from {contract.proposal?.proposal_number ?? "the proposal"}
                      {contract.proposal && contract.proposal.tenure_months != null && contract.proposal.lock_in_months != null && contract.proposal.notice_period_months != null && (() => {
                        const diffs = commitmentDifferences(
                          {
                            tenure_months: contract.proposal.tenure_months,
                            lock_in_months: contract.proposal.lock_in_months,
                            notice_period_months: contract.proposal.notice_period_months,
                          },
                          {
                            tenure_months: contract.tenure_months,
                            lock_in_months: contract.lock_in_months ?? contract.proposal.lock_in_months,
                            notice_period_months: contract.notice_period_months ?? contract.proposal.notice_period_months,
                          }
                        );
                        return diffs.length > 0 ? `: ${diffs.join(", ")}` : null;
                      })()}
                    </p>
                    <p className="mt-1">&ldquo;{contract.commitment_override_reason}&rdquo;</p>
                    <p className="mt-1 text-amber-800/80">
                      {contract.commitment_overridden_by_user?.full_name ?? "Admin"}
                      {contract.commitment_overridden_at && ` · ${formatDate(contract.commitment_overridden_at)}`}
                    </p>
                  </div>
                )}
                {contract.agreement_date && (
                  <div>
                    <p className="text-muted-foreground text-xs">Agreement Date</p>
                    <p>{formatDate(contract.agreement_date)}</p>
                  </div>
                )}
              </div>
              {(contract.member_signatory_name || contract.member_signatory_designation) && (
                <>
                  <Separator className="my-4" />
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
                    {contract.member_signatory_name && (
                      <div>
                        <p className="text-muted-foreground text-xs">Member Signatory</p>
                        <p className="font-medium">{contract.member_signatory_name}</p>
                      </div>
                    )}
                    {contract.member_signatory_designation && (
                      <div>
                        <p className="text-muted-foreground text-xs">Designation</p>
                        <p>{contract.member_signatory_designation}</p>
                      </div>
                    )}
                  </div>
                </>
              )}
            </CardContent>
          </Card>

          {/* KYC Documents — Upload & Approval */}
          <ContractDocumentsTab
            contractId={id}
            userRole={userRole}
            onKycStatusChange={handleKycStatusChange}
          />

          {/* Line Items Table */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Line Items</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="rounded-md border overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b bg-muted/50">
                      <th className="px-4 py-3 text-left font-medium">Description</th>
                      <th className="px-4 py-3 text-right font-medium">Qty</th>
                      <th className="px-4 py-3 text-right font-medium">Unit Price</th>
                      <th className="px-4 py-3 text-right font-medium">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {contract.items.map((item, idx) => (
                      <tr key={idx} className="border-b">
                        <td className="px-4 py-3">{item.description}</td>
                        <td className="px-4 py-3 text-right">{item.quantity}</td>
                        <td className="px-4 py-3 text-right">{formatCurrency(item.unit_price)}</td>
                        <td className="px-4 py-3 text-right font-medium">{formatCurrency(item.total)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>

          {/* Agreement document history — old executed versions stay
              visible/downloadable after a reupload (e.g. customer name
              change or a change-of-law redocumentation). */}
          <AgreementDocumentHistory
            listUrl={`/api/contracts/${id}/agreement-versions`}
            reuploadUrl={`/api/contracts/${id}/reupload-agreement`}
            canManage={["admin", "manager", "sales_rep"].includes(userRole ?? "")}
            hasExistingDocument={!!contract.signed_document}
            onChanged={fetchContract}
          />

          {/* Terms & Conditions */}
          {contract.terms_and_conditions && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Terms & Conditions</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm whitespace-pre-wrap">{contract.terms_and_conditions}</p>
              </CardContent>
            </Card>
          )}

          {/* Contract Contacts — each contract can have its own set of
              contact persons (finance, occupant, signatory, etc.) */}
          <ContractContactsPanel
            contractId={id}
            leadId={contract.lead_id || undefined}
          />

          {/* Vouchers Section */}
          <ContractVouchersSection
            contractId={id}
            seats={contract.seats}
            contractStatus={contract.status}
            startDate={contract.start_date}
            endDate={contract.end_date}
            tenureMonths={contract.tenure_months}
            signedDocumentId={contract.signed_document_id}
            leadEmail={contract.lead?.email}
            locationId={contract.location_id}
            printerDepartmentId={contract.department_id ?? undefined}
            onDepartmentIdUpdate={fetchContract}
          />

          {/* Members & Access Control (lifecycle steps shown inline per member) */}
          <ContractMembersAccessSection
            contractId={id}
            seats={contract.seats}
            contractStatus={contract.status}
          />

          {/* ── Quota sections ──────────────────────────────────────────────
               Active (and beyond) contracts: only admin can edit.
               Draft/Sent/Accepted: admin, manager, accounts can edit.
               Terminated/Expired/Rejected: still shown (read-only) so
               negotiated rates/quotas remain visible for reference — e.g.
               to log a backdated booking against the rate that was in
               effect, or for accounting to look up historical terms. */}
          {(() => {
            const isTerminal = ["terminated", "expired", "rejected"].includes(contract.status);
            const isLocked = (CONTRACT_QUOTA_LOCKED_STATUSES as readonly string[]).includes(contract.status);
            const hasQuotaRole = (CONTRACT_QUOTA_ROLES as readonly string[]).includes(userRole || "");
            const canEdit = !isTerminal && hasQuotaRole && (["admin", "manager"].includes(userRole || "") || !isLocked);
            const quotaReadOnly = !canEdit;
            return (
              <>
                <ContractFacilitiesSection
                  contractId={id}
                  locationId={contract.location_id ?? null}
                  readOnly={quotaReadOnly}
                />
                <ContractQuotasSection
                  contractId={id}
                  readOnly={quotaReadOnly}
                />
              </>
            );
          })()}

          {/* Billing Moratorium */}
          {["active", "renewal_in_progress"].includes(contract.status) && (
            <ContractMoratoriumSection
              contract={contract}
              currentUserRole={user?.role ?? ""}
            />
          )}

          {/* Billing Section */}
          {["active", "completed"].includes(contract.status) && (
            <ContractBillingSection contractId={id} />
          )}

          {/* Meeting Room Bookings History */}
          <ContractBookingsSection contractId={id} />

          {/* Service Usage History (print, etc.) — hidden if no records */}
          <ContractServiceUsageSection contractId={id} />

          {/* Door Access Logs */}
          <ContractAccessLogsSection contractId={id} />

          {/* Electricity Billing Config */}
          <ContractElectricityTab
            contractId={id}
            contractGstRate={contract.tax_percentage ?? 18}
            canEdit={["admin", "manager"].includes(userRole ?? "")}
          />

          {/* Notes */}
          {contract.notes && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Notes</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm whitespace-pre-wrap">{contract.notes}</p>
              </CardContent>
            </Card>
          )}
        </div>

        {/* Sidebar */}
        <div className="space-y-4">
          {/* Renewal Card — pinned to top of sidebar for active/expired/renewal_in_progress/renewed contracts */}
          {["active", "expired", "renewal_in_progress", "renewed"].includes(contract.status) && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base flex items-center gap-2">
                  <RefreshCw className="h-4 w-4" />
                  Renewal
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                {/* Renewal chain info */}
                {contract.is_renewal && contract.parent_contract_id && (
                  <div className="flex justify-between items-center">
                    <span className="text-muted-foreground text-xs">Renewal of</span>
                    <Link
                      href={`/contracts/${contract.parent_contract_id}`}
                      className="text-xs text-primary hover:underline font-mono"
                    >
                      View parent →
                    </Link>
                  </div>
                )}
                {contract.renewal_sequence && contract.renewal_sequence > 1 && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground text-xs">Renewal #</span>
                    <Badge variant="secondary" className="text-[10px]">
                      V{contract.renewal_sequence}
                    </Badge>
                  </div>
                )}

                {/* Escalation approval status — on renewal drafts */}
                {contract.is_renewal && contract.escalation_approval_status && (
                  <div className={`rounded-md border px-3 py-2 text-xs space-y-1 ${
                    contract.escalation_approval_status === "pending"
                      ? "border-purple-200 bg-purple-50 text-purple-800"
                      : contract.escalation_approval_status === "approved"
                        ? "border-green-200 bg-green-50 text-green-800"
                        : "border-red-200 bg-red-50 text-red-800"
                  }`}>
                    <p className="font-semibold flex items-center gap-1">
                      {contract.escalation_approval_status === "pending" && "⏳ Escalation Approval Pending"}
                      {contract.escalation_approval_status === "approved" && "✓ Escalation Approved"}
                      {contract.escalation_approval_status === "rejected" && "✗ Escalation Rejected"}
                    </p>
                    <p>
                      {contract.escalation_approval_status === "pending" && "The reduced/waived escalation rate is awaiting admin approval. The contract cannot be activated until approved."}
                      {contract.escalation_approval_status === "approved" && "The negotiated escalation rate has been approved by admin."}
                      {contract.escalation_approval_status === "rejected" && "The proposed escalation was rejected. The rate has been reverted to the default escalation."}
                    </p>
                  </div>
                )}

                {/* Escalation waiver — admin only, on renewal drafts */}
                {contract.is_renewal && contract.status === "draft" && !contract.escalation_approval_status && (
                  <EscalationWaiverSection
                    contractId={contract.id}
                    escalationWaived={contract.escalation_waived || false}
                    waiverReason={contract.escalation_waiver_reason || null}
                    userRole={userRole}
                    onSuccess={() => fetchContract(false)}
                  />
                )}

                {/* Decline info */}
                {contract.renewal_declined && (
                  <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800 space-y-1">
                    <p className="font-semibold">Renewal Declined</p>
                    <p>{contract.renewal_declined_reason}</p>
                    {contract.renewal_declined_at && (
                      <p className="text-red-600">{formatDate(contract.renewal_declined_at)}</p>
                    )}
                  </div>
                )}

                {/* Deposit carry info for renewals */}
                {contract.deposit_carried_from && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground text-xs">Deposit</span>
                    <span className="text-xs text-green-700">Pooled with customer</span>
                  </div>
                )}
                {contract.deposit_shortfall != null && contract.deposit_shortfall > 0 && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground text-xs">Deposit Shortfall</span>
                    <span className="text-xs text-amber-700 font-medium">
                      {formatCurrency(contract.deposit_shortfall)}
                    </span>
                  </div>
                )}

                {/* Reminder tracking */}
                {(contract.renewal_reminder_count || 0) > 0 && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground text-xs">Reminders Sent</span>
                    <span className="text-xs">{contract.renewal_reminder_count}</span>
                  </div>
                )}

                {/* Extension usage — visible whenever this contract has ever been extended */}
                {(contract.days_extended || 0) > 0 && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground text-xs">Extended</span>
                    <span className="text-xs">{contract.days_extended} / 60 days</span>
                  </div>
                )}

                {/* Action buttons — only for active/expired, not already renewed or declined */}
                {/* Role gate: admin, manager, sales_rep can renew/decline/extend */}
                {["active", "expired"].includes(contract.status) && !contract.renewal_declined && ["admin", "manager", "sales_rep"].includes(userRole || "") && (() => {
                  // Renewal window: only opens up within 45 days of expiry — an
                  // "expired" contract is already past that window by definition.
                  // Mirrors the hard gate in POST /api/contracts/[id]/renew.
                  const daysUntilExpiry = contract.end_date
                    ? Math.ceil((new Date(contract.end_date + "T00:00:00Z").getTime() - Date.now()) / 86_400_000)
                    : null;
                  const renewalWindowOpen = contract.status === "expired" || (daysUntilExpiry !== null && daysUntilExpiry <= 45);

                  return (
                  <div className="space-y-1.5 pt-1">
                    <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
                      <span>Not sure which to use?</span>
                      <InfoTooltip
                        text="Extend pushes the current end date forward by up to 60 days total, with no change to rate or terms — use it for a short gap (e.g. paperwork running a few days late). Renew creates a new contract term with its own tenure, escalation, and deposit — use it when the member is signing on for a fresh period."
                        side="top"
                      />
                    </div>
                    {!renewalWindowOpen && (
                      <p className="text-[10px] text-muted-foreground">
                        Renew unlocks 45 days before expiry
                        {contract.end_date && ` (from ${formatDate(new Date(new Date(contract.end_date + "T00:00:00Z").getTime() - 45 * 86_400_000).toISOString().slice(0, 10))})`}.
                      </p>
                    )}
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        className="flex-1"
                        disabled={!renewalWindowOpen}
                        title={!renewalWindowOpen ? "Renewal opens 45 days before expiry" : undefined}
                        onClick={() => setRenewDialogOpen(true)}
                      >
                        <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                        Renew
                      </Button>
                      {contract.status === "active" && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="flex-1"
                          onClick={() => setExtendDialogOpen(true)}
                        >
                          <CalendarPlus className="mr-1.5 h-3.5 w-3.5" />
                          Extend
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="outline"
                        className="text-destructive hover:text-destructive"
                        onClick={() => setDeclineDialogOpen(true)}
                      >
                        <XCircle className="mr-1.5 h-3.5 w-3.5" />
                        Decline
                      </Button>
                    </div>
                  </div>
                  );
                })()}

                {/* The renewal's term has started but the contract isn't live.
                    Until it is activated the run cannot bill it, so this
                    (ended) contract gets charged for the new term instead —
                    right customer and amount, wrong contract. */}
                {contract.status === "renewal_in_progress" && renewalDraft?.start_date &&
                  renewalDraft.status !== "active" &&
                  renewalDraft.start_date <= new Date(Date.now() + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10) && (
                  <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800 space-y-1">
                    <p className="font-semibold">
                      ⚠️ {renewalDraft.contract_number} started {formatDate(renewalDraft.start_date)} but isn&apos;t active
                    </p>
                    <p>
                      Until it&apos;s activated, month-end billing charges <strong>this</strong> contract
                      for the renewal period — even though its term ended {formatDate(contract.end_date)}.
                      Activate the renewal before the next billing run.
                    </p>
                  </div>
                )}

                {contract.status === "renewal_in_progress" && (
                  <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 space-y-2">
                    <p className="font-semibold">⏳ Renewal in Progress</p>
                    <p>A renewal draft has been created and is awaiting finalization. This contract remains active until the renewal is activated.</p>
                    {renewalDraft && (
                      <Link
                        href={`/contracts/${renewalDraft.id}`}
                        className="inline-flex items-center gap-1.5 text-xs font-medium text-amber-900 bg-amber-100 hover:bg-amber-200 rounded-md px-2.5 py-1.5 transition-colors"
                      >
                        <RefreshCw className="h-3 w-3" />
                        Open Renewal Draft — {renewalDraft.contract_number}
                        <span className="text-amber-600">→</span>
                      </Link>
                    )}
                    {renewalDraft?.status === "draft" && ["admin", "manager", "sales_rep"].includes(userRole || "") && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="w-full text-destructive hover:text-destructive"
                        onClick={() => setCancelRenewalDialogOpen(true)}
                      >
                        <XCircle className="mr-1.5 h-3.5 w-3.5" />
                        Cancel Renewal
                      </Button>
                    )}
                  </div>
                )}

                {contract.status === "renewed" && renewalDraft && (
                  <Link
                    href={`/contracts/${renewalDraft.id}`}
                    className="inline-flex items-center gap-1.5 text-xs font-medium text-green-800 bg-green-50 hover:bg-green-100 border border-green-200 rounded-md px-2.5 py-1.5 w-full justify-center transition-colors"
                  >
                    <RefreshCw className="h-3 w-3" />
                    View Renewed Contract — {renewalDraft.contract_number}
                    <span className="text-green-500">→</span>
                  </Link>
                )}

                {contract.status === "renewed" && !renewalDraft && (
                  <p className="text-xs text-green-700 font-medium text-center">
                    ✓ Contract has been renewed
                  </p>
                )}
              </CardContent>
            </Card>
          )}

          {/* Contract Details Card */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Contract Details</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Billing Cycle</span>
                <span>{BILLING_CYCLE_LABELS[contract.billing_cycle]}</span>
              </div>
              <Separator />
              <div className="flex justify-between">
                <span className="text-muted-foreground">Tenure</span>
                <span>{contract.tenure_months} months</span>
              </div>
              <Separator />
              <div className="flex justify-between items-center">
                <span className="text-muted-foreground">Start Date</span>
                <span className="flex items-center gap-2">
                  {formatDate(contract.start_date)}
                  {contract.start_date_confirmed === false && (
                    <Badge variant="outline" className="text-amber-700 border-amber-300 bg-amber-50">
                      Pending pro-rata payment
                    </Badge>
                  )}
                </span>
              </div>
              <Separator />
              <div className="flex justify-between">
                <span className="text-muted-foreground">End Date</span>
                <span>{formatDate(contract.end_date)}</span>
              </div>
              {contract.next_billing_date && (
                <>
                  <Separator />
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Next Billing</span>
                    <span>{formatDate(contract.next_billing_date)}</span>
                  </div>
                </>
              )}
              <Separator />
              <div className="flex justify-between">
                <span className="text-muted-foreground">Seats</span>
                <span>{contract.seats}</span>
              </div>
              {/* Department ID surfaced in the sidebar so staff don't have to
                  scroll to the Vouchers section to see whether the contract
                  is mapped for printer billing. Only shown for contracts that
                  have a location (no location → no printer to map). */}
              {contract.location_id && (
                <>
                  <Separator />
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Department ID</span>
                    <span className="font-mono">
                      {contract.department_id ? (
                        <Badge variant="secondary" className="font-mono">{contract.department_id}</Badge>
                      ) : (
                        <span className="text-xs text-muted-foreground italic">Not mapped</span>
                      )}
                    </span>
                  </div>
                </>
              )}
              <Separator />
              <div className="flex justify-between items-center gap-2">
                <span className="text-muted-foreground shrink-0">Customer PO Number</span>
                {editingPoNumber ? (
                  <div className="flex items-center gap-1.5">
                    <Input
                      value={poNumberValue}
                      onChange={(e) => setPoNumberValue(e.target.value)}
                      placeholder="e.g. 4500218763"
                      className="h-7 text-sm w-32"
                      autoFocus
                      onKeyDown={(e) => e.key === "Enter" && handleSavePoNumber()}
                    />
                    <Button size="sm" className="h-7 text-xs px-2" onClick={handleSavePoNumber} disabled={savingPoNumber}>
                      {savingPoNumber ? <Loader2 className="h-3 w-3 animate-spin" /> : "Save"}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 text-xs px-2"
                      onClick={() => setEditingPoNumber(false)}
                    >
                      Cancel
                    </Button>
                  </div>
                ) : (
                  <span className="flex items-center gap-2">
                    {contract.po_number ? (
                      <Badge variant="secondary" className="font-mono">{contract.po_number}</Badge>
                    ) : (
                      <span className="text-xs text-muted-foreground italic">Not set</span>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 text-xs px-1.5"
                      onClick={() => { setPoNumberValue(contract.po_number || ""); setEditingPoNumber(true); }}
                    >
                      <Pencil className="h-3 w-3" />
                    </Button>
                  </span>
                )}
              </div>
            </CardContent>
          </Card>

          {/* Contract Lifecycle */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Agreement Journey</CardTitle>
            </CardHeader>
            <CardContent>
              <ContractLifecycle contract={contract} />
            </CardContent>
          </Card>

          {/* Signed Contract */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <FileText className="h-4 w-4" />
                Signed Contract
              </CardTitle>
            </CardHeader>
            <CardContent>
              {contract.signed_document ? (
                <div className="space-y-3">
                  <div className="flex items-center gap-2 text-sm">
                    <FileText className="h-4 w-4 text-green-600" />
                    <span className="truncate font-medium">
                      {contract.signed_document.file_name}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Uploaded {formatDate(contract.signed_document.created_at)}
                  </p>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={handleViewSignedDoc}
                    >
                      <Eye className="mr-1.5 h-3.5 w-3.5" />
                      View
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => signedDocInputRef.current?.click()}
                      disabled={uploadingSignedDoc}
                    >
                      <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                      Replace
                    </Button>
                  </div>
                </div>
              ) : (
                <div
                  className="border-2 border-dashed rounded-lg p-4 text-center cursor-pointer hover:border-primary/50 hover:bg-muted/30 transition-colors"
                  onClick={() => {
                    if (!uploadingSignedDoc) signedDocInputRef.current?.click();
                  }}
                >
                  {uploadingSignedDoc ? (
                    <div className="space-y-2">
                      <Loader2 className="h-6 w-6 mx-auto animate-spin text-muted-foreground" />
                      <p className="text-xs text-muted-foreground">Uploading...</p>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      <Upload className="h-6 w-6 mx-auto text-muted-foreground" />
                      <p className="text-xs text-muted-foreground">
                        Upload signed contract
                      </p>
                      <p className="text-[10px] text-muted-foreground">
                        PDF, JPG, or PNG (max 10MB)
                      </p>
                    </div>
                  )}
                </div>
              )}
              {!contract.signed_document && contract.status === "active" && (
                <p className="text-xs text-amber-600 mt-2 flex items-center gap-1">
                  <AlertTriangle className="h-3 w-3" />
                  Required before issuing vouchers
                </p>
              )}
            </CardContent>
          </Card>

          {/* E-Signing Card — shown when Leegality signing has been initiated */}
          {contract.leegality_document_id && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base flex items-center justify-between">
                  <span className="flex items-center gap-2">
                    <PenLine className="h-4 w-4" />
                    Digital Signing
                  </span>
                  {/* Status badge */}
                  {contract.leegality_status === "COMPLETED" ? (
                    <Badge className="bg-green-100 text-green-700 border-green-200">
                      <CheckCircle2 className="h-3 w-3 mr-1" /> Fully Signed
                    </Badge>
                  ) : contract.leegality_status === "EXPIRED" ? (
                    <Badge variant="destructive">
                      <XCircle className="h-3 w-3 mr-1" /> Expired
                    </Badge>
                  ) : contract.leegality_status === "CANCELLED" ? (
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

                {contract.signed_at && (
                  <p className="text-xs text-green-600 font-medium">
                    ✓ Completed on {formatDate(contract.signed_at)}
                  </p>
                )}

                {/* TWV (Lessor) signing link */}
                {contract.leegality_sign_url && contract.leegality_status !== "COMPLETED" && (
                  <div className="space-y-1.5">
                    <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">TWV Signing Link</p>
                    <div className="flex items-center gap-2">
                      <a
                        href={contract.leegality_sign_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex-1 text-xs text-primary hover:underline truncate font-mono bg-muted px-2 py-1.5 rounded"
                      >
                        {contract.leegality_sign_url}
                      </a>
                      <Button
                        size="icon"
                        variant="outline"
                        className="h-7 w-7 shrink-0"
                        onClick={() => copyToClipboard(contract.leegality_sign_url!, "lessor")}
                        title="Copy TWV signing link"
                      >
                        {copiedLessor ? <Check className="h-3.5 w-3.5 text-green-600" /> : <Copy className="h-3.5 w-3.5" />}
                      </Button>
                      <a href={contract.leegality_sign_url} target="_blank" rel="noopener noreferrer">
                        <Button size="icon" variant="outline" className="h-7 w-7 shrink-0" title="Open in new tab">
                          <ExternalLink className="h-3.5 w-3.5" />
                        </Button>
                      </a>
                    </div>
                  </div>
                )}

                {/* Customer (Lessee) signing link */}
                {contract.leegality_status !== "COMPLETED" && (
                  <div className="space-y-1.5">
                    <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Customer Signing</p>
                    {contract.leegality_lessee_sign_url ? (
                      <>
                        <div className="flex items-center gap-2">
                          <a
                            href={contract.leegality_lessee_sign_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="flex-1 text-xs text-primary hover:underline truncate font-mono bg-muted px-2 py-1.5 rounded"
                          >
                            {contract.leegality_lessee_sign_url}
                          </a>
                          <Button
                            size="icon"
                            variant="outline"
                            className="h-7 w-7 shrink-0"
                            onClick={() => copyToClipboard(contract.leegality_lessee_sign_url!, "lessee")}
                            title="Copy customer signing link"
                          >
                            {copiedLessee ? <Check className="h-3.5 w-3.5 text-green-600" /> : <Copy className="h-3.5 w-3.5" />}
                          </Button>
                          <a href={contract.leegality_lessee_sign_url} target="_blank" rel="noopener noreferrer">
                            <Button size="icon" variant="outline" className="h-7 w-7 shrink-0" title="Open in new tab">
                              <ExternalLink className="h-3.5 w-3.5" />
                            </Button>
                          </a>
                        </div>
                        <p className="text-xs text-muted-foreground">Send this link to the customer to sign via Aadhaar eSign</p>
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

                <p className="text-xs text-muted-foreground font-mono">
                  Ref: {contract.leegality_document_id}
                </p>

                {contract.leegality_status !== "COMPLETED" && (
                  <Button
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

                {/* Withdraws the request from Leegality outright — the customer's
                    signing link stops working. Only offered while something is
                    actually live to cancel. */}
                {!["COMPLETED", "EXPIRED", "CANCELLED"].includes(contract.leegality_status || "") && userRole === "admin" && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="w-full text-destructive hover:text-destructive"
                    onClick={() => { setSignCancelError(null); setCancelSigningOpen(true); }}
                  >
                    <XCircle className="mr-1.5 h-3.5 w-3.5" />
                    Cancel e-Signing Request
                  </Button>
                )}

                {/* Re-initiate option if expired/cancelled */}
                {(contract.leegality_status === "EXPIRED" || contract.leegality_status === "CANCELLED") && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="w-full"
                    onClick={handleInitiateSigning}
                    disabled={initiatingSigning || !leegalityEnabled}
                    title={leegalityEnabled ? undefined : "E-signing is turned off — see Settings → E-Signing."}
                  >
                    {initiatingSigning ? (
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

          {/* Timeline Card */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Timeline</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Created</span>
                <span>{formatDate(contract.created_at)}</span>
              </div>
              {contract.sent_at && (
                <>
                  <Separator />
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Sent</span>
                    <span>{formatDate(contract.sent_at)}</span>
                  </div>
                </>
              )}
              {contract.signed_at && (
                <>
                  <Separator />
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">e-Signed</span>
                    <span>{formatDate(contract.signed_at)}</span>
                  </div>
                </>
              )}
              {contract.viewed_at && (
                <>
                  <Separator />
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Viewed</span>
                    <span>{formatDate(contract.viewed_at)}</span>
                  </div>
                </>
              )}
              {contract.accepted_at && (
                <>
                  <Separator />
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Accepted</span>
                    <span>{formatDate(contract.accepted_at)}</span>
                  </div>
                </>
              )}
              {contract.rejected_at && (
                <>
                  <Separator />
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Rejected</span>
                    <span>{formatDate(contract.rejected_at)}</span>
                  </div>
                </>
              )}
              {contract.activated_at && (
                <>
                  <Separator />
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Activated</span>
                    <span>{formatDate(contract.activated_at)}</span>
                  </div>
                </>
              )}
              {contract.renewed_at && (
                <>
                  <Separator />
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Renewed</span>
                    <span>{formatDate(contract.renewed_at)}</span>
                  </div>
                </>
              )}
              {contract.terminated_at && (
                <>
                  <Separator />
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Terminated</span>
                    <span>{formatDate(contract.terminated_at)}</span>
                  </div>
                </>
              )}
              {contract.termination_reason && (
                <>
                  <Separator />
                  <div>
                    <span className="text-muted-foreground block mb-1">Termination Reason</span>
                    <span>{contract.termination_reason}</span>
                  </div>
                </>
              )}
              <Separator />
              <div className="flex justify-between">
                <span className="text-muted-foreground">Last Updated</span>
                <span>{formatDate(contract.updated_at)}</span>
              </div>
            </CardContent>
          </Card>

          {/* Assigned Spaces — with unit picker and seat validation */}
          <ContractSpaceManager
            contractId={id}
            locationId={contract.location_id ?? null}
            contractSeats={contract.seats ?? 1}
            contractStatus={contract.status}
            contractStartDate={contract.start_date}
            contractEndDate={contract.end_date}
            onAllocationsChange={handleSpaceAllocationsChange}
          />

          {/* Seat-level occupant tracking */}
          {contract?.location_id && spaceAllocations.length > 0 && (
            <Card>
              <CardContent className="pt-4">
                <SeatOccupantsPanel
                  contractId={id}
                  locationId={contract.location_id}
                  allocations={spaceAllocations}
                />
              </CardContent>
            </Card>
          )}

        </div>
      </div>

      {/* Hidden persistent file input for signed contract upload/replace — avoids detached-input accumulation bug */}
      <input
        ref={signedDocInputRef}
        type="file"
        accept=".pdf,.jpg,.jpeg,.png"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) handleSignedDocUpload(file);
          e.target.value = "";
        }}
      />

      {/* Deferred-KYC Activation Confirmation */}
      <Dialog open={deferredActivateOpen} onOpenChange={setDeferredActivateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-amber-600" />
              Activate with Deferred KYC Documents
            </DialogTitle>
            <DialogDescription>
              {kycStatus.deferred} KYC document{kycStatus.deferred > 1 ? "s are" : " is"} deferred.
              The account will not be fully KYC-compliant until{" "}
              {kycStatus.deferred > 1 ? "they are" : "it is"} collected.
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-800">
            <p className="font-semibold mb-1">Deferred documents must still be collected.</p>
            <p className="text-xs">
              Activating this contract does not waive the deferred requirements. They will remain
              visible across all lead interactions until fulfilled.
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeferredActivateOpen(false)}>
              Cancel
            </Button>
            <Button
              className="bg-amber-600 hover:bg-amber-700 text-white"
              disabled={statusUpdating}
              onClick={() => { setDeferredActivateOpen(false); attemptActivation(); }}
            >
              {statusUpdating && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Activate Anyway
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Space Under-Allocation Warning Dialog */}
      <Dialog open={spaceWarningOpen} onOpenChange={setSpaceWarningOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-amber-600" />
              Space Allocation Warning
            </DialogTitle>
            <DialogDescription>
              The allocated space is smaller than the contract commitment.
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-800">
            {(() => {
              const v = validateSpaceAllocation(spaceAllocations, contract?.seats ?? 1);
              return (
                <>
                  <p className="font-semibold mb-1">
                    {v.allocatedSeats} seat{v.allocatedSeats !== 1 ? "s" : ""} allocated vs{" "}
                    {v.contractSeats} seat{v.contractSeats !== 1 ? "s" : ""} committed
                  </p>
                  <p className="text-xs">
                    You are {v.shortfall} seat{v.shortfall !== 1 ? "s" : ""} short.
                    You can still activate, but the space may not accommodate all committed seats.
                  </p>
                </>
              );
            })()}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSpaceWarningOpen(false)}>
              Go Back
            </Button>
            <Button
              className="bg-amber-600 hover:bg-amber-700 text-white"
              disabled={statusUpdating}
              onClick={confirmActivationWithSpaceWarning}
            >
              {statusUpdating && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Activate Anyway
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Terminate Dialog */}
      <Dialog open={terminateOpen} onOpenChange={setTerminateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Terminate Contract</DialogTitle>
            <DialogDescription>
              Are you sure you want to terminate contract {contract.contract_number}?
              This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="termination-reason">
              Termination Reason <span className="text-destructive">*</span>
            </Label>
            <Textarea
              id="termination-reason"
              value={terminationReason}
              onChange={(e) => setTerminationReason(e.target.value)}
              placeholder="Please provide a reason for termination..."
              rows={3}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setTerminateOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleTerminate}
              disabled={terminating}
            >
              {terminating ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Terminating...
                </>
              ) : (
                "Terminate"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={stampConfirmOpen} onOpenChange={(open) => { if (!open) closeStampPreview(); }}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>
              {stampMode === "existing"
                ? "Preview: stamp uploaded document"
                : "Preview: stamp with company seal"}
            </DialogTitle>
            <DialogDescription>
              {stampMode === "existing" ? (
                <>
                  Click the page below where TWV&apos;s signature and seal should go on the
                  document already uploaded for {contract.contract_number} — the
                  customer&apos;s original signature is preserved, ref {stampPreviewRef}. This
                  does not go through Leegality. You can cancel it afterward from
                  &quot;Cancel sign &amp; seal&quot; if needed.
                </>
              ) : (
                <>
                  This is exactly what will be saved as the signed contract for{" "}
                  {contract.contract_number} — TWV&apos;s signature and seal applied, ref{" "}
                  {stampPreviewRef}. Review it before confirming. This does not go through
                  Leegality. You can cancel it afterward from &quot;Cancel sign &amp; seal&quot;
                  if needed.
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          {stampMode === "existing" && stampExistingPageCount > 0 && (
            <div className="rounded-md border bg-amber-50 border-amber-200 p-4 space-y-3">
              <div className="flex items-center gap-3 flex-wrap">
                <span className="text-sm text-amber-900">Page</span>
                <Button
                  type="button"
                  size="icon"
                  variant="outline"
                  className="h-7 w-7"
                  disabled={stampExistingRendering || stampExistingPageImageLoading || stampExistingTargetPage <= 1}
                  onClick={() => handleStampExistingPageChange(stampExistingTargetPage - 1)}
                >
                  <Minus className="h-3.5 w-3.5" />
                </Button>
                <Input
                  type="number"
                  min={1}
                  max={stampExistingPageCount}
                  value={stampExistingTargetPage}
                  onChange={(e) => {
                    const n = parseInt(e.target.value, 10);
                    if (!isNaN(n)) handleStampExistingPageChange(n);
                  }}
                  disabled={stampExistingRendering || stampExistingPageImageLoading}
                  className="h-7 w-14 text-center px-1"
                />
                <Button
                  type="button"
                  size="icon"
                  variant="outline"
                  className="h-7 w-7"
                  disabled={
                    stampExistingRendering ||
                    stampExistingPageImageLoading ||
                    stampExistingTargetPage >= stampExistingPageCount
                  }
                  onClick={() => handleStampExistingPageChange(stampExistingTargetPage + 1)}
                >
                  <Plus className="h-3.5 w-3.5" />
                </Button>
                <span className="text-sm text-amber-900">of {stampExistingPageCount}</span>
                {(stampExistingRendering || stampExistingPageImageLoading) && (
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-amber-900" />
                )}
                {stampExistingOriginalUrl && (
                  <Button asChild variant="outline" size="sm" className="ml-auto">
                    <a href={stampExistingOriginalUrl} target="_blank" rel="noopener noreferrer">
                      <Eye className="mr-1.5 h-3.5 w-3.5" />
                      Open original full PDF
                    </a>
                  </Button>
                )}
              </div>
              {stampExistingPageImageUrl && (
                <div className="relative inline-block max-w-full rounded border bg-white">
                  {/* eslint-disable-next-line @next/next/no-img-element -- data: URL raster of an uploaded PDF page, not an optimizable asset */}
                  <img
                    src={stampExistingPageImageUrl}
                    alt={`Page ${stampExistingTargetPage} of the uploaded document`}
                    className="w-full h-auto rounded cursor-crosshair select-none"
                    onClick={handleStampExistingImageClick}
                  />
                  {stampExistingClickRatio && (
                    <div
                      className="absolute w-4 h-4 rounded-full border-2 border-red-500 bg-red-500/30 pointer-events-none"
                      style={{
                        left: `${stampExistingClickRatio.x * 100}%`,
                        top: `${stampExistingClickRatio.y * 100}%`,
                        transform: "translate(-50%, -50%)",
                      }}
                    />
                  )}
                </div>
              )}
              <p className="text-sm text-amber-900">
                {stampExistingClickRatio
                  ? "Click again anywhere to move the stamp — the marker shows its current spot."
                  : "Click on the page above where the stamp should go."}
              </p>
            </div>
          )}
          {stampPreviewUrl && (
            <div className="rounded-md border bg-muted/30 p-4 flex items-center justify-between gap-3">
              <p className="text-sm text-muted-foreground">
                Review the exact PDF before confirming.
              </p>
              <Button asChild variant="outline" size="sm" className="shrink-0">
                <a href={stampPreviewUrl} target="_blank" rel="noopener noreferrer">
                  <Eye className="mr-1.5 h-3.5 w-3.5" />
                  Open preview PDF
                </a>
              </Button>
            </div>
          )}
          {stampError && (
            <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
              {stampError}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={closeStampPreview}>
              Cancel
            </Button>
            <Button
              onClick={handleStampSignSeal}
              disabled={stampingSignSeal || (stampMode === "existing" && !stampPreviewPdfBase64)}
            >
              {stampingSignSeal ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Stamping...
                </>
              ) : (
                "Confirm & save"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={cancelStampOpen} onOpenChange={(open) => { setCancelStampOpen(open); if (!open) setStampError(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Cancel sign & seal?</DialogTitle>
            <DialogDescription>
              This removes the stamped signed document from {contract.contract_number} and
              restores the plain agreement — Download PDF, Send Agreement, and Email become
              available again. You can re-stamp it afterward if needed.
            </DialogDescription>
          </DialogHeader>
          {stampError && (
            <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
              {stampError}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => { setCancelStampOpen(false); setStampError(null); }}>
              Keep it
            </Button>
            <Button variant="destructive" onClick={handleCancelStamp} disabled={cancellingStamp}>
              {cancellingStamp ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Cancelling...
                </>
              ) : (
                "Cancel sign & seal"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={cancelSigningOpen} onOpenChange={(open) => { setCancelSigningOpen(open); if (!open) setSignCancelError(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Cancel e-signing request?</DialogTitle>
            <DialogDescription>
              This withdraws the request from Leegality for {contract.contract_number} —
              the customer&apos;s signing link (already emailed to them) stops working
              immediately, and any signature collected so far is discarded. Use company
              stamp or upload a manually signed document to proceed afterward.
            </DialogDescription>
          </DialogHeader>
          {signCancelError && (
            <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
              {signCancelError}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => { setCancelSigningOpen(false); setSignCancelError(null); }}>
              Keep it
            </Button>
            <Button variant="destructive" onClick={handleCancelSigning} disabled={cancellingSigning}>
              {cancellingSigning ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Cancelling...
                </>
              ) : (
                "Cancel e-signing request"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={signatureStartDateDialogOpen} onOpenChange={setSignatureStartDateDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Enter the start date for this copy</DialogTitle>
            <DialogDescription>
              {contract.contract_number}&apos;s start date isn&apos;t confirmed yet — it can
              still change until the pro-rata invoice is paid. This doesn&apos;t set the
              contract&apos;s actual start date; it only decides what&apos;s printed on this
              one watermark-free copy, for sending out for physical signature. If the real
              date later differs from what you enter here, you&apos;ll see a warning on this
              page so you know to send an updated copy.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1">
            <Label className="text-xs" htmlFor="signature-start-date">Start date to print</Label>
            <Input
              id="signature-start-date"
              type="date"
              value={signatureStartDateInput}
              onChange={(e) => setSignatureStartDateInput(e.target.value)}
              className="h-9"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSignatureStartDateDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleDownloadForSignature}
              disabled={downloadingForSignature || !signatureStartDateInput}
            >
              {downloadingForSignature ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Downloading...
                </>
              ) : (
                "Download clean copy"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Email Dialog */}
      <EmailDocumentDialog
        open={emailDialogOpen}
        onOpenChange={setEmailDialogOpen}
        documentType="contract"
        documentId={id}
        documentNumber={contract.contract_number}
        leadEmail={contract.lead?.email}
        contractIsRenewal={!!(contract.is_renewal && contract.parent_contract_id)}
        onGeneratePDF={handleGeneratePDFForEmail}
        onSuccess={fetchContract}
      />

      {/* Renewal Dialog */}
      <ContractRenewalDialog
        open={renewDialogOpen}
        onOpenChange={setRenewDialogOpen}
        contract={contract}
        userRole={userRole}
        onSuccess={() => fetchContract(false)}
      />

      {/* Extend Dialog */}
      <ContractExtendDialog
        open={extendDialogOpen}
        onOpenChange={setExtendDialogOpen}
        contract={contract}
        onSuccess={() => fetchContract(false)}
      />

      {/* Decline Renewal Dialog */}
      <DeclineRenewalDialog
        open={declineDialogOpen}
        onOpenChange={setDeclineDialogOpen}
        contract={contract}
        onSuccess={() => fetchContract(false)}
      />

      {/* Cancel Renewal Dialog */}
      <CancelRenewalDialog
        open={cancelRenewalDialogOpen}
        onOpenChange={setCancelRenewalDialogOpen}
        contract={contract}
        renewalDraft={renewalDraft}
        onSuccess={() => fetchContract(false)}
      />

      {/* Edit Renewal Terms Dialog */}
      <ContractRenewalEditDialog
        open={editTermsDialogOpen}
        onOpenChange={setEditTermsDialogOpen}
        contract={contract}
        onSuccess={() => fetchContract(false)}
      />
    </div>
  );
}
