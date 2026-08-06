"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Plus, FileText, Receipt, MoreHorizontal, Download, Mail, Send, CheckCircle2, XCircle, Eye, CreditCard, Copy, Ban } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/shared/empty-state";
import { TableSkeleton } from "@/components/shared/loading-skeleton";
import { ProposalForm } from "@/components/proposals/proposal-form";
import { InvoiceForm } from "@/components/invoices/invoice-form";
import { EmailDocumentDialog } from "@/components/shared/email-document-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  PROPOSAL_STATUS_LABELS,
  PROPOSAL_STATUS_COLORS,
  INVOICE_STATUS_LABELS,
  ACCOUNTING_HEAD_LABELS,
  ACCOUNTING_HEAD_COLORS,
  type AccountingHead,
} from "@/lib/constants";
import { formatDate, formatCurrency } from "@/lib/utils";
import { toast } from "sonner";
import type { Proposal, ProformaInvoice, Lead } from "@/types";

const INVOICE_STATUS_COLORS: Record<string, string> = {
  draft: "bg-gray-100 text-gray-800",
  sent: "bg-blue-100 text-blue-800",
  paid: "bg-green-100 text-green-800",
  overdue: "bg-red-100 text-red-800",
  cancelled: "bg-orange-100 text-orange-800",
};

interface LeadProposalsTabProps {
  leadId: string;
  leadLocationId?: string;
}

