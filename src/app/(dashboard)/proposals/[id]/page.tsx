"use client";

import { use, useState, useEffect, useCallback, useRef } from "react";
import { useCurrentUser } from "@/providers/current-user-provider";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  ArrowLeft,
  Download,
  Send,
  Eye,
  CheckCircle2,
  XCircle,
  Mail,
  AlertTriangle,
  Banknote,
  Upload,
  X,
  Loader2,
  ChevronDown,
  FileText,
  ShieldCheck,
  ReceiptText,
  ScrollText,
  Pencil,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/shared/loading-skeleton";
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  PROPOSAL_STATUS_LABELS,
  PROPOSAL_STATUS_COLORS,
  KYC_DOCUMENTS,
  ENTITY_TYPE_LABELS,
} from "@/lib/constants";
import { formatDate, formatCurrency } from "@/lib/utils";
import { EmailDocumentDialog } from "@/components/shared/email-document-dialog";
import { ProposalLifecycle } from "@/components/proposals/proposal-lifecycle";
import { BookingConfirmationDialog } from "@/components/proposals/booking-confirmation-dialog";
import { DepositWaiverGate } from "@/components/proposals/deposit-waiver-gate";
import dynamic from "next/dynamic";

const CreateContractDialog = dynamic(
  () => import("@/components/contracts/create-contract-dialog").then(m => ({ default: m.CreateContractDialog })),
  { ssr: false }
);
import { toast } from "sonner";
import type { Proposal, Lead } from "@/types";

