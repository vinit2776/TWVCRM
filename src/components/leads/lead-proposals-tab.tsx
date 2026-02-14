"use client";

import { useState, useEffect, useCallback } from "react";
import { Plus, FileText, Receipt } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/shared/empty-state";
import { TableSkeleton } from "@/components/shared/loading-skeleton";
import { ProposalForm } from "@/components/proposals/proposal-form";
import { InvoiceForm } from "@/components/invoices/invoice-form";
import {
  PROPOSAL_STATUS_LABELS,
  INVOICE_STATUS_LABELS,
} from "@/lib/constants";
import { formatDate, formatCurrency } from "@/lib/utils";
import type { Proposal, ProformaInvoice } from "@/types";

const PROPOSAL_STATUS_COLORS: Record<string, string> = {
  draft: "bg-gray-100 text-gray-800",
  sent: "bg-blue-100 text-blue-800",
  viewed: "bg-purple-100 text-purple-800",
  accepted: "bg-green-100 text-green-800",
  rejected: "bg-red-100 text-red-800",
  expired: "bg-orange-100 text-orange-800",
};

const INVOICE_STATUS_COLORS: Record<string, string> = {
  draft: "bg-gray-100 text-gray-800",
  sent: "bg-blue-100 text-blue-800",
  paid: "bg-green-100 text-green-800",
  overdue: "bg-red-100 text-red-800",
  cancelled: "bg-orange-100 text-orange-800",
};

interface LeadProposalsTabProps {
  leadId: string;
}

export function LeadProposalsTab({ leadId }: LeadProposalsTabProps) {
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [invoices, setInvoices] = useState<ProformaInvoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [proposalFormOpen, setProposalFormOpen] = useState(false);
  const [invoiceFormOpen, setInvoiceFormOpen] = useState(false);

  const fetchData = useCallback(async () => {
    setLoading(true);
    const [proposalsRes, invoicesRes] = await Promise.all([
      fetch(`/api/proposals?lead_id=${leadId}`),
      fetch(`/api/invoices?lead_id=${leadId}`),
    ]);

    if (proposalsRes.ok) {
      const json = await proposalsRes.json();
      setProposals(json.data || []);
    }
    if (invoicesRes.ok) {
      const json = await invoicesRes.json();
      setInvoices(json.data || []);
    }
    setLoading(false);
  }, [leadId]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleSuccess = () => {
    fetchData();
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
                  </tr>
                </thead>
                <tbody>
                  {proposals.map((p) => (
                    <tr key={p.id} className="border-b hover:bg-muted/30 transition-colors">
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
    </div>
  );
}
