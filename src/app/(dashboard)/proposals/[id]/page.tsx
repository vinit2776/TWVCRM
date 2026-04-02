"use client";

import { use, useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  ArrowLeft,
  Download,
  Send,
  Eye,
  CheckCircle2,
  XCircle,
  Clock,
  Mail,
  AlertTriangle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/shared/loading-skeleton";
import {
  PROPOSAL_STATUS_LABELS,
  PROPOSAL_STATUS_COLORS,
  KYC_DOCUMENTS,
  ENTITY_TYPE_LABELS,
} from "@/lib/constants";
import { formatDate, formatCurrency } from "@/lib/utils";
import { generateProposalPDF } from "@/lib/pdf-generator";
import { EmailDocumentDialog } from "@/components/shared/email-document-dialog";
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

  // Email dialog state
  const [emailDialogOpen, setEmailDialogOpen] = useState(false);

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
  }, [fetchProposal]);

  const handleDownloadPDF = async () => {
    if (!proposal) return;

    // Fetch UPI QR code (base64) from payment module settings
    let qrCodeBase64: string | undefined;
    let upiId: string | undefined;
    try {
      const settingsRes = await fetch("/api/settings/public");
      if (settingsRes.ok) {
        const sJson = await settingsRes.json();
        const settings = sJson.data || {};
        upiId = settings.upi_id || undefined;
        qrCodeBase64 = settings.upi_qr_code_base64 || undefined;
      }
    } catch {
      // Continue without QR code if fetch fails
    }

    const doc = generateProposalPDF(
      proposal,
      proposal.lead || undefined,
      { qrCodeBase64, upiId, razorpayPaymentLink: proposal.razorpay_payment_link_url || undefined }
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

  const isExpired =
    proposal?.valid_until && new Date(proposal.valid_until) < new Date();

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
            onClick={() => router.push("/proposals")}
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
            <Button
              variant="outline"
              size="sm"
              onClick={() => handleUpdateStatus("viewed", "Viewed")}
            >
              <Eye className="mr-2 h-4 w-4" />
              Mark as Viewed
            </Button>
          )}
          {(proposal.status === "sent" || proposal.status === "viewed") && (
            <>
              <Button
                size="sm"
                className="bg-green-600 hover:bg-green-700 text-white"
                onClick={() => handleUpdateStatus("accepted", "Accepted")}
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
          <Button variant="outline" size="sm" onClick={handleEmailProposal}>
            <Mail className="mr-2 h-4 w-4" />
            Email
          </Button>
          <Button variant="outline" size="sm" onClick={handleDownloadPDF}>
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

          {/* Timeline */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <Clock className="h-4 w-4" />
                Timeline
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Created</span>
                <span>{formatDate(proposal.created_at)}</span>
              </div>
              {proposal.sent_at && (
                <>
                  <Separator />
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Sent</span>
                    <span>{formatDate(proposal.sent_at)}</span>
                  </div>
                </>
              )}
              {proposal.viewed_at && (
                <>
                  <Separator />
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Viewed</span>
                    <span>{formatDate(proposal.viewed_at)}</span>
                  </div>
                </>
              )}
              {proposal.accepted_at && (
                <>
                  <Separator />
                  <div className="flex justify-between text-green-600">
                    <span>Accepted</span>
                    <span>{formatDate(proposal.accepted_at)}</span>
                  </div>
                </>
              )}
              {proposal.rejected_at && (
                <>
                  <Separator />
                  <div className="flex justify-between text-red-600">
                    <span>Rejected</span>
                    <span>{formatDate(proposal.rejected_at)}</span>
                  </div>
                </>
              )}
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

          {/* Payment Link (awaiting payment) */}
          {proposal.razorpay_payment_link_url && proposal.payment_status !== "paid" && (
            <Card className="border-amber-200 bg-amber-50">
              <CardHeader className="pb-2">
                <CardTitle className="text-base text-amber-700">Payment Link</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                <p className="text-amber-800">Payment link has been sent to the customer.</p>
                <div className="flex items-center gap-2">
                  <input
                    readOnly
                    value={proposal.razorpay_payment_link_url}
                    className="flex-1 text-xs font-mono bg-white border rounded px-2 py-1 text-amber-800"
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    className="text-xs h-7"
                    onClick={() => {
                      navigator.clipboard.writeText(proposal.razorpay_payment_link_url!);
                      toast.success("Payment link copied");
                    }}
                  >
                    Copy
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Security Deposit */}
          {Number(proposal.security_deposit_months) > 0 && (
            <Card className={proposal.deposit_payment_status === "paid" ? "border-green-200 bg-green-50" : "border-amber-200 bg-amber-50"}>
              <CardHeader className="pb-2">
                <CardTitle className={`text-base ${proposal.deposit_payment_status === "paid" ? "text-green-700" : "text-amber-700"}`}>
                  Security Deposit ({proposal.security_deposit_months} month{Number(proposal.security_deposit_months) > 1 ? "s" : ""})
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className={proposal.deposit_payment_status === "paid" ? "text-green-700" : "text-amber-700"}>Amount (pre-GST)</span>
                  <span className="font-semibold">₹{Number(proposal.security_deposit_amount || 0).toLocaleString("en-IN")}</span>
                </div>

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
                        <span className="text-green-700">Reference</span>
                        <span className="font-mono text-xs text-green-800">{proposal.deposit_payment_reference}</span>
                      </div>
                    )}
                  </>
                )}

                {proposal.deposit_payment_status === "pending" && proposal.status === "accepted" && !proposal.deposit_razorpay_link_url && (
                  <Button
                    size="sm"
                    className="w-full mt-2"
                    onClick={async () => {
                      const res = await fetch(`/api/proposals/${proposal.id}/deposit-link`, { method: "POST" });
                      const json = await res.json();
                      if (res.ok) {
                        toast.success(`Deposit link sent: ₹${Number(proposal.security_deposit_amount).toLocaleString("en-IN")}`);
                        fetchProposal();
                      } else {
                        toast.error(json.error || "Failed to create deposit link");
                      }
                    }}
                  >
                    Send Deposit Link
                  </Button>
                )}

                {proposal.deposit_razorpay_link_url && proposal.deposit_payment_status !== "paid" && (
                  <div className="flex items-center gap-2 mt-2">
                    <input
                      readOnly
                      value={proposal.deposit_razorpay_link_url}
                      className="flex-1 text-xs font-mono bg-white border rounded px-2 py-1 text-amber-800"
                    />
                    <Button
                      size="sm"
                      variant="outline"
                      className="text-xs h-7"
                      onClick={() => {
                        navigator.clipboard.writeText(proposal.deposit_razorpay_link_url!);
                        toast.success("Deposit link copied");
                      }}
                    >
                      Copy
                    </Button>
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

      {/* Email Dialog */}
      <EmailDocumentDialog
        open={emailDialogOpen}
        onOpenChange={setEmailDialogOpen}
        documentType="proposal"
        documentId={proposal.id}
        documentNumber={proposal.proposal_number}
        leadEmail={proposal.lead?.email || undefined}
        onGeneratePDF={async () => {
          let qrCode: string | undefined;
          let upi: string | undefined;
          try {
            const sRes = await fetch("/api/settings/public");
            if (sRes.ok) {
              const s = (await sRes.json()).data || {};
              upi = s.upi_id || undefined;
              qrCode = s.upi_qr_code_base64 || undefined;
            }
          } catch { /* continue without QR */ }
          const doc = generateProposalPDF(proposal, proposal.lead || undefined, {
            qrCodeBase64: qrCode,
            upiId: upi,
            razorpayPaymentLink: proposal.razorpay_payment_link_url || undefined,
          });
          const base64 = doc.output("datauristring").split(",")[1];
          return base64;
        }}
        onSuccess={fetchProposal}
      />
    </div>
  );
}