export default function ProposalDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();
  const [proposal, setProposal] = useState<Proposal & { lead?: Lead } | null>(null);
  const [loading, setLoading] = useState(true);

  // Current user (rep) profile for PDF/email attribution
  const { user: currentUser } = useCurrentUser();

  // Service quotas for PDF rendering
  const [serviceQuotas, setServiceQuotas] = useState<{ name: string; unit_label: string; monthly_quota: number; overage_rate: number }[]>([]);

  // Email dialog state
  const [emailDialogOpen, setEmailDialogOpen] = useState(false);

  // Manual deposit payment dialog state
  const [manualPayDialogOpen, setManualPayDialogOpen] = useState(false);
  const [manualPayAmount, setManualPayAmount] = useState("");
  const [manualPayRef, setManualPayRef] = useState("");
  const [manualPayMedium, setManualPayMedium] = useState("");
  const [manualPayNotes, setManualPayNotes] = useState("");
  const [manualPayFile, setManualPayFile] = useState<File | null>(null);
  const [manualPaySubmitting, setManualPaySubmitting] = useState(false);
  const [manualPayShortfallApproved, setManualPayShortfallApproved] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Apply deposit credit dialog (admin/manager — deposit held from a prior contract)
  const [depositCreditOpen, setDepositCreditOpen] = useState(false);
  const [depositCreditAmount, setDepositCreditAmount] = useState("");
  const [depositCreditReason, setDepositCreditReason] = useState("");
  const [depositCreditProofFile, setDepositCreditProofFile] = useState<File | null>(null);
  const [depositCreditSubmitting, setDepositCreditSubmitting] = useState(false);
  const creditFileInputRef = useRef<HTMLInputElement>(null);

  // Deposit email preview dialog
  const [depositEmailOpen, setDepositEmailOpen] = useState(false);
  const [depositEmailLoading, setDepositEmailLoading] = useState(false);
  const [depositEmailSending, setDepositEmailSending] = useState(false);
  const [depositEmailPreview, setDepositEmailPreview] = useState<{
    subject: string; html: string; to: string[]; deposit_link_url: string | null; amount: number; link_already_exists: boolean;
  } | null>(null);

  // Booking confirmation dialog (accept flow)
  const [bookingConfirmOpen, setBookingConfirmOpen] = useState(false);

  // Create Contract dialog
  const [createContractOpen, setCreateContractOpen] = useState(false);

  // GST invoice preview dialog
  const [gstDialogOpen, setGstDialogOpen] = useState(false);
  const [gstDate, setGstDate] = useState<string>("");
  const [gstPreviewLoading, setGstPreviewLoading] = useState(false);
  const [gstSending, setGstSending] = useState(false);
  const [gstIsRevise, setGstIsRevise] = useState(false);
  const [gstCc, setGstCc] = useState("");
  const [gstPreview, setGstPreview] = useState<{
    subject: string; html: string; to: string[]; invoiceNumber: string | null;
    proratedSubtotal: number; taxAmount: number; totalAmount: number;
    daysRemaining: number; daysInMonth: number; prorationFactor: number;
    periodLabel: string; startLabel: string; endLabel: string;
    razorpayUrl: string | null; previous_occupation_start_date: string | null;
  } | null>(null);

  const fetchProposal = useCallback(async () => {
    setLoading(true);
    const res = await fetch(`/api/proposals/${id}`);
    if (res.ok) {
      const json = await res.json();
      const p = json.data || null;
      setProposal(p);

      // Auto-generate Razorpay payment link if not yet created
      if (p && !p.razorpay_payment_link_url && p.status !== "rejected") {
        fetch(`/api/proposals/${id}/payment-link`, { method: "POST" })
          .then((r) => r.ok ? r.json() : null)
          .then((data) => {
            if (data?.razorpay_payment_link_url) {
              setProposal((prev) => prev ? { ...prev, ...data } : prev);
            }
          })
          .catch(() => {});
      }
    }
    setLoading(false);
  }, [id]);

  useEffect(() => {
    fetchProposal();

    // Fetch service quotas for this proposal to include in PDF
    fetch(`/api/proposals/${id}/service-quotas`)
      .then((r) => r.ok ? r.json() : null)
      .then((data) => {
        if (data?.data) setServiceQuotas(data.data);
      })
      .catch(() => {});
  }, [fetchProposal, id]);

  const handleDownloadPDF = async () => {
    if (!proposal) return;

    const preparedBy = currentUser?.full_name
      ? { name: currentUser.full_name, email: currentUser.email || undefined, phone: currentUser.phone || undefined }
      : undefined;

    // Dynamic import: jsPDF + autotable load only when the user clicks download.
    const { generateProposalPDF } = await import("@/lib/pdf-generator");
    const doc = generateProposalPDF(
      proposal,
      proposal.lead || undefined,
      { razorpayPaymentLink: proposal.razorpay_payment_link_url || undefined },
      preparedBy,
      serviceQuotas
    );
    doc.save(`${proposal.proposal_number}.pdf`);
  };

  const handleEmailProposal = () => {
    setEmailDialogOpen(true);
  };

  const handleUpdateStatus = async (status: string, label: string, rejectionReason?: string) => {
    const now = new Date().toISOString();
    const body: Record<string, unknown> = { status };

    if (status === "sent") body.sent_at = now;
    if (status === "viewed") body.viewed_at = now;
    if (status === "accepted") body.accepted_at = now;
    if (status === "rejected") {
      body.rejected_at = now;
      if (rejectionReason) body.rejection_reason = rejectionReason;
    }

    const res = await fetch(`/api/proposals/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (res.ok) {
      toast.success(`Proposal marked as ${label}`);
      fetchProposal();
    } else {
      const err = await res.json().catch(() => null);
      toast.error(err?.error || "Failed to update proposal status");
    }
  };

  const openManualPayDialog = () => {
    setManualPayAmount(String(proposal?.security_deposit_amount || ""));
    setManualPayRef("");
    setManualPayMedium("");
    setManualPayNotes("");
    setManualPayFile(null);
    setManualPayShortfallApproved(false);
    setManualPayDialogOpen(true);
  };

  const openDepositCreditDialog = () => {
    setDepositCreditAmount(String(proposal?.deposit_credit_amount || ""));
    setDepositCreditReason(proposal?.deposit_credit_reason || "");
    setDepositCreditProofFile(null);
    if (creditFileInputRef.current) creditFileInputRef.current.value = "";
    setDepositCreditOpen(true);
  };

  const submitDepositCredit = async () => {
    const amount = parseFloat(depositCreditAmount);
    if (isNaN(amount) || amount <= 0) {
      toast.error("Enter a valid credit amount");
      return;
    }
    if (!depositCreditReason.trim()) {
      toast.error("A reason is required — this is kept for audit");
      return;
    }
    if (!depositCreditProofFile) {
      toast.error("Proof of the held deposit is required");
      return;
    }
    setDepositCreditSubmitting(true);
    try {
      const formData = new FormData();
      formData.append("amount", String(amount));
      formData.append("reason", depositCreditReason.trim());
      formData.append("proof", depositCreditProofFile);

      const res = await fetch(`/api/proposals/${id}/deposit-credit`, {
        method: "POST",
        body: formData,
      });
      const json = await res.json().catch(() => null);
      if (res.ok) {
        toast.success("Deposit credit applied");
        setDepositCreditOpen(false);
        fetchProposal();
      } else {
        toast.error(json?.error || "Failed to apply deposit credit");
      }
    } catch {
      toast.error("Unexpected error applying deposit credit");
    } finally {
      setDepositCreditSubmitting(false);
    }
  };

  // ── Deposit email preview + send ─────────────────────────────────────────
  const openDepositEmailDialog = async () => {
    setDepositEmailOpen(true);
    setDepositEmailPreview(null);
    setDepositEmailLoading(true);
    try {
      const res = await fetch(`/api/proposals/${id}/deposit-link`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ preview: true }),
      });
      const json = await res.json();
      if (res.ok) {
        setDepositEmailPreview(json);
      } else {
        toast.error(json.error || "Failed to generate preview");
        setDepositEmailOpen(false);
      }
    } catch {
      toast.error("Unexpected error generating preview");
      setDepositEmailOpen(false);
    } finally {
      setDepositEmailLoading(false);
    }
  };

  const handleSendDepositEmail = async () => {
    setDepositEmailSending(true);
    try {
      const res = await fetch(`/api/proposals/${id}/deposit-link`, { method: "POST" });
      const json = await res.json();
      if (res.ok) {
        toast.success(`Deposit email sent to ${json.sent_to || "customer"}`);
        setDepositEmailOpen(false);
        fetchProposal();
      } else {
        toast.error(json.error || "Failed to send deposit email");
      }
    } catch {
      toast.error("Unexpected error sending email");
    } finally {
      setDepositEmailSending(false);
    }
  };

  // ── GST invoice preview + send ──────────────────────────────────────────
  const openGstDialog = (forRevise = false) => {
    const initialDate = forRevise && proposal?.occupation_start_date
      ? proposal.occupation_start_date
      : new Date().toISOString().slice(0, 10);
    setGstDate(initialDate);
    setGstPreview(null);
    setGstIsRevise(forRevise);
    setGstCc((proposal?.lead?.billing_emails || []).join(", "));
    setGstDialogOpen(true);
  };

  const refreshGstPreview = async () => {
    if (!gstDate || !/^\d{4}-\d{2}-\d{2}$/.test(gstDate)) {
      toast.error("Enter a valid date (YYYY-MM-DD)");
      return;
    }
    setGstPreviewLoading(true);
    try {
      const res = await fetch(`/api/proposals/${id}/send-invoice`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ occupation_start_date: gstDate, preview: true }),
      });
      const json = await res.json();
      if (res.ok) {
        setGstPreview(json);
      } else {
        toast.error(json.error || "Failed to generate preview");
      }
    } catch {
      toast.error("Unexpected error generating preview");
    } finally {
      setGstPreviewLoading(false);
    }
  };

  const handleSendGstInvoice = async () => {
    if (!gstDate) { toast.error("Date is required"); return; }
    setGstSending(true);
    try {
      const ccList = Array.from(new Set(
        gstCc.split(",").map((e) => e.trim()).filter(Boolean)
      ));
      const res = await fetch(`/api/proposals/${id}/send-invoice`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ occupation_start_date: gstDate, additionalCc: ccList }),
      });
      const json = await res.json();
      if (res.ok) {
        const verb = json.is_revise ? "resent" : "sent";
        toast.success(
          json.prorationFactor < 1
            ? `GST invoice ${verb} (prorated: ${json.daysRemaining}/${json.daysInMonth} days = ₹${json.totalAmount.toLocaleString("en-IN")})`
            : `GST invoice ${verb}: ₹${json.totalAmount.toLocaleString("en-IN")}`,
          { duration: 8000 }
        );
        setGstDialogOpen(false);

        // Remember the edited CC list against the lead for next time, matching
        // the "ad hoc field pre-filled from a saved list" behaviour.
        const existingCc = proposal?.lead?.billing_emails || [];
        const ccChanged = ccList.length !== existingCc.length || ccList.some((e) => !existingCc.includes(e));
        if (ccChanged && proposal?.lead_id) {
          fetch(`/api/leads/${proposal.lead_id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ billing_emails: ccList }),
          }).catch(() => {});
        }

        fetchProposal();
      } else {
        toast.error(json.error || "Failed to send invoice");
      }
    } catch {
      toast.error("Unexpected error sending invoice");
    } finally {
      setGstSending(false);
    }
  };

  const handleManualPaySubmit = async () => {
    if (!proposal) return;
    const amt = parseFloat(manualPayAmount);
    if (isNaN(amt) || amt <= 0) {
      toast.error("Please enter a valid payment amount");
      return;
    }
    const expectedAmt = Number(proposal.security_deposit_amount || 0);
    if (expectedAmt > 0 && amt < expectedAmt) {
      const shortfallPct = (expectedAmt - amt) / expectedAmt;
      if (shortfallPct > 0.10) {
        toast.error(`Amount is more than 10% below the expected deposit. Minimum acceptable: ₹${Math.ceil(expectedAmt * 0.9).toLocaleString("en-IN")}`);
        return;
      }
      if (!manualPayShortfallApproved) {
        toast.error("Please check the shortfall approval box before submitting.");
        return;
      }
    }
    setManualPaySubmitting(true);
    try {
      const fd = new FormData();
      fd.append("amount", String(amt));
      if (manualPayRef.trim()) fd.append("reference", manualPayRef.trim());
      if (manualPayMedium) fd.append("payment_medium", manualPayMedium);
      if (manualPayNotes.trim()) fd.append("notes", manualPayNotes.trim());
      if (manualPayFile) fd.append("payment_proof", manualPayFile);
      if (manualPayShortfallApproved) fd.append("shortfall_approved", "true");

      const res = await fetch(`/api/proposals/${id}/deposit-payment`, {
        method: "POST",
        body: fd,
      });
      const json = await res.json();
      if (res.ok) {
        toast.success("Deposit payment recorded. Confirmation email sent to customer.");
        setManualPayDialogOpen(false);
        fetchProposal();
      } else {
        toast.error(json.error || "Failed to record payment");
      }
    } catch {
      toast.error("Unexpected error recording payment");
    } finally {
      setManualPaySubmitting(false);
    }
  };

  const isExpired =
    proposal?.valid_until && new Date(proposal.valid_until) < new Date();

  const isZeroDeposit = Number(proposal?.security_deposit_months || 0) === 0;
  const waiverVerified = !!proposal?.deposit_waiver_verified_at;
  const needsWaiver = isZeroDeposit && !waiverVerified;

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

  if (!proposal) {
    return (
      <div className="text-center py-12">
        <h2 className="text-xl font-semibold">Proposal not found</h2>
        <Button
          variant="outline"
          className="mt-4"
          onClick={() => router.push("/proposals")}
        >
          Back to Proposals
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => router.push(proposal?.lead_id ? `/leads/${proposal.lead_id}` : "/proposals")}
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-bold font-mono">
                {proposal.proposal_number}
              </h1>
              <Badge
                variant="secondary"
                className={PROPOSAL_STATUS_COLORS[proposal.status]}
              >
                {PROPOSAL_STATUS_LABELS[proposal.status]}
              </Badge>
              {proposal.payment_status === "paid" && (
                <Badge variant="secondary" className="bg-green-100 text-green-800 border-green-300">
                  Paid
                </Badge>
              )}
              {proposal.payment_status === "pending" && proposal.razorpay_payment_link_url && (
                <Badge variant="secondary" className="bg-amber-100 text-amber-800 border-amber-300 animate-pulse">
                  Awaiting Payment
                </Badge>
              )}
            </div>
            <p className="text-sm text-muted-foreground">
              {proposal.title}
              {proposal.location && (
                <span className="ml-2 inline-flex items-center gap-1 text-xs bg-muted px-1.5 py-0.5 rounded">{proposal.location.name}</span>
              )}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {/* Status transition buttons */}
          {proposal.status === "draft" && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => handleUpdateStatus("sent", "Sent")}
            >
              <Send className="mr-2 h-4 w-4" />
              Mark as Sent
            </Button>
          )}
          {proposal.status === "sent" && (
            <div className="inline-flex items-center gap-1.5 text-xs text-muted-foreground border rounded px-3 py-1.5 bg-muted/30">
              <Eye className="h-3.5 w-3.5" />
              {proposal.viewed_at
                ? <span className="text-green-700 font-medium">Opened {formatDate(proposal.viewed_at)}</span>
                : <span>Waiting for customer to open email link</span>}
            </div>
          )}
          {(proposal.status === "sent" || proposal.status === "viewed") && (
            <>
              <Button
                size="sm"
                className="bg-green-600 hover:bg-green-700 text-white"
                onClick={() => {
                  if (needsWaiver) {
                    toast.error("Admin OTP approval required before accepting. Complete the deposit waiver approval below.");
                    document.getElementById("deposit-waiver-gate")?.scrollIntoView({ behavior: "smooth" });
                    return;
                  }
                  setBookingConfirmOpen(true);
                }}
              >
                <CheckCircle2 className="mr-2 h-4 w-4" />
                Accept
              </Button>
              <Button
                size="sm"
                variant="destructive"
                onClick={() => {
                  const reason = window.prompt("Please enter the reason for rejection:");
                  if (reason === null) return; // cancelled
                  if (!reason.trim()) {
                    toast.error("Rejection reason is required");
                    return;
                  }
                  handleUpdateStatus("rejected", "Rejected", reason.trim());
                }}
              >
                <XCircle className="mr-2 h-4 w-4" />
                Reject
              </Button>
            </>
          )}
          {/* Smart Email dropdown ----------------------------------------- */}
          {(() => {
            const isActive = !["draft", "rejected"].includes(proposal.status);
            const hasDeposit = Number(proposal.security_deposit_months || 0) > 0;
            const depositPaid = proposal.deposit_payment_status === "paid";
            const depositPending = proposal.deposit_payment_status === "pending";
            const monthlyPaid = proposal.payment_status === "paid";
            const invoiceSentAlready = !!proposal.occupation_start_date;

            return (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm">
                    <Mail className="mr-2 h-4 w-4" />
                    Email
                    <ChevronDown className="ml-1 h-3.5 w-3.5 opacity-60" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-64">
                  {/* ── Send Proposal ─────────────────────────────────── */}
                  <DropdownMenuItem
                    onClick={needsWaiver ? undefined : handleEmailProposal}
                    disabled={needsWaiver}
                  >
                    <FileText className="mr-2 h-4 w-4 shrink-0 text-muted-foreground" />
                    <div>
                      <p className="font-medium">Send Proposal</p>
                      <p className="text-xs text-muted-foreground">
                        {needsWaiver ? "Locked — admin OTP approval required" : "Proposal PDF · negotiation phase"}
                      </p>
                    </div>
                  </DropdownMenuItem>

                  {/* Only show payment-specific options once proposal is shared */}
                  {isActive && (hasDeposit || true) && (
                    <>
                      <DropdownMenuSeparator />

                      {/* ── Security Deposit ──────────────────────────── */}
                      {hasDeposit && (
                        depositPaid ? (
                          <DropdownMenuItem disabled className="opacity-50 cursor-default">
                            <ShieldCheck className="mr-2 h-4 w-4 shrink-0 text-green-600" />
                            <div>
                              <p className="font-medium flex items-center gap-1.5">
                                Security Deposit
                                <span className="text-[10px] font-semibold bg-green-100 text-green-700 px-1.5 py-0.5 rounded">PAID</span>
                              </p>
                              <p className="text-xs text-muted-foreground">Deposit received — no email needed</p>
                            </div>
                          </DropdownMenuItem>
                        ) : (
                          <DropdownMenuItem
                            onClick={depositPending ? openDepositEmailDialog : undefined}
                            disabled={!depositPending}
                          >
                            <ShieldCheck className="mr-2 h-4 w-4 shrink-0 text-amber-600" />
                            <div>
                              <p className="font-medium">Security Deposit Request</p>
                              <p className="text-xs text-muted-foreground">
                                ₹{Number(proposal.security_deposit_amount || 0).toLocaleString("en-IN")} · Razorpay link included
                              </p>
                            </div>
                          </DropdownMenuItem>
                        )
                      )}

                      {/* ── GST Invoice ───────────────────────────────── */}
                      {monthlyPaid ? (
                        <DropdownMenuItem disabled className="opacity-50 cursor-default">
                          <ReceiptText className="mr-2 h-4 w-4 shrink-0 text-green-600" />
                          <div>
                            <p className="font-medium flex items-center gap-1.5">
                              GST Invoice
                              <span className="text-[10px] font-semibold bg-green-100 text-green-700 px-1.5 py-0.5 rounded">PAID</span>
                            </p>
                            <p className="text-xs text-muted-foreground">Monthly charge paid — no email needed</p>
                          </div>
                        </DropdownMenuItem>
                      ) : (
                        <DropdownMenuItem
                          onClick={() => openGstDialog(invoiceSentAlready)}
                          disabled={hasDeposit && !depositPaid}
                        >
                          <ReceiptText className="mr-2 h-4 w-4 shrink-0 text-blue-600" />
                          <div>
                            <p className="font-medium">
                              {invoiceSentAlready ? "Revise & Resend GST Invoice" : "GST Invoice — First Month"}
                            </p>
                            <p className="text-xs text-muted-foreground">
                              {hasDeposit && !depositPaid
                                ? "Deposit must be paid first"
                                : `₹${Number(proposal.total_amount).toLocaleString("en-IN")}/month · Prorated · PDF attached`}
                            </p>
                          </div>
                        </DropdownMenuItem>
                      )}
                    </>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            );
          })()}
          <Button
            variant="outline"
            size="sm"
            onClick={needsWaiver ? () => toast.error("Admin OTP approval required before downloading. Complete the deposit waiver approval first.") : handleDownloadPDF}
            disabled={needsWaiver}
            title={needsWaiver ? "Admin OTP approval required" : undefined}
          >
            <Download className="mr-2 h-4 w-4" />
            Download PDF
          </Button>
          {/* Create Contract — visible only when deposit is paid (or no deposit required) */}
          {proposal.status === "accepted" &&
            (proposal.deposit_payment_status === "paid" || Number(proposal.security_deposit_months || 0) === 0) && (
            <Button
              size="sm"
              variant="outline"
              className="border-primary text-primary hover:bg-primary/5"
              onClick={() => setCreateContractOpen(true)}
            >
              <ScrollText className="mr-2 h-4 w-4" />
              Create Contract
            </Button>
          )}
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
                {proposal.lead && (
                  <>
                    <div>
                      <p className="text-muted-foreground text-xs">Lead</p>
                      <Link
                        href={`/leads/${proposal.lead.id}`}
                        className="text-primary hover:underline font-medium"
                      >
                        {proposal.lead.first_name} {proposal.lead.last_name}
                      </Link>
                    </div>
                    {proposal.lead.company && (
                      <div>
                        <p className="text-muted-foreground text-xs">Company</p>
                        <p>{proposal.lead.company}</p>
                      </div>
                    )}
                    {proposal.lead.email && (
                      <div>
                        <p className="text-muted-foreground text-xs">Email</p>
                        <p>{proposal.lead.email}</p>
                      </div>
                    )}
                    {(proposal.lead.phone || proposal.lead.mobile) && (
                      <div>
                        <p className="text-muted-foreground text-xs">Phone</p>
                        <p>{proposal.lead.phone || proposal.lead.mobile}</p>
                      </div>
                    )}
                  </>
                )}
              </div>
              <Separator className="my-4" />
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
                <div>
                  <p className="text-muted-foreground text-xs">Subtotal</p>
                  <p className="font-medium">{formatCurrency(proposal.subtotal)}</p>
                </div>
                <div>
                  <p className="text-muted-foreground text-xs">
                    Tax ({proposal.tax_percentage}%)
                  </p>
                  <p className="font-medium">
                    {formatCurrency(proposal.tax_amount)}
                  </p>
                </div>
                <div>
                  <p className="text-muted-foreground text-xs">
                    Discount ({proposal.discount_percentage}%)
                  </p>
                  <p className="font-medium">
                    -{formatCurrency(proposal.discount_amount)}
                  </p>
                </div>
                <div>
                  <p className="text-muted-foreground text-xs">Total</p>
                  <p className="font-bold text-lg">
                    {formatCurrency(proposal.total_amount)}
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>

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
                      <th className="px-4 py-3 text-left font-medium">
                        Description
                      </th>
                      <th className="px-4 py-3 text-right font-medium">Qty</th>
                      <th className="px-4 py-3 text-right font-medium">Unit</th>
                      <th className="px-4 py-3 text-right font-medium">
                        Unit Price
                      </th>
                      <th className="px-4 py-3 text-right font-medium">
                        Total
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {proposal.items.map((item, idx) => (
                      <tr key={idx} className="border-b">
                        <td className="px-4 py-3">{item.description}</td>
                        <td className="px-4 py-3 text-right">
                          {item.quantity}
                        </td>
                        <td className="px-4 py-3 text-right text-muted-foreground">
                          {item.unit || "—"}
                        </td>
                        <td className="px-4 py-3 text-right">
                          {formatCurrency(item.unit_price)}
                        </td>
                        <td className="px-4 py-3 text-right font-medium">
                          {formatCurrency(item.total)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>

          {/* Complimentary Services Offered (formerly Description) */}
          {proposal.description && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Complimentary Services Offered</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm whitespace-pre-wrap">
                  {proposal.description}
                </p>
              </CardContent>
            </Card>
          )}

          {/* Terms & Conditions */}
          {proposal.terms_and_conditions && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">
                  Terms & Conditions
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm whitespace-pre-wrap">
                  {proposal.terms_and_conditions}
                </p>
              </CardContent>
            </Card>
          )}

          {/* Customer Notes (formerly Notes) */}
          {proposal.notes && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Customer Notes</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm whitespace-pre-wrap">{proposal.notes}</p>
              </CardContent>
            </Card>
          )}

          {/* KYC Documents Required */}
          {proposal.lead?.entity_type && KYC_DOCUMENTS[proposal.lead.entity_type] && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">
                  Documents Required — {ENTITY_TYPE_LABELS[proposal.lead.entity_type] || proposal.lead.entity_type}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <ul className="list-disc list-inside text-sm space-y-1 text-muted-foreground">
                  {KYC_DOCUMENTS[proposal.lead.entity_type].map((doc, idx) => (
                    <li key={idx}>{doc}</li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}
        </div>

        {/* Sidebar */}
        <div className="space-y-4">
          {/* Security Deposit */}
          {Number(proposal.security_deposit_months) > 0 && (
            <Card className={proposal.deposit_payment_status === "paid" ? "border-green-200 bg-green-50" : "border-amber-200 bg-amber-50"}>
              <CardHeader className="pb-2">
                <CardTitle className={`text-base flex items-center gap-2 ${proposal.deposit_payment_status === "paid" ? "text-green-700" : "text-amber-700"}`}>
                  {proposal.deposit_payment_status !== "paid" && (
                    <span className="relative flex h-2.5 w-2.5 shrink-0">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75"></span>
                      <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-amber-500"></span>
                    </span>
                  )}
                  Security Deposit ({proposal.security_deposit_months} month{Number(proposal.security_deposit_months) > 1 ? "s" : ""})
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className={proposal.deposit_payment_status === "paid" ? "text-green-700" : "text-amber-700"}>
                    {Number(proposal.deposit_credit_amount || 0) > 0 ? "Required Deposit (pre-GST)" : "Amount (pre-GST)"}
                  </span>
                  <span className="font-semibold">₹{Number(proposal.security_deposit_amount || 0).toLocaleString("en-IN")}</span>
                </div>

                {Number(proposal.deposit_credit_amount || 0) > 0 && (
                  <>
                    <div className="flex justify-between">
                      <span className={proposal.deposit_payment_status === "paid" ? "text-green-700" : "text-amber-700"}>Credit Applied</span>
                      <span className="font-semibold">− ₹{Number(proposal.deposit_credit_amount).toLocaleString("en-IN")}</span>
                    </div>
                    {proposal.deposit_credit_reason && (
                      <p className="text-xs text-muted-foreground italic">{proposal.deposit_credit_reason}</p>
                    )}
                    {proposal.deposit_credit_proof_url && (
                      <a
                        href={proposal.deposit_credit_proof_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className={`flex items-center gap-1.5 text-xs underline ${proposal.deposit_payment_status === "paid" ? "text-green-700" : "text-amber-700"}`}
                      >
                        <Upload className="h-3 w-3" />
                        View credit proof
                      </a>
                    )}
                    <div className={`flex justify-between pt-1.5 mt-1 border-t ${proposal.deposit_payment_status === "paid" ? "border-green-200" : "border-amber-200"}`}>
                      <span className={`font-medium ${proposal.deposit_payment_status === "paid" ? "text-green-700" : "text-amber-700"}`}>Balance to Collect</span>
                      <span className="font-bold">₹{Math.max(0, Number(proposal.security_deposit_amount || 0) - Number(proposal.deposit_credit_amount || 0)).toLocaleString("en-IN")}</span>
                    </div>
                  </>
                )}

                {proposal.deposit_payment_status === "pending" && ["admin", "manager"].includes(currentUser?.role || "") && (
                  <button
                    type="button"
                    onClick={openDepositCreditDialog}
                    className="text-xs text-amber-700 hover:text-amber-900 underline flex items-center gap-1"
                  >
                    <Pencil className="h-3 w-3" />
                    {Number(proposal.deposit_credit_amount || 0) > 0 ? "Edit deposit credit" : "Apply a held deposit credit"}
                  </button>
                )}

                {proposal.deposit_payment_status === "paid" && (
                  <>
                    {proposal.deposit_payment_amount && (
                      <div className="flex justify-between">
                        <span className="text-green-700">Paid</span>
                        <span className="font-semibold text-green-800">₹{Number(proposal.deposit_payment_amount).toLocaleString("en-IN")}</span>
                      </div>
                    )}
                    {proposal.deposit_payment_reference && (
                      <div className="flex justify-between">
                        <span className="text-green-700">Reference / UTR</span>
                        <span className="font-mono text-xs text-green-800">{proposal.deposit_payment_reference}</span>
                      </div>
                    )}
                    {proposal.deposit_payment_received_at && (
                      <div className="flex justify-between">
                        <span className="text-green-700">Received</span>
                        <span className="text-green-800 text-xs">{formatDate(proposal.deposit_payment_received_at)}</span>
                      </div>
                    )}
                    {proposal.deposit_payment_screenshot_url && (
                      <a
                        href={proposal.deposit_payment_screenshot_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-1.5 text-xs text-green-700 underline mt-1"
                      >
                        <Upload className="h-3 w-3" />
                        View payment proof
                      </a>
                    )}
                  </>
                )}

                {proposal.deposit_payment_status === "pending" && ["sent", "viewed", "accepted"].includes(proposal.status) && (
                  <Button
                    size="sm"
                    className="w-full mt-2"
                    onClick={openDepositEmailDialog}
                  >
                    <Mail className="mr-2 h-3.5 w-3.5" />
                    {proposal.deposit_razorpay_link_url ? "Preview & Resend Deposit Email" : "Preview & Send Deposit Email"}
                  </Button>
                )}

                {/* Manual payment recording */}
                {proposal.deposit_payment_status === "pending" && ["sent", "viewed", "accepted"].includes(proposal.status) && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="w-full mt-1 border-amber-300 text-amber-800 hover:bg-amber-50"
                    onClick={openManualPayDialog}
                  >
                    <Banknote className="mr-2 h-3.5 w-3.5" />
                    Record Bank Transfer
                  </Button>
                )}

                {proposal.deposit_razorpay_link_url && proposal.deposit_payment_status !== "paid" && (() => {
                  const linkCreated = proposal.sent_at ? new Date(proposal.sent_at) : new Date();
                  const expiresAt = new Date(linkCreated.getTime() + 30 * 24 * 60 * 60 * 1000);
                  const now = new Date();
                  const daysLeft = Math.ceil((expiresAt.getTime() - now.getTime()) / (24 * 60 * 60 * 1000));
                  const isExpired = daysLeft <= 0;

                  return (
                    <div className="mt-2 space-y-2">
                      <div className="flex justify-between text-xs">
                        <span className="text-amber-700">Created: {linkCreated.toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric" })}</span>
                        {isExpired ? (
                          <span className="text-red-600 font-semibold">Expired</span>
                        ) : (
                          <span className={daysLeft <= 7 ? "text-amber-600 font-semibold" : "text-amber-600"}>
                            {daysLeft} day{daysLeft !== 1 ? "s" : ""} remaining
                          </span>
                        )}
                      </div>
                      {!isExpired && (
                        <div className="flex items-center gap-2">
                          <input
                            readOnly
                            value={proposal.deposit_razorpay_link_url}
                            className="flex-1 text-xs font-mono bg-white border rounded px-2 py-1 text-amber-800"
                          />
                          <Button size="sm" variant="outline" className="text-xs h-7"
                            onClick={() => { navigator.clipboard.writeText(proposal.deposit_razorpay_link_url!); toast.success("Deposit link copied"); }}>
                            Copy
                          </Button>
                        </div>
                      )}
                      {isExpired && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="w-full border-red-300 text-red-700 hover:bg-red-50"
                          onClick={async () => {
                            await fetch(`/api/proposals/${proposal.id}`, {
                              method: "PATCH",
                              headers: { "Content-Type": "application/json" },
                              body: JSON.stringify({ deposit_razorpay_link_id: null, deposit_razorpay_link_url: null }),
                            });
                            const res = await fetch(`/api/proposals/${proposal.id}/deposit-link`, { method: "POST" });
                            if (res.ok) {
                              toast.success("New deposit link generated and sent");
                              fetchProposal();
                            } else {
                              toast.error("Failed to regenerate deposit link");
                            }
                          }}
                        >
                          Regenerate Expired Link
                        </Button>
                      )}
                    </div>
                  );
                })()}
              </CardContent>
            </Card>
          )}

          {/* Monthly Charge — GST Invoice */}
          {proposal.status !== "draft" && proposal.status !== "rejected" && (() => {
            const depositRequired = Number(proposal.security_deposit_months || 0) > 0;
            const depositPaid = proposal.deposit_payment_status === "paid";
            const canSendInvoice = !depositRequired || depositPaid;
            const invoiceSent = !!proposal.occupation_start_date;

            return (
              <Card className={proposal.payment_status === "paid" ? "border-green-200 bg-green-50" : "border-blue-200 bg-blue-50"}>
                <CardHeader className="pb-2">
                  <CardTitle className={`text-base flex items-center gap-2 ${proposal.payment_status === "paid" ? "text-green-700" : "text-blue-700"}`}>
                    {canSendInvoice && proposal.payment_status !== "paid" && (
                      <span className="relative flex h-2.5 w-2.5 shrink-0">
                        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75"></span>
                        <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-blue-500"></span>
                      </span>
                    )}
                    Monthly Charge — ₹{Number(proposal.total_amount).toLocaleString("en-IN")}/month
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-2 text-sm">
                  {/* Paid state */}
                  {proposal.payment_status === "paid" && proposal.payment_amount && (
                    <>
                      <div className="flex justify-between">
                        <span className="text-green-700">Paid</span>
                        <span className="font-semibold text-green-800">₹{Number(proposal.payment_amount).toLocaleString("en-IN")}</span>
                      </div>
                      {proposal.payment_reference && (
                        <div className="flex justify-between">
                          <span className="text-green-700">Reference</span>
                          <span className="font-mono text-xs text-green-800">{proposal.payment_reference}</span>
                        </div>
                      )}
                    </>
                  )}

                  {/* Invoice already sent */}
                  {invoiceSent && proposal.payment_status !== "paid" && (
                    <>
                      <div className="flex justify-between text-xs">
                        <span className="text-blue-700">Occupation from: {new Date(proposal.occupation_start_date + "T00:00:00").toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric" })}</span>
                        <Badge variant="outline" className="text-[10px] border-blue-300 text-blue-700">Invoice Sent</Badge>
                      </div>
                      {proposal.razorpay_payment_link_url && (
                        <div className="flex items-center gap-2 mt-1">
                          <input readOnly value={proposal.razorpay_payment_link_url} className="flex-1 text-xs font-mono bg-white border rounded px-2 py-1 text-blue-800" />
                          <Button size="sm" variant="outline" className="text-xs h-7"
                            onClick={() => { navigator.clipboard.writeText(proposal.razorpay_payment_link_url!); toast.success("Payment link copied"); }}>
                            Copy
                          </Button>
                        </div>
                      )}
                      <Button
                        size="sm"
                        variant="outline"
                        className="w-full border-blue-300 text-blue-700 hover:bg-blue-100"
                        onClick={() => openGstDialog(true)}
                      >
                        <Mail className="mr-2 h-3.5 w-3.5" />
                        Revise Start Date & Resend Invoice
                      </Button>
                    </>
                  )}

                  {/* Monthly payment link — always visible once created, for sharing with customer */}
                  {!invoiceSent && proposal.payment_status !== "paid" && proposal.razorpay_payment_link_url && (
                    <div className="rounded bg-blue-50 border border-blue-200 p-2 space-y-1">
                      <p className="text-xs text-blue-700 font-medium">Monthly charge payment link</p>
                      <div className="flex items-center gap-2">
                        <input
                          readOnly
                          value={proposal.razorpay_payment_link_url}
                          className="flex-1 text-xs font-mono bg-white border rounded px-2 py-1 text-blue-800"
                        />
                        <Button size="sm" variant="outline" className="text-xs h-7 shrink-0"
                          onClick={() => { navigator.clipboard.writeText(proposal.razorpay_payment_link_url!); toast.success("Payment link copied"); }}>
                          Copy
                        </Button>
                      </div>
                    </div>
                  )}

                  {/* Send GST Invoice button */}
                  {!invoiceSent && proposal.payment_status !== "paid" && (
                    <>
                      {!canSendInvoice && (
                        <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-3 py-2">
                          Security deposit must be paid before sending the GST invoice.
                        </p>
                      )}
                      <Button
                        size="sm"
                        className="w-full"
                        disabled={!canSendInvoice}
                        onClick={() => openGstDialog(false)}
                      >
                        <Mail className="mr-2 h-3.5 w-3.5" />
                        Preview & Send GST Invoice
                      </Button>
                    </>
                  )}
                </CardContent>
              </Card>
            );
          })()}

          {/* Proposal Details */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Proposal Details</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Status</span>
                <Badge
                  variant="secondary"
                  className={PROPOSAL_STATUS_COLORS[proposal.status]}
                >
                  {PROPOSAL_STATUS_LABELS[proposal.status]}
                </Badge>
              </div>
              {proposal.valid_until && (
                <>
                  <Separator />
                  <div className="flex justify-between items-center">
                    <span className="text-muted-foreground">Valid Until</span>
                    <div className="flex items-center gap-1.5">
                      {isExpired && (
                        <AlertTriangle className="h-3.5 w-3.5 text-orange-500" />
                      )}
                      <span className={isExpired ? "text-orange-600" : ""}>
                        {formatDate(proposal.valid_until)}
                      </span>
                    </div>
                  </div>
                </>
              )}
              <Separator />
              <div className="flex justify-between">
                <span className="text-muted-foreground">Created</span>
                <span>{formatDate(proposal.created_at)}</span>
              </div>
              <Separator />
              <div className="flex justify-between">
                <span className="text-muted-foreground">Updated</span>
                <span>{formatDate(proposal.updated_at)}</span>
              </div>
            </CardContent>
          </Card>

          {/* Deposit Waiver Gate — shown for zero-deposit proposals */}
          {isZeroDeposit && (
            <div id="deposit-waiver-gate">
              <DepositWaiverGate
                proposalId={proposal.id}
                proposalNumber={proposal.proposal_number}
                isVerified={waiverVerified}
                requestedAt={proposal.deposit_waiver_requested_at}
                onVerified={fetchProposal}
              />
            </div>
          )}

          {/* Lifecycle Timeline */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Lifecycle</CardTitle>
            </CardHeader>
            <CardContent className="pt-0">
              <ProposalLifecycle proposal={proposal} />
            </CardContent>
          </Card>

          {/* Payment Details */}
          {proposal.payment_status === "paid" && (
            <Card className="border-green-200 bg-green-50">
              <CardHeader className="pb-2">
                <CardTitle className="text-base text-green-700">Payment Received</CardTitle>
              </CardHeader>
              <CardContent className="space-y-1 text-sm">
                {proposal.payment_amount && (
                  <div className="flex justify-between">
                    <span className="text-green-700">Amount</span>
                    <span className="font-semibold text-green-800">₹{Number(proposal.payment_amount).toLocaleString("en-IN")}</span>
                  </div>
                )}
                {proposal.payment_reference && (
                  <div className="flex justify-between">
                    <span className="text-green-700">Reference</span>
                    <span className="font-mono text-xs text-green-800">{proposal.payment_reference}</span>
                  </div>
                )}
                {proposal.payment_received_at && (
                  <div className="flex justify-between">
                    <span className="text-green-700">Received</span>
                    <span className="text-green-800">{formatDate(proposal.payment_received_at)}</span>
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {/* Rejection Reason */}
          {proposal.status === "rejected" && proposal.rejection_reason && (
            <Card className="border-red-200 bg-red-50">
              <CardHeader className="pb-2">
                <CardTitle className="text-base text-red-700">Rejection Reason</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-red-800 whitespace-pre-wrap">{proposal.rejection_reason}</p>
              </CardContent>
            </Card>
          )}
        </div>
      </div>

      {/* Booking Confirmation Dialog (accept flow) */}
      {bookingConfirmOpen && (
        <BookingConfirmationDialog
          open={bookingConfirmOpen}
          onOpenChange={setBookingConfirmOpen}
          proposal={proposal}
          onSuccess={fetchProposal}
        />
      )}

      {/* Create Contract Dialog */}
      {proposal.lead_id && createContractOpen && (
        <CreateContractDialog
          open={createContractOpen}
          onOpenChange={setCreateContractOpen}
          leadId={proposal.lead_id}
          defaultProposalId={proposal.id}
          onSuccess={() => {
            setCreateContractOpen(false);
            fetchProposal();
          }}
        />
      )}

      {/* Email Dialog */}
      <EmailDocumentDialog
        open={emailDialogOpen}
        onOpenChange={setEmailDialogOpen}
        documentType="proposal"
        documentId={proposal.id}
        documentNumber={proposal.proposal_number}
        leadEmail={proposal.lead?.email || undefined}
        leadPhone={proposal.lead?.phone || proposal.lead?.mobile || undefined}
        onGeneratePDF={async () => {
          // Negotiation-phase proposal — no deposit payment link included.
          // The deposit link is only sent after acceptance via the /accept route.
          const preparedBy = currentUser?.full_name
            ? { name: currentUser.full_name, email: currentUser.email || undefined, phone: currentUser.phone || undefined }
            : undefined;
          const { generateProposalPDF } = await import("@/lib/pdf-generator");
          const doc = generateProposalPDF(proposal, proposal.lead || undefined, undefined, preparedBy, serviceQuotas);
          return doc.output("datauristring").split(",")[1];
        }}
        onSuccess={fetchProposal}
      />

      {/* Deposit Email Preview Dialog */}
      <Dialog open={depositEmailOpen} onOpenChange={setDepositEmailOpen}>
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-hidden flex flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Mail className="h-5 w-5 text-primary" />
              Security Deposit Email Preview
            </DialogTitle>
            <p className="text-sm text-muted-foreground">
              {proposal.proposal_number} — Refundable deposit ₹{Number(proposal.security_deposit_amount || 0).toLocaleString("en-IN")}
            </p>
          </DialogHeader>

          {depositEmailLoading && (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              <span className="ml-2 text-sm text-muted-foreground">Loading preview…</span>
            </div>
          )}

          {depositEmailPreview && (
            <div className="flex-1 min-h-0 flex flex-col gap-3">
              <div className="grid grid-cols-2 gap-2 text-xs">
                <div className="space-y-0.5">
                  <p className="font-medium text-muted-foreground">To</p>
                  <p className="font-mono text-foreground">{depositEmailPreview.to.join(", ") || "—"}</p>
                </div>
                <div className="space-y-0.5">
                  <p className="font-medium text-muted-foreground">Subject</p>
                  <p className="font-medium text-foreground">{depositEmailPreview.subject}</p>
                </div>
              </div>

              {depositEmailPreview.link_already_exists ? (
                <div className="rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-800">
                  This proposal already has an active Razorpay deposit link — the existing link will be used.
                </div>
              ) : (
                <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                  A new Razorpay payment link will be created and inserted into the email when you click <strong>Send Now</strong>.
                </div>
              )}

              <div className="flex-1 min-h-0 overflow-auto rounded-md border bg-white p-1">
                <iframe
                  title="Deposit email preview"
                  srcDoc={depositEmailPreview.html}
                  className="w-full h-[420px] border-0"
                  sandbox=""
                />
              </div>

              <div className="flex justify-end gap-2 pt-1">
                <Button variant="outline" onClick={() => setDepositEmailOpen(false)} disabled={depositEmailSending}>
                  Cancel
                </Button>
                <Button
                  onClick={handleSendDepositEmail}
                  disabled={depositEmailSending || !depositEmailPreview.to.length}
                  className="bg-primary hover:bg-primary/90"
                >
                  {depositEmailSending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  <Send className="mr-2 h-4 w-4" />
                  {depositEmailSending ? "Sending…" : "Send Now"}
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* GST Invoice Preview Dialog */}
      <Dialog open={gstDialogOpen} onOpenChange={setGstDialogOpen}>
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-hidden flex flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Mail className="h-5 w-5 text-primary" />
              {gstIsRevise ? "Revise & Resend GST Invoice" : "Preview & Send GST Invoice"}
            </DialogTitle>
            <p className="text-sm text-muted-foreground">
              {proposal.proposal_number} — Monthly charge ₹{Number(proposal.total_amount).toLocaleString("en-IN")}
              {gstIsRevise && proposal.occupation_start_date && (
                <span className="ml-2 text-xs text-blue-600">
                  (currently set to {new Date(proposal.occupation_start_date + "T00:00:00").toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric" })})
                </span>
              )}
            </p>
          </DialogHeader>

          <div className="flex items-end gap-2">
            <div className="flex-1 space-y-1.5">
              <Label htmlFor="gst-date">Occupation Start Date</Label>
              <Input
                id="gst-date"
                type="date"
                value={gstDate}
                onChange={(e) => { setGstDate(e.target.value); setGstPreview(null); }}
              />
              <p className="text-xs text-muted-foreground">The invoice is prorated from this date to month-end.</p>
            </div>
            <Button
              variant="outline"
              onClick={refreshGstPreview}
              disabled={gstPreviewLoading || !gstDate}
            >
              {gstPreviewLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {gstPreview ? "Refresh Preview" : "Generate Preview"}
            </Button>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="gst-cc">CC (comma-separated)</Label>
            <Input
              id="gst-cc"
              type="text"
              placeholder="accounts@customer.com, cfo@customer.com"
              value={gstCc}
              onChange={(e) => setGstCc(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">Pre-filled from the lead&apos;s saved billing contacts. Edited addresses are remembered for next time.</p>
          </div>

          {gstPreviewLoading && !gstPreview && (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              <span className="ml-2 text-sm text-muted-foreground">Calculating…</span>
            </div>
          )}

          {gstPreview && (
            <div className="flex-1 min-h-0 flex flex-col gap-3">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
                <div className="rounded-md border bg-muted/30 px-3 py-2">
                  <p className="text-muted-foreground">Invoice No.</p>
                  <p className="font-mono font-semibold text-foreground">{gstPreview.invoiceNumber || "Assigned on send"}</p>
                </div>
                <div className="rounded-md border bg-muted/30 px-3 py-2">
                  <p className="text-muted-foreground">Period</p>
                  <p className="font-semibold text-foreground">{gstPreview.daysRemaining}/{gstPreview.daysInMonth} days</p>
                </div>
                <div className="rounded-md border bg-muted/30 px-3 py-2">
                  <p className="text-muted-foreground">Subtotal</p>
                  <p className="font-semibold text-foreground">₹{gstPreview.proratedSubtotal.toLocaleString("en-IN")}</p>
                </div>
                <div className="rounded-md border border-primary/30 bg-primary/5 px-3 py-2">
                  <p className="text-muted-foreground">Total Payable</p>
                  <p className="font-bold text-primary">₹{gstPreview.totalAmount.toLocaleString("en-IN")}</p>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2 text-xs">
                <div className="space-y-0.5">
                  <p className="font-medium text-muted-foreground">To</p>
                  <p className="font-mono text-foreground">{gstPreview.to.join(", ") || "—"}</p>
                </div>
                <div className="space-y-0.5">
                  <p className="font-medium text-muted-foreground">Subject</p>
                  <p className="font-medium text-foreground truncate">{gstPreview.subject}</p>
                </div>
              </div>

              {gstIsRevise && (
                <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                  <strong>Revise & Resend:</strong> A new GST invoice number will be issued and a fresh email (with the new PDF) will be sent to the customer. The previous invoice will not be automatically cancelled.
                </div>
              )}

              <div className="flex-1 min-h-0 overflow-auto rounded-md border bg-white p-1">
                <iframe
                  title="GST invoice email preview"
                  srcDoc={gstPreview.html}
                  className="w-full h-[400px] border-0"
                  sandbox=""
                />
              </div>

              <div className="flex justify-end gap-2 pt-1">
                <Button variant="outline" onClick={() => setGstDialogOpen(false)} disabled={gstSending}>
                  Cancel
                </Button>
                <Button
                  onClick={handleSendGstInvoice}
                  disabled={gstSending || !gstPreview.to.length}
                  className="bg-primary hover:bg-primary/90"
                >
                  {gstSending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  <Send className="mr-2 h-4 w-4" />
                  {gstSending ? "Sending…" : gstIsRevise ? "Resend Invoice" : "Send Invoice"}
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Manual Deposit Payment Dialog */}
      <Dialog open={manualPayDialogOpen} onOpenChange={setManualPayDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Banknote className="h-5 w-5 text-amber-600" />
              Record Bank Transfer Payment
            </DialogTitle>
            <p className="text-sm text-muted-foreground">{proposal.proposal_number} — Security Deposit</p>
          </DialogHeader>

          <div className="space-y-4">
            {(() => {
              const expectedAmt = Number(proposal.security_deposit_amount || 0);
              const enteredAmt = parseFloat(manualPayAmount) || 0;
              const shortfall = expectedAmt > 0 && enteredAmt > 0 && enteredAmt < expectedAmt
                ? (expectedAmt - enteredAmt) / expectedAmt
                : 0;
              const canApproveShortfall = ["admin", "manager"].includes(currentUser?.role || "");
              return (
                <>
                  <div className="space-y-1.5">
                    <Label htmlFor="mp-amount">Amount Received (₹) <span className="text-destructive">*</span></Label>
                    <Input
                      id="mp-amount"
                      type="number"
                      min={0}
                      step={0.01}
                      value={manualPayAmount}
                      onChange={(e) => { setManualPayAmount(e.target.value); setManualPayShortfallApproved(false); }}
                      placeholder="e.g. 22000"
                    />
                    <p className="text-xs text-muted-foreground">
                      Expected deposit: ₹{expectedAmt.toLocaleString("en-IN")}
                    </p>
                  </div>

                  {shortfall > 0.10 && (
                    <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">
                      ⚠️ Amount is <strong>{(shortfall * 100).toFixed(1)}%</strong> below the expected deposit (shortfall ₹{(expectedAmt - enteredAmt).toLocaleString("en-IN")}). Minimum acceptable is ₹{Math.ceil(expectedAmt * 0.9).toLocaleString("en-IN")}. Cannot record.
                    </div>
                  )}

                  {shortfall > 0 && shortfall <= 0.10 && (
                    <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 space-y-2">
                      <p className="text-xs text-amber-800">
                        ⚠️ Amount is <strong>{(shortfall * 100).toFixed(1)}%</strong> less than expected (shortfall ₹{(expectedAmt - enteredAmt).toLocaleString("en-IN")}). {canApproveShortfall ? "Check the box below to approve this shortfall." : "Only a manager or admin can approve a shortfall."}
                      </p>
                      {canApproveShortfall && (
                        <label className="flex items-center gap-2 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={manualPayShortfallApproved}
                            onChange={(e) => setManualPayShortfallApproved(e.target.checked)}
                            className="h-4 w-4 rounded border-amber-400 accent-amber-600"
                          />
                          <span className="text-xs font-medium text-amber-900">
                            I approve accepting ₹{enteredAmt.toLocaleString("en-IN")} as full settlement of the security deposit
                          </span>
                        </label>
                      )}
                    </div>
                  )}
                </>
              );
            })()}

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="mp-medium">Payment Mode</Label>
                <select
                  id="mp-medium"
                  value={manualPayMedium}
                  onChange={(e) => setManualPayMedium(e.target.value)}
                  className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm"
                >
                  <option value="">Select mode</option>
                  <option value="neft">NEFT</option>
                  <option value="rtgs">RTGS</option>
                  <option value="upi">UPI</option>
                  <option value="cheque">Cheque</option>
                  <option value="cash">Cash</option>
                  <option value="razorpay">Razorpay</option>
                </select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="mp-ref">Reference / UTR</Label>
                <Input
                  id="mp-ref"
                  value={manualPayRef}
                  onChange={(e) => setManualPayRef(e.target.value)}
                  placeholder="UTR or transaction ID"
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="mp-notes">Notes (optional)</Label>
              <Textarea
                id="mp-notes"
                value={manualPayNotes}
                onChange={(e) => setManualPayNotes(e.target.value)}
                placeholder="Any additional notes about the payment"
                rows={2}
              />
            </div>

            <div className="space-y-1.5">
              <Label>Payment Proof (screenshot / PDF)</Label>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*,application/pdf"
                className="hidden"
                onChange={(e) => setManualPayFile(e.target.files?.[0] || null)}
              />
              {manualPayFile ? (
                <div className="flex items-center justify-between rounded-md border px-3 py-2 text-sm">
                  <span className="truncate text-muted-foreground">{manualPayFile.name}</span>
                  <button
                    type="button"
                    onClick={() => { setManualPayFile(null); if (fileInputRef.current) fileInputRef.current.value = ""; }}
                    className="ml-2 text-muted-foreground hover:text-destructive"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
              ) : (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="w-full"
                  onClick={() => fileInputRef.current?.click()}
                >
                  <Upload className="mr-2 h-4 w-4" />
                  Upload proof of payment
                </Button>
              )}
              <p className="text-xs text-muted-foreground">Optional — JPEG, PNG or PDF, max 10 MB</p>
            </div>

            <div className="rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-800">
              A confirmation email will automatically be sent to the customer once you save.
            </div>

            <div className="flex justify-end gap-2 pt-1">
              <Button
                variant="outline"
                onClick={() => setManualPayDialogOpen(false)}
                disabled={manualPaySubmitting}
              >
                Cancel
              </Button>
              <Button
                onClick={handleManualPaySubmit}
                disabled={manualPaySubmitting || (() => {
                  const expectedAmt = Number(proposal.security_deposit_amount || 0);
                  const enteredAmt = parseFloat(manualPayAmount) || 0;
                  if (expectedAmt > 0 && enteredAmt > 0 && enteredAmt < expectedAmt) {
                    const shortfall = (expectedAmt - enteredAmt) / expectedAmt;
                    if (shortfall > 0.10) return true;
                    if (shortfall > 0 && !manualPayShortfallApproved) return true;
                  }
                  return false;
                })()}
                className="bg-amber-600 hover:bg-amber-700 text-white"
              >
                {manualPaySubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {manualPaySubmitting ? "Saving…" : "Mark as Paid & Notify Customer"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Apply Deposit Credit Dialog (admin/manager) */}
      <Dialog open={depositCreditOpen} onOpenChange={setDepositCreditOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Banknote className="h-5 w-5 text-amber-600" />
              Apply Deposit Credit
            </DialogTitle>
            <p className="text-sm text-muted-foreground">
              {proposal.proposal_number} — Required deposit ₹{Number(proposal.security_deposit_amount || 0).toLocaleString("en-IN")}
            </p>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="dc-amount">Credit Amount (₹) <span className="text-destructive">*</span></Label>
              <Input
                id="dc-amount"
                type="number"
                min={0}
                step={0.01}
                value={depositCreditAmount}
                onChange={(e) => setDepositCreditAmount(e.target.value)}
                placeholder="e.g. 23000"
              />
              <p className="text-xs text-muted-foreground">
                Deposit already held from a prior contract, to be netted off. The required deposit stays unchanged — only the balance below is collected.
              </p>
              {(() => {
                const required = Number(proposal.security_deposit_amount || 0);
                const credit = parseFloat(depositCreditAmount) || 0;
                const balance = Math.max(0, required - credit);
                return (
                  <p className="text-xs font-medium text-amber-800">
                    Balance to collect: ₹{balance.toLocaleString("en-IN")}
                  </p>
                );
              })()}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="dc-reason">Reason <span className="text-destructive">*</span></Label>
              <Textarea
                id="dc-reason"
                value={depositCreditReason}
                onChange={(e) => setDepositCreditReason(e.target.value)}
                placeholder="e.g. Refundable deposit held from terminated contract TWV-C-00xx, confirmed by accounts"
                rows={2}
              />
              <p className="text-xs text-muted-foreground">Kept on record for audit — explains why less deposit was collected.</p>
            </div>

            <div className="space-y-1.5">
              <Label>Proof (accounts confirmation) <span className="text-destructive">*</span></Label>
              <input
                ref={creditFileInputRef}
                type="file"
                accept="image/*,application/pdf"
                className="hidden"
                onChange={(e) => setDepositCreditProofFile(e.target.files?.[0] || null)}
              />
              {depositCreditProofFile ? (
                <div className="flex items-center justify-between rounded-md border px-3 py-2 text-sm">
                  <span className="truncate text-muted-foreground">{depositCreditProofFile.name}</span>
                  <button
                    type="button"
                    onClick={() => { setDepositCreditProofFile(null); if (creditFileInputRef.current) creditFileInputRef.current.value = ""; }}
                    className="ml-2 text-muted-foreground hover:text-destructive"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
              ) : (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="w-full"
                  onClick={() => creditFileInputRef.current?.click()}
                >
                  <Upload className="mr-2 h-4 w-4" />
                  Upload proof
                </Button>
              )}
            </div>

            <div className="flex justify-end gap-2 pt-1">
              <Button
                variant="outline"
                onClick={() => setDepositCreditOpen(false)}
                disabled={depositCreditSubmitting}
              >
                Cancel
              </Button>
              <Button
                onClick={submitDepositCredit}
                disabled={depositCreditSubmitting}
                className="bg-amber-600 hover:bg-amber-700 text-white"
              >
                {depositCreditSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {depositCreditSubmitting ? "Saving…" : "Apply Credit"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
