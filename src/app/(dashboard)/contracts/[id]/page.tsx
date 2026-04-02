"use client";

import { use, useState, useEffect, useCallback } from "react";
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
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/shared/loading-skeleton";
import { ContractVouchersSection } from "@/components/contracts/contract-vouchers-section";
import { ContractBillingSection } from "@/components/accounting/contract-billing-section";
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
  BILLING_CYCLE_LABELS,
  KYC_DOCUMENTS,
  ENTITY_TYPE_LABELS,
} from "@/lib/constants";
import { formatDate, formatCurrency } from "@/lib/utils";
import { generateMembershipAgreementPDF } from "@/lib/pdf-generator";
import { toast } from "sonner";
import type { Contract } from "@/types";

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

  const copyToClipboard = (text: string, who: "lessor" | "lessee") => {
    navigator.clipboard.writeText(text);
    if (who === "lessor") { setCopiedLessor(true); setTimeout(() => setCopiedLessor(false), 2000); }
    else { setCopiedLessee(true); setTimeout(() => setCopiedLessee(false), 2000); }
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [linkedProposal, setLinkedProposal] = useState<any>(null);
  const [userRole, setUserRole] = useState<string | null>(null);
  const [overrideReason, setOverrideReason] = useState("");
  const [showOverride, setShowOverride] = useState(false);

  const fetchContract = useCallback(async () => {
    setLoading(true);
    const res = await fetch(`/api/contracts/${id}`);
    if (res.ok) {
      const json = await res.json();
      setContract(json.data || null);

      // Fetch linked proposal for payment gate check
      const proposalId = json.data?.proposal_id;
      if (proposalId) {
        fetch(`/api/proposals/${proposalId}`)
          .then(r => r.json())
          .then(pJson => setLinkedProposal(pJson.data || null))
          .catch(() => setLinkedProposal(null));
      }
    }
    setLoading(false);
  }, [id]);

  useEffect(() => {
    fetchContract();
    fetch("/api/me").then(r => r.json()).then(j => setUserRole(j.role || null)).catch(() => {});
  }, [fetchContract]);

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
      fetchContract();
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
      fetchContract();
    } else {
      const err = await res.json().catch(() => null);
      toast.error(err?.error || "Failed to terminate contract");
    }
    setTerminating(false);
  };

  const handleDownloadPDF = () => {
    if (!contract) return;
    const doc = generateMembershipAgreementPDF(
      contract,
      contract.lead || undefined,
      contract.location || undefined
    );
    doc.save(`${contract.contract_number}.pdf`);
  };

  const handleGeneratePDFBase64 = (): string => {
    if (!contract) return "";
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

  const handleSignedDocUpload = async (file: File) => {
    if (!contract) return;
    setUploadingSignedDoc(true);

    const formData = new FormData();
    formData.append("file", file);
    formData.append("title", `Signed Contract - ${contract.contract_number}`);
    formData.append("category", "signed_contract");
    formData.append("lead_id", contract.lead_id);

    const uploadRes = await fetch("/api/documents", {
      method: "POST",
      body: formData,
    });

    if (!uploadRes.ok) {
      const err = await uploadRes.json().catch(() => null);
      toast.error(err?.error || "Failed to upload document");
      setUploadingSignedDoc(false);
      return;
    }

    const { data: doc } = await uploadRes.json();

    const patchRes = await fetch(`/api/contracts/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ signed_document_id: doc.id }),
    });

    if (patchRes.ok) {
      toast.success("Signed contract uploaded successfully");
      fetchContract();
    } else {
      const err = await patchRes.json().catch(() => null);
      toast.error(err?.error || "Failed to link document to contract");
    }

    setUploadingSignedDoc(false);
  };

  const handleViewSignedDoc = async () => {
    if (!contract?.signed_document?.file_path) return;
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (supabaseUrl && supabaseKey) {
      const res = await fetch(
        `${supabaseUrl}/storage/v1/object/sign/crm-documents/${contract.signed_document.file_path}`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${supabaseKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ expiresIn: 3600 }),
        }
      );
      if (res.ok) {
        const { signedURL } = await res.json();
        window.open(`${supabaseUrl}/storage/v1${signedURL}`, "_blank");
        return;
      }
    }
    toast.error("Failed to get download URL");
  };

  const handleInitiateSigning = async () => {
    if (!contract) return;
    setInitiatingSigning(true);

    // Generate PDF client-side (jsPDF is browser-only)
    const pdfBase64 = handleGeneratePDFBase64();
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
      fetchContract();
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
      fetchContract();
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

  const securityDeposit = (contract.security_deposit_months || 3) * contract.total_amount;

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
            <Button variant="outline" onClick={() => setEmailDialogOpen(true)} disabled={statusUpdating}>
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
            const depositPaid = !linkedProposal || linkedProposal.deposit_payment_status !== "pending";
            const canActivate = proposalPaid && depositPaid;

            return canActivate ? (
              <Button variant="outline" onClick={() => handleStatusUpdate("active")} disabled={statusUpdating}>
                {statusUpdating ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <CheckCircle2 className="mr-2 h-4 w-4" />}
                Activate
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
                          onClick={() => handleStatusUpdate("active", overrideReason.trim())}
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
          {contract.status === "active" && (
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
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Main Content */}
        <div className="lg:col-span-2 space-y-6">
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
                  <p className="font-bold text-lg">{formatCurrency(contract.total_amount)}</p>
                </div>
                <div>
                  <p className="text-muted-foreground text-xs">Tax ({contract.tax_percentage}%)</p>
                  <p className="font-medium">{formatCurrency(contract.tax_amount)}</p>
                </div>
                <div>
                  <p className="text-muted-foreground text-xs">Security Deposit</p>
                  <p className="font-medium">{formatCurrency(securityDeposit)}</p>
                </div>
                <div>
                  <p className="text-muted-foreground text-xs">Seats</p>
                  <p className="font-medium">{contract.seats}</p>
                </div>
              </div>
            </CardContent>
          </Card>

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
                  <p>{contract.security_deposit_months || 3}x Monthly Fee = {formatCurrency(securityDeposit)}</p>
                </div>
                <div>
                  <p className="text-muted-foreground text-xs">Annual Escalation</p>
                  <p>{contract.escalation_percentage || 10}%</p>
                </div>
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

          {/* KYC Documents Status */}
          {contract.lead?.entity_type && KYC_DOCUMENTS[contract.lead.entity_type] && (
            <Card className="border-amber-200">
              <CardHeader className="pb-2">
                <CardTitle className="text-base flex items-center gap-2">
                  <AlertTriangle className="h-4 w-4 text-amber-600" />
                  KYC Documents — {ENTITY_TYPE_LABELS[contract.lead.entity_type] || contract.lead.entity_type}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-xs text-muted-foreground mb-3">
                  Documents required for contract activation and compliance. Missing documents will be flagged until completed.
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {KYC_DOCUMENTS[contract.lead.entity_type].map((doc) => (
                    <div
                      key={doc}
                      className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm bg-amber-50 border-amber-200"
                    >
                      <AlertTriangle className="h-3.5 w-3.5 text-amber-500 shrink-0" />
                      <span className="text-amber-800">{doc}</span>
                      <Badge variant="outline" className="ml-auto text-[10px] border-amber-400 text-amber-700">
                        Pending
                      </Badge>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

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
            printerDepartmentId={contract.printer_department_id}
            onDepartmentIdUpdate={fetchContract}
          />

          {/* Billing Section */}
          {["active", "completed"].includes(contract.status) && (
            <ContractBillingSection contractId={id} />
          )}

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
                      onClick={() => {
                        const input = document.createElement("input");
                        input.type = "file";
                        input.accept = ".pdf,.jpg,.jpeg,.png";
                        input.onchange = (e) => {
                          const file = (e.target as HTMLInputElement).files?.[0];
                          if (file) handleSignedDocUpload(file);
                        };
                        input.click();
                      }}
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
                    if (uploadingSignedDoc) return;
                    const input = document.createElement("input");
                    input.type = "file";
                    input.accept = ".pdf,.jpg,.jpeg,.png";
                    input.onchange = (e) => {
                      const file = (e.target as HTMLInputElement).files?.[0];
                      if (file) handleSignedDocUpload(file);
                    };
                    input.click();
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
        </div>
      </div>

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
    </div>
  );
}