export function LeadProposalsTab({ leadId, leadLocationId }: LeadProposalsTabProps) {
  const router = useRouter();
  const [proposals, setProposals] = useState<(Proposal & { lead?: Lead })[]>([]);
  const [invoices, setInvoices] = useState<(ProformaInvoice & { lead?: Lead })[]>([]);
  const [loading, setLoading] = useState(true);
  const [proposalFormOpen, setProposalFormOpen] = useState(false);
  const [invoiceFormOpen, setInvoiceFormOpen] = useState(false);
  const [viewInvoice, setViewInvoice] = useState<(ProformaInvoice & { lead?: Lead }) | null>(null);

  // Email dialog state
  const [emailDialogOpen, setEmailDialogOpen] = useState(false);
  const [emailConfig, setEmailConfig] = useState<{
    type: "proposal" | "invoice";
    id: string;
    number: string;
    leadEmail?: string;
    leadPhone?: string;
    defaultCc?: string[];
    generatePDF: () => Promise<string>;
  } | null>(null);

  // Lead info for PDF generation
  const [lead, setLead] = useState<Lead | null>(null);

  // Newest non-terminal proposal — where the deposit link lives. Proposals
  // come back newest-first, so this is just the first one that isn't
  // rejected/expired; falls back to the newest overall if all are terminal.
  const activeProposal =
    proposals.find((p) => p.status !== "rejected" && p.status !== "expired") ?? proposals[0];

  const fetchData = useCallback(async () => {
    setLoading(true);
    const [proposalsRes, invoicesRes, leadRes] = await Promise.all([
      fetch(`/api/proposals?lead_id=${leadId}`),
      fetch(`/api/invoices?lead_id=${leadId}`),
      fetch(`/api/leads/${leadId}`),
    ]);

    if (proposalsRes.ok) {
      const json = await proposalsRes.json();
      setProposals(json.data || []);
    }
    if (invoicesRes.ok) {
      const json = await invoicesRes.json();
      setInvoices(json.data || []);
    }
    if (leadRes.ok) {
      const json = await leadRes.json();
      setLead(json.data || null);
    }
    setLoading(false);
  }, [leadId]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleSuccess = () => {
    fetchData();
  };

  // ── Download Proposal PDF ──
  const handleDownloadProposalPDF = async (p: Proposal) => {
    const [{ generateProposalPDF }, sqRes] = await Promise.all([
      import("@/lib/pdf-generator"),
      fetch(`/api/proposals/${p.id}/service-quotas`).then((r) => r.ok ? r.json() : { data: [] }),
    ]);
    const doc = generateProposalPDF(p, lead || undefined, undefined, undefined, sqRes.data ?? []);
    doc.save(`${p.proposal_number}.pdf`);
  };

  // ── Download Invoice PDF ──
  const handleDownloadInvoicePDF = async (inv: ProformaInvoice) => {
    const { generateInvoicePDF } = await import("@/lib/pdf-generator");
    const doc = generateInvoicePDF(inv, lead || undefined);
    doc.save(`${inv.invoice_number}.pdf`);
  };

  // ── Email Proposal ──
  const handleEmailProposal = (p: Proposal) => {
    setEmailConfig({
      type: "proposal",
      id: p.id,
      number: p.proposal_number,
      leadEmail: lead?.email || undefined,
      leadPhone: lead?.phone || lead?.mobile || undefined,
      generatePDF: async () => {
        const [{ generateProposalPDF }, sqRes] = await Promise.all([
          import("@/lib/pdf-generator"),
          fetch(`/api/proposals/${p.id}/service-quotas`).then((r) => r.ok ? r.json() : { data: [] }),
        ]);
        const doc = generateProposalPDF(p, lead || undefined, undefined, undefined, sqRes.data ?? []);
        return doc.output("datauristring").split(",")[1];
      },
    });
    setEmailDialogOpen(true);
  };

  // ── Email Invoice ──
  const handleEmailInvoice = (inv: ProformaInvoice) => {
    setEmailConfig({
      type: "invoice",
      id: inv.id,
      number: inv.invoice_number,
      leadEmail: lead?.email || undefined,
      leadPhone: lead?.phone || lead?.mobile || undefined,
      defaultCc: lead?.billing_emails || undefined,
      generatePDF: async () => {
        const { generateInvoicePDF } = await import("@/lib/pdf-generator");
        const doc = generateInvoicePDF(inv, lead || undefined);
        return doc.output("datauristring").split(",")[1];
      },
    });
    setEmailDialogOpen(true);
  };

  // ── Update Proposal Status ──
  const handleUpdateProposalStatus = async (
    proposalId: string,
    status: string,
    label: string,
    rejectionReason?: string
  ) => {
    const now = new Date().toISOString();
    const body: Record<string, unknown> = { status };

    // Set timestamp fields based on status
    if (status === "sent") body.sent_at = now;
    if (status === "viewed") body.viewed_at = now;
    if (status === "accepted") body.accepted_at = now;
    if (status === "rejected") {
      body.rejected_at = now;
      if (rejectionReason) body.rejection_reason = rejectionReason;
    }

    const res = await fetch(`/api/proposals/${proposalId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (res.ok) {
      toast.success(`Proposal marked as ${label}`);
      fetchData();
    } else {
      const err = await res.json().catch(() => null);
      toast.error(err?.error || `Failed to update proposal status`);
    }
  };

  // ── Update Invoice Status ──
  const handleUpdateInvoiceStatus = async (
    invoiceId: string,
    status: string,
    label: string
  ) => {
    const now = new Date().toISOString();
    const body: Record<string, unknown> = { status };
    if (status === "paid") body.paid_at = now;

    const res = await fetch(`/api/invoices/${invoiceId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (res.ok) {
      toast.success(`Invoice marked as ${label}`);
      fetchData();
    } else {
      const err = await res.json().catch(() => null);
      toast.error(err?.error || `Failed to update invoice status`);
    }
  };

  // ── Mark Invoice Paid + Send GST Invoice ──
  const handleMarkInvoicePaid = async (inv: ProformaInvoice) => {
    const ref = window.prompt(
      `Enter payment reference / UTR for ${inv.invoice_number} (optional):`
    );
    if (ref === null) return; // cancelled

    const amount = window.prompt(
      `Confirm amount received (₹):`,
      String(Number(inv.total_amount))
    );
    if (!amount) return;

    const res = await fetch(`/api/invoices/${inv.id}/payment`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amount: parseFloat(amount), reference: ref.trim() || undefined }),
    });
    const json = await res.json();
    if (res.ok) {
      toast.success(
        json.customer_email
          ? `Payment recorded. Confirmation sent to ${json.customer_email} — GST invoice will follow from accounts.`
          : "Invoice marked as paid — routed to accounts for GST invoice issuance."
      );
      fetchData();
    } else {
      toast.error(json.error || "Failed to record payment");
    }
  };

  // ── Cancel Invoice ──
  const handleCancelInvoice = async (inv: ProformaInvoice) => {
    if (!window.confirm(`Cancel invoice ${inv.invoice_number}? This cannot be undone.`)) return;
    const reason = window.prompt("Reason for cancelling (optional):") || undefined;

    const res = await fetch(`/api/invoices/${inv.id}/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason }),
    });
    const json = await res.json();
    if (res.ok) {
      toast.success(`Invoice ${inv.invoice_number} cancelled`);
      fetchData();
    } else {
      toast.error(json.error || "Failed to cancel invoice");
    }
  };

  if (loading) {
    return <TableSkeleton rows={4} />;
  }

  return (
    <div className="space-y-6">
      {/* Proposals Section */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-base">Proposals</CardTitle>
          <Button size="sm" onClick={() => setProposalFormOpen(true)}>
            <Plus className="mr-2 h-4 w-4" />
            New Proposal
          </Button>
        </CardHeader>
        <CardContent>
          {proposals.length === 0 ? (
            <EmptyState
              icon={FileText}
              title="No proposals yet"
              description="Create a proposal for this lead."
              actionLabel="Create Proposal"
              onAction={() => setProposalFormOpen(true)}
            />
          ) : (
            <div className="rounded-md border overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/50">
                    <th className="px-4 py-3 text-left font-medium">Proposal #</th>
                    <th className="px-4 py-3 text-left font-medium">Title</th>
                    <th className="px-4 py-3 text-left font-medium">Status</th>
                    <th className="px-4 py-3 text-left font-medium hidden sm:table-cell">Opened</th>
                    <th className="px-4 py-3 text-right font-medium">Amount</th>
                    <th className="px-4 py-3 text-left font-medium hidden md:table-cell">Created</th>
                    <th className="px-4 py-3 text-left font-medium w-16">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {proposals.map((p) => (
                    <tr key={p.id} className="border-b hover:bg-muted/30 transition-colors cursor-pointer" onClick={() => router.push(`/proposals/${p.id}`)}>
                      <td className="px-4 py-3 font-mono text-xs">{p.proposal_number}</td>
                      <td className="px-4 py-3 font-medium">{p.title}</td>
                      <td className="px-4 py-3">
                        <Badge variant="secondary" className={PROPOSAL_STATUS_COLORS[p.status]}>
                          {PROPOSAL_STATUS_LABELS[p.status]}
                        </Badge>
                      </td>
                      <td className="px-4 py-3 hidden sm:table-cell">
                        {p.viewed_at ? (
                          <span className="inline-flex items-center gap-1 text-xs text-green-700 font-medium">
                            <CheckCircle2 className="h-3 w-3" />
                            {formatDate(p.viewed_at)}
                          </span>
                        ) : p.status === "sent" ? (
                          <span className="text-xs text-muted-foreground">Not yet opened</span>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right font-medium">
                        {formatCurrency(p.total_amount)}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground hidden md:table-cell">
                        {formatDate(p.created_at)}
                      </td>
                      <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon">
                              <MoreHorizontal className="h-4 w-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onClick={() => router.push(`/proposals/${p.id}`)}>
                              <Eye className="mr-2 h-4 w-4" />
                              View
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem onClick={() => handleDownloadProposalPDF(p)}>
                              <Download className="mr-2 h-4 w-4" />
                              Download PDF
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => handleEmailProposal(p)}>
                              <Mail className="mr-2 h-4 w-4" />
                              Email to Lead
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            {/* Status transition actions */}
                            {p.status === "draft" && (
                              <DropdownMenuItem onClick={() => handleUpdateProposalStatus(p.id, "sent", "Sent")}>
                                <Send className="mr-2 h-4 w-4" />
                                Mark as Sent
                              </DropdownMenuItem>
                            )}
                            {p.status === "sent" && (
                              <DropdownMenuItem disabled className="text-xs text-muted-foreground opacity-60 cursor-default select-none">
                                <Eye className="mr-2 h-3.5 w-3.5" />
                                {p.viewed_at ? `Opened ${formatDate(p.viewed_at)}` : "Opens when customer clicks email link"}
                              </DropdownMenuItem>
                            )}
                            {(p.status === "sent" || p.status === "viewed") && (
                              <>
                                <DropdownMenuItem
                                  onClick={() => handleUpdateProposalStatus(p.id, "accepted", "Accepted")}
                                  className="text-green-600"
                                >
                                  <CheckCircle2 className="mr-2 h-4 w-4" />
                                  Accept Proposal
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  onClick={() => {
                                    const reason = window.prompt("Please enter the reason for rejection:");
                                    if (reason === null) return;
                                    if (!reason.trim()) {
                                      toast.error("Rejection reason is required");
                                      return;
                                    }
                                    handleUpdateProposalStatus(p.id, "rejected", "Rejected", reason.trim());
                                  }}
                                  className="text-red-600"
                                >
                                  <XCircle className="mr-2 h-4 w-4" />
                                  Reject Proposal
                                </DropdownMenuItem>
                              </>
                            )}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Invoices Section */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle className="text-base">Ad-Hoc Proforma Invoice</CardTitle>
            <p className="text-xs text-muted-foreground mt-0.5">
              For unlisted ad-hoc charges only — e.g. interest, breakage, repair, or recovery of any
              charges paid on the customer&apos;s behalf. Not for security deposit or monthly rentals.
            </p>
          </div>
          <Button size="sm" onClick={() => setInvoiceFormOpen(true)}>
            <Plus className="mr-2 h-4 w-4" />
            New Invoice
          </Button>
        </CardHeader>
        <CardContent>
          {invoices.length === 0 ? (
            <EmptyState
              icon={Receipt}
              title="No invoices yet"
              description="Create an invoice for this lead."
              actionLabel="Create Invoice"
              onAction={() => setInvoiceFormOpen(true)}
            />
          ) : (
            <div className="rounded-md border overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/50">
                    <th className="px-4 py-3 text-left font-medium">Invoice #</th>
                    <th className="px-4 py-3 text-left font-medium">Title</th>
                    <th className="px-4 py-3 text-left font-medium">Status</th>
                    <th className="px-4 py-3 text-right font-medium">Amount</th>
                    <th className="px-4 py-3 text-left font-medium hidden md:table-cell">Pay Link / Reference</th>
                    <th className="px-4 py-3 text-left font-medium w-16">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {invoices.map((inv) => (
                    <tr key={inv.id} className="border-b hover:bg-muted/30 transition-colors">
                      <td className="px-4 py-3 font-mono text-xs">{inv.invoice_number}</td>
                      <td className="px-4 py-3 font-medium">{inv.title}</td>
                      <td className="px-4 py-3">
                        <Badge variant="secondary" className={INVOICE_STATUS_COLORS[inv.status]}>
                          {INVOICE_STATUS_LABELS[inv.status]}
                        </Badge>
                      </td>
                      <td className="px-4 py-3 text-right font-medium">
                        {formatCurrency(inv.total_amount)}
                      </td>
                      {/* Pay Link / Reference column */}
                      <td className="px-4 py-3 hidden md:table-cell">
                        {inv.status === "paid" ? (
                          <div className="space-y-0.5">
                            {inv.payment_reference && (
                              <p className="text-xs font-mono text-green-700">{inv.payment_reference}</p>
                            )}
                            {inv.gst_invoice_number && (
                              <p className="text-xs text-muted-foreground">GST: {inv.gst_invoice_number}</p>
                            )}
                          </div>
                        ) : inv.razorpay_link_url ? (
                          <button
                            type="button"
                            className="flex items-center gap-1 text-xs text-primary hover:underline"
                            onClick={() => {
                              navigator.clipboard.writeText(inv.razorpay_link_url!);
                              toast.success("Payment link copied");
                            }}
                          >
                            <Copy className="h-3 w-3" />
                            Copy link
                          </button>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon">
                              <MoreHorizontal className="h-4 w-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onClick={() => setViewInvoice(inv)}>
                              <Eye className="mr-2 h-4 w-4" />
                              View
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem onClick={() => handleDownloadInvoicePDF(inv)}>
                              <Download className="mr-2 h-4 w-4" />
                              Download PDF
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => handleEmailInvoice(inv)}>
                              <Mail className="mr-2 h-4 w-4" />
                              Email to Lead
                            </DropdownMenuItem>
                            {inv.razorpay_link_url && inv.status !== "paid" && (
                              <DropdownMenuItem onClick={() => { navigator.clipboard.writeText(inv.razorpay_link_url!); toast.success("Payment link copied"); }}>
                                <CreditCard className="mr-2 h-4 w-4" />
                                Copy Payment Link
                              </DropdownMenuItem>
                            )}
                            <DropdownMenuSeparator />
                            {inv.status === "draft" && (
                              <DropdownMenuItem onClick={() => handleUpdateInvoiceStatus(inv.id, "sent", "Sent")}>
                                <Send className="mr-2 h-4 w-4" />
                                Mark as Sent
                              </DropdownMenuItem>
                            )}
                            {(inv.status === "sent" || inv.status === "overdue") && (
                              <DropdownMenuItem
                                onClick={() => handleMarkInvoicePaid(inv)}
                                className="text-green-600"
                              >
                                <CheckCircle2 className="mr-2 h-4 w-4" />
                                Mark Paid
                              </DropdownMenuItem>
                            )}
                            {inv.status === "sent" && (
                              <DropdownMenuItem
                                onClick={() => handleUpdateInvoiceStatus(inv.id, "overdue", "Overdue")}
                                className="text-red-600"
                              >
                                <XCircle className="mr-2 h-4 w-4" />
                                Mark as Overdue
                              </DropdownMenuItem>
                            )}
                            {["draft", "sent", "overdue"].includes(inv.status) && (
                              <DropdownMenuItem
                                onClick={() => handleCancelInvoice(inv)}
                                className="text-red-600"
                              >
                                <Ban className="mr-2 h-4 w-4" />
                                Cancel Invoice
                              </DropdownMenuItem>
                            )}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Dialogs */}
      <ProposalForm
        leadId={leadId}
        leadLocationId={leadLocationId}
        open={proposalFormOpen}
        onOpenChange={setProposalFormOpen}
        onSuccess={handleSuccess}
      />
      <InvoiceForm
        leadId={leadId}
        open={invoiceFormOpen}
        onOpenChange={setInvoiceFormOpen}
        onSuccess={handleSuccess}
        hasActiveProposal={!!activeProposal}
        activeProposalId={activeProposal?.id}
        onRequestProposal={() => {
          setInvoiceFormOpen(false);
          setProposalFormOpen(true);
        }}
      />

      {/* Email Dialog */}
      {emailConfig && (
        <EmailDocumentDialog
          open={emailDialogOpen}
          onOpenChange={setEmailDialogOpen}
          documentType={emailConfig.type}
          documentId={emailConfig.id}
          documentNumber={emailConfig.number}
          leadEmail={emailConfig.leadEmail}
          leadPhone={emailConfig.leadPhone}
          defaultCc={emailConfig.defaultCc}
          onGeneratePDF={emailConfig.generatePDF}
          onSuccess={handleSuccess}
        />
      )}

      {/* View Invoice Dialog */}
      <Dialog open={!!viewInvoice} onOpenChange={(open) => { if (!open) setViewInvoice(null); }}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          {viewInvoice && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  {viewInvoice.invoice_number}
                  <Badge variant="secondary" className={INVOICE_STATUS_COLORS[viewInvoice.status]}>
                    {INVOICE_STATUS_LABELS[viewInvoice.status]}
                  </Badge>
                </DialogTitle>
                <DialogDescription>{viewInvoice.title}</DialogDescription>
              </DialogHeader>

              <div className="space-y-4">
                <div className="rounded-md border overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b bg-muted/50">
                        <th className="px-3 py-2 text-left font-medium">Description</th>
                        <th className="px-3 py-2 text-right font-medium">Qty</th>
                        <th className="px-3 py-2 text-right font-medium">Unit Price</th>
                        <th className="px-3 py-2 text-right font-medium">Total</th>
                      </tr>
                    </thead>
                    <tbody>
                      {viewInvoice.items.map((item, idx) => (
                        <tr key={idx} className="border-b last:border-0">
                          <td className="px-3 py-2">{item.description}</td>
                          <td className="px-3 py-2 text-right">{item.quantity}{item.unit ? ` ${item.unit}` : ""}</td>
                          <td className="px-3 py-2 text-right">{formatCurrency(item.unit_price)}</td>
                          <td className="px-3 py-2 text-right font-medium">{formatCurrency(item.total)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <div className="flex flex-col items-end gap-1 text-sm">
                  <div className="flex justify-between w-48"><span className="text-muted-foreground">Subtotal</span><span>{formatCurrency(viewInvoice.subtotal)}</span></div>
                  <div className="flex justify-between w-48"><span className="text-muted-foreground">Tax ({viewInvoice.tax_percentage}%)</span><span>{formatCurrency(viewInvoice.tax_amount)}</span></div>
                  <div className="flex justify-between w-48"><span className="text-muted-foreground">Discount ({viewInvoice.discount_percentage}%)</span><span>-{formatCurrency(viewInvoice.discount_amount)}</span></div>
                  <div className="flex justify-between w-48 font-semibold border-t pt-1"><span>Total</span><span>{formatCurrency(viewInvoice.total_amount)}</span></div>
                </div>

                {viewInvoice.due_date && (
                  <p className="text-sm"><span className="text-muted-foreground">Due Date:</span> {formatDate(viewInvoice.due_date)}</p>
                )}

                <div className="space-y-1">
                  <p className="text-xs font-medium text-muted-foreground">Accounting Head</p>
                  {viewInvoice.primary_head ? (
                    <Badge variant="outline" className={ACCOUNTING_HEAD_COLORS[viewInvoice.primary_head as AccountingHead]}>
                      {ACCOUNTING_HEAD_LABELS[viewInvoice.primary_head as AccountingHead] || viewInvoice.primary_head}
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="bg-amber-50 text-amber-800 border-amber-200">Needs Review</Badge>
                  )}
                </div>

                {viewInvoice.internal_notes && (
                  <div className="space-y-1 rounded-md border border-amber-200 bg-amber-50 px-3 py-2">
                    <p className="text-xs font-medium text-amber-800">Internal Note (for Accounts) — never shown to the customer</p>
                    <p className="text-sm text-amber-900">{viewInvoice.internal_notes}</p>
                  </div>
                )}

                {viewInvoice.notes && (
                  <div className="space-y-1">
                    <p className="text-xs font-medium text-muted-foreground">Customer-Facing Notes</p>
                    <p className="text-sm">{viewInvoice.notes}</p>
                  </div>
                )}
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
