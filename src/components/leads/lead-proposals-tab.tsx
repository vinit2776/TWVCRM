"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Plus, FileText, Receipt, MoreHorizontal, Download, Mail, Send, CheckCircle2, XCircle, Eye } from "lucide-react";
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
  PROPOSAL_STATUS_LABELS,
  PROPOSAL_STATUS_COLORS,
  INVOICE_STATUS_LABELS,
} from "@/lib/constants";
import { formatDate, formatCurrency } from "@/lib/utils";
import { generateProposalPDF, generateInvoicePDF } from "@/lib/pdf-generator";
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

  // Email dialog state
  const [emailDialogOpen, setEmailDialogOpen] = useState(false);
  const [emailConfig, setEmailConfig] = useState<{
    type: "proposal" | "invoice";
    id: string;
    number: string;
    leadEmail?: string;
    generatePDF: () => string;
  } | null>(null);

  // Lead info for PDF generation
  const [lead, setLead] = useState<Lead | null>(null);

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
  const handleDownloadProposalPDF = (p: Proposal) => {
    const doc = generateProposalPDF(p, lead || undefined);
    doc.save(`${p.proposal_number}.pdf`);
  };

  // ── Download Invoice PDF ──
  const handleDownloadInvoicePDF = (inv: ProformaInvoice) => {
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
      generatePDF: () => {
        const doc = generateProposalPDF(p, lead || undefined);
        // Get base64 without data URI prefix
        const base64 = doc.output("datauristring").split(",")[1];
        return base64;
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
      generatePDF: () => {
        const doc = generateInvoicePDF(inv, lead || undefined);
        const base64 = doc.output("datauristring").split(",")[1];
        return base64;
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
                            {(p.status === "sent") && (
                              <DropdownMenuItem onClick={() => handleUpdateProposalStatus(p.id, "viewed", "Viewed")}>
                                <Eye className="mr-2 h-4 w-4" />
                                Mark as Viewed
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
          <CardTitle className="text-base">Proforma Invoices</CardTitle>
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
                    <th className="px-4 py-3 text-left font-medium hidden md:table-cell">Due Date</th>
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
                      <td className="px-4 py-3 text-muted-foreground hidden md:table-cell">
                        {inv.due_date ? formatDate(inv.due_date) : "-"}
                      </td>
                      <td className="px-4 py-3">
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon">
                              <MoreHorizontal className="h-4 w-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onClick={() => handleDownloadInvoicePDF(inv)}>
                              <Download className="mr-2 h-4 w-4" />
                              Download PDF
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => handleEmailInvoice(inv)}>
                              <Mail className="mr-2 h-4 w-4" />
                              Email to Lead
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            {inv.status === "draft" && (
                              <DropdownMenuItem onClick={() => handleUpdateInvoiceStatus(inv.id, "sent", "Sent")}>
                                <Send className="mr-2 h-4 w-4" />
                                Mark as Sent
                              </DropdownMenuItem>
                            )}
                            {(inv.status === "sent" || inv.status === "overdue") && (
                              <DropdownMenuItem
                                onClick={() => handleUpdateInvoiceStatus(inv.id, "paid", "Paid")}
                                className="text-green-600"
                              >
                                <CheckCircle2 className="mr-2 h-4 w-4" />
                                Mark as Paid
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
          onGeneratePDF={emailConfig.generatePDF}
          onSuccess={handleSuccess}
        />
      )}
    </div>
  );
}
