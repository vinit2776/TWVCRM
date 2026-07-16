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
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
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
import { ContractInvoicesSection } from "@/components/contracts/contract-invoices-section";
import { ContractAccessLogsSection } from "@/components/contracts/contract-access-logs-section";
import { ContractBookingsSection } from "@/components/contracts/contract-bookings-section";
import { ContractServiceUsageSection } from "@/components/contracts/contract-service-usage-section";
import { EmailDocumentDialog } from "@/components/shared/email-document-dialog";
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
} from "@/lib/constants";
import { formatDate, formatCurrency } from "@/lib/utils";
import { ContractLifecycle } from "@/components/contracts/contract-lifecycle";
import {
  ContractRenewalDialog,
  DeclineRenewalDialog,
  EscalationWaiverSection,
} from "@/components/contracts/contract-renewal-dialog";
import { ContractRenewalEditDialog } from "@/components/contracts/contract-renewal-edit-dialog";
import { ContractContactsPanel } from "@/components/contracts/contract-contacts-panel";
import { ContractSpaceManager, validateSpaceAllocation } from "@/components/contracts/contract-space-manager";
import { toast } from "sonner";
// lucide-react icons imported above via main import block
import { prepareUpload, UploadTooLargeError } from "@/lib/uploads/upload-gate";
import { SeatOccupantsPanel } from "@/components/spaces/seat-occupants-panel";
import { ContractChainStrip } from "@/components/contracts/contract-chain-strip";
import { ContractProrataSection } from "@/components/contracts/contract-prorata-section";
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
  const [statusUpdating, setStatusUpdating] = useState(false);
  const [terminateOpen, setTerminateOpen] = useState(false);
  const [terminating, setTerminating] = useState(false);
  const [terminationReason, setTerminationReason] = useState("");
  const [uploadingSignedDoc, setUploadingSignedDoc] = useState(false);
  const [emailDialogOpen, setEmailDialogOpen] = useState(false);
  const [initiatingSigning, setInitiatingSigning] = useState(false);
  const [checkingSigningStatus, setCheckingSigningStatus] = useState(false);
  const [copiedLessor, setCopiedLessor] = useState(false);
  const [copiedLessee, setCopiedLessee] = useState(false);
  const [renewDialogOpen, setRenewDialogOpen] = useState(false);
  const [declineDialogOpen, setDeclineDialogOpen] = useState(false);
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [linkedProposal, setLinkedProposal] = useState<any>(null);
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

      const [proposalResult, renewalResult] = await Promise.allSettled([
        proposalId
          ? fetch(`/api/proposals/${proposalId}`).then(r => r.json())
          : Promise.resolve(null),
        hasRenewalDraft
          ? fetch(`/api/contracts?parent_contract_id=${id}&is_renewal=true&limit=1`).then(r => r.json())
          : Promise.resolve(null),
      ]);

      if (proposalId) {
        setLinkedProposal(
          proposalResult.status === "fulfilled" ? (proposalResult.value?.data || null) : null
        );
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

  const handleDownloadPDF = async () => {
    if (!contract) return;
    const { generateMembershipAgreementPDF } = await import("@/lib/pdf-generator");
    const doc = generateMembershipAgreementPDF(
      contract,
      contract.lead || undefined,
      contract.location || undefined
    );
    doc.save(`${contract.contract_number}.pdf`);
  };

  const handleGeneratePDFBase64 = async (): Promise<string> => {
    if (!contract) return "";
    const { generateMembershipAgreementPDF } = await import("@/lib/pdf-generator");
    const doc = generateMembershipAgreementPDF(
      contract,
      contract.lead || undefined,
      contract.location || undefined
    );
    const arrayBuffer = doc.output("arraybuffer");
    const bytes = new Uint8Array(arrayBuffer);
    let binary = "";
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  };

  const handleOpenEmailDialog = () => {
    if (contract?.is_renewal && contract?.parent_contract_id) {
      const confirmed = window.confirm(
        "This is a renewal contract — both the Membership Agreement and the Addendum will be sent to the customer. Continue?"
      );
      if (!confirmed) return;
    }
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

  const securityDeposit = (contract.security_deposit_months ?? 3) * (contract.subtotal ?? contract.total_amount);

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
            </div>
            <p className="text-sm text-muted-foreground">
              {contract.title}
              {contract.location && (
                <span className="ml-2 inline-flex items-center gap-1 text-xs bg-muted px-1.5 py-0.5 rounded">{contract.location.name}</span>
              )}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {/* Status-based action buttons */}
          {/* Send for e-Signing — available on any pre-terminal status while signing hasn't started */}
          {!contract.leegality_document_id &&
            !["rejected", "terminated", "completed"].includes(contract.status) && (
              <Button onClick={handleInitiateSigning} disabled={initiatingSigning}>
                {initiatingSigning ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <PenLine className="mr-2 h-4 w-4" />
                )}
                Send for e-Signing
              </Button>
            )}

          {contract.status === "draft" && (
            <Button variant="outline" onClick={handleOpenEmailDialog} disabled={statusUpdating}>
              <Send className="mr-2 h-4 w-4" />
              Send Agreement
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
            const proposalPaid = !linkedProposal || linkedProposal.payment_status === "paid";
            const depositRequired = linkedProposal ? Number(linkedProposal.security_deposit_months || 0) > 0 : false;
            const depositPaid = !linkedProposal || !depositRequired || linkedProposal.deposit_payment_status === "paid";
            const kycComplete = kycStatus.total === 0 || kycStatus.allSatisfied;
            const prorataRequired = !!(contract.is_renewal && contract.prorata_payment_status === "pending");
            const canActivate = proposalPaid && depositPaid && kycComplete && !prorataRequired;
            const hasDeferred = kycStatus.deferred > 0;

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
                    {!proposalPaid && <p>• Proposal payment collected</p>}
                    {!depositPaid && <p>• Security deposit collected</p>}
                    {prorataRequired && <p>• Pro-rata payment (partial first month) — send PI from the Pro-Rata section below</p>}
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
          {/* Email button for sent/viewed/accepted/rejected */}
          {["sent", "viewed", "accepted", "rejected"].includes(contract.status) && (
            <Button variant="outline" onClick={() => setEmailDialogOpen(true)}>
              <Mail className="mr-2 h-4 w-4" />
              Email
            </Button>
          )}
          <Button variant="outline" onClick={handleDownloadPDF}>
            <Download className="mr-2 h-4 w-4" />
            Download PDF
          </Button>
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
                <Badge variant="secondary" className="bg-green-100 text-green-700 text-[10px] shrink-0">
                  Deposit carried over
                </Badge>
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
                {contract.proposal && (
                  <div>
                    <p className="text-muted-foreground text-xs">Proposal</p>
                    <p className="font-mono text-xs">{contract.proposal.proposal_number}</p>
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
                  <p className="font-medium">{(contract.security_deposit_months ?? 3) === 0 ? "Waived" : formatCurrency(securityDeposit)}</p>
                  {contract.deposit_carried_from && (
                    <p className="text-[10px] text-green-600 mt-0.5">✓ Carried from parent</p>
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
            canEdit={
              ["admin", "manager", "sales_rep"].includes(userRole ?? "") &&
              !(CONTRACT_QUOTA_LOCKED_STATUSES as readonly string[]).includes(contract.status)
            }
            onPhasesUpdated={() => fetchContract(false)}
          />

          {/* Security Deposit Snapshot */}
          {linkedProposal && (
            <ContractDepositSection
              proposal={linkedProposal}
              depositCarriedFrom={contract.deposit_carried_from}
            />
          )}

          {/* Monthly Invoices (proforma + GST invoice) + billing mode toggle */}
          <ContractInvoicesSection
            contractId={id}
            billingMode={contract.billing_mode}
            contractStatus={contract.status}
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
               Terminated/Expired/Rejected: hidden (no edits needed). */}
          {contract.status !== "terminated" && contract.status !== "expired" && contract.status !== "rejected" && (() => {
            const isLocked = (CONTRACT_QUOTA_LOCKED_STATUSES as readonly string[]).includes(contract.status);
            const hasQuotaRole = (CONTRACT_QUOTA_ROLES as readonly string[]).includes(userRole || "");
            const canEdit = hasQuotaRole && (["admin", "manager"].includes(userRole || "") || !isLocked);
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
                    <span className="text-xs text-green-700">Carried from parent</span>
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

                {/* Action buttons — only for active/expired, not already renewed or declined */}
                {/* Role gate: admin, manager, sales_rep can renew/decline */}
                {["active", "expired"].includes(contract.status) && !contract.renewal_declined && ["admin", "manager", "sales_rep"].includes(userRole || "") && (
                  <div className="flex gap-2 pt-1">
                    <Button
                      size="sm"
                      className="flex-1"
                      onClick={() => setRenewDialogOpen(true)}
                    >
                      <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                      Renew
                    </Button>
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
              <div className="flex justify-between">
                <span className="text-muted-foreground">Start Date</span>
                <span>{formatDate(contract.start_date)}</span>
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

                {/* Re-initiate option if expired/cancelled */}
                {(contract.leegality_status === "EXPIRED" || contract.leegality_status === "CANCELLED") && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="w-full"
                    onClick={handleInitiateSigning}
                    disabled={initiatingSigning}
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

      {/* Email Dialog */}
      <EmailDocumentDialog
        open={emailDialogOpen}
        onOpenChange={setEmailDialogOpen}
        documentType="contract"
        documentId={id}
        documentNumber={contract.contract_number}
        leadEmail={contract.lead?.email}
        onGeneratePDF={handleGeneratePDFBase64}
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

      {/* Decline Renewal Dialog */}
      <DeclineRenewalDialog
        open={declineDialogOpen}
        onOpenChange={setDeclineDialogOpen}
        contract={contract}
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
