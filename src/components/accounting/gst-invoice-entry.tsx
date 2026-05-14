"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Download, Mail, Loader2, Check, AlertCircle, FileCheck } from "lucide-react";
import { toast } from "sonner";
import { formatCurrency, formatDate } from "@/lib/utils";
import { GstInvoiceEmailDialog } from "./gst-invoice-email-dialog";

interface GstEntry {
  contract_id: string;
  contract_number: string;
  company: string;
  lead_email?: string;
  lead_secondary_email?: string;
  lead_phone?: string;
  total_billable: number;
  total_paid: number;
  // Payment-side (legacy upload)
  payment_id: string | null;
  // Statement-side (system generate flow)
  billing_statement_id: string | null;
  billing_statement_status: string | null;
  // Resolved GST info (from whichever source has data)
  gst_source: "statement" | "payment" | null;
  gst_invoice_number: string | null;
  gst_invoice_path: string | null;
  gst_invoice_status: string | null;
  gst_invoice_sent_at: string | null;
  gst_invoice_sent_to: string | null;
}

interface GstInvoiceEntryProps {
  entries: GstEntry[];
  onRefresh: () => void;
}

export function GstInvoiceEntry({ entries, onRefresh }: GstInvoiceEntryProps) {
  const [downloading, setDownloading] = useState<string | null>(null);
  const [generating, setGenerating] = useState<string | null>(null);
  const [emailDialogEntry, setEmailDialogEntry] = useState<GstEntry | null>(null);

  // Download uses different endpoints depending on where the PDF is stored.
  const handleDownload = async (entry: GstEntry) => {
    const contractId = entry.contract_id;
    setDownloading(contractId);
    try {
      // Statement-generated PDFs → billing-statements endpoint
      // Legacy upload PDFs → contract-payments endpoint
      const url = entry.gst_source === "statement" && entry.billing_statement_id
        ? `/api/billing-statements/${entry.billing_statement_id}/gst-invoice-pdf`
        : `/api/accounting/gst-invoices/${entry.payment_id}/download`;

      const res = await fetch(url);
      if (!res.ok) {
        toast.error("Failed to get download URL");
        return;
      }
      const { data } = await res.json();
      window.open(data.download_url, "_blank");
    } catch {
      toast.error("Network error");
    } finally {
      setDownloading(null);
    }
  };

  // Generate GST invoice for a finalized billing statement (manual payment flow).
  const handleGenerate = async (entry: GstEntry) => {
    if (!entry.billing_statement_id) return;
    setGenerating(entry.contract_id);
    try {
      const res = await fetch(`/api/billing-statements/${entry.billing_statement_id}/generate-gst-invoice`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const json = await res.json();
      if (res.ok) {
        toast.success(
          json.emailedTo
            ? `GST invoice ${json.invoiceNumber} generated & sent to ${json.emailedTo}`
            : `GST invoice ${json.invoiceNumber} generated`
        );
        onRefresh();
      } else {
        toast.error(json.error || "Failed to generate GST invoice");
      }
    } catch {
      toast.error("Network error");
    } finally {
      setGenerating(null);
    }
  };

  const getStatusBadge = (entry: GstEntry) => {
    if (entry.gst_invoice_status === "sent") {
      return (
        <Badge className="bg-green-100 text-green-800 border-green-200">
          <Check className="h-3 w-3 mr-1" />
          Sent{entry.gst_invoice_sent_at ? ` on ${formatDate(entry.gst_invoice_sent_at)}` : ""}
        </Badge>
      );
    }
    if (entry.gst_invoice_status === "invoiced") {
      return <Badge className="bg-blue-100 text-blue-800 border-blue-200">Generated</Badge>;
    }
    // Billing statement is finalized — ready to generate
    if (entry.billing_statement_id && entry.billing_statement_status !== "draft") {
      return (
        <Badge variant="outline" className="text-amber-700 border-amber-300 bg-amber-50">
          <AlertCircle className="h-3 w-3 mr-1" />
          Ready to Issue
        </Badge>
      );
    }
    // Statement not finalized yet
    if (entry.billing_statement_id && entry.billing_statement_status === "draft") {
      return (
        <Badge variant="outline" className="text-muted-foreground">
          Finalize Bill First
        </Badge>
      );
    }
    return <Badge variant="outline" className="text-muted-foreground">No Statement</Badge>;
  };

  if (entries.length === 0) {
    return (
      <p className="text-sm text-muted-foreground py-4 text-center">
        No active contracts this period
      </p>
    );
  }

  const readyToIssue = entries.filter(
    (e) => !e.gst_invoice_number && e.billing_statement_id && e.billing_statement_status !== "draft"
  );

  return (
    <>
      {readyToIssue.length > 0 && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 mb-4 flex items-start gap-2">
          <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
          <span>
            <strong>{readyToIssue.length} contract{readyToIssue.length > 1 ? "s" : ""}</strong>{" "}
            {readyToIssue.length > 1 ? "have" : "has"} a finalized statement but no GST invoice
            issued yet. Use the <strong>Generate</strong> button to create and send the official
            tax invoice. For online payments (Razorpay), this happens automatically.
          </span>
        </div>
      )}

      <div className="border rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr>
              <th className="text-left px-3 py-2 font-medium">Contract</th>
              <th className="text-left px-3 py-2 font-medium">Company</th>
              <th className="text-right px-3 py-2 font-medium hidden sm:table-cell">Billable</th>
              <th className="text-right px-3 py-2 font-medium hidden sm:table-cell">Collected</th>
              <th className="text-left px-3 py-2 font-medium">Invoice #</th>
              <th className="text-left px-3 py-2 font-medium">Status</th>
              <th className="text-center px-3 py-2 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {entries.map((entry) => {
              const canGenerate =
                !entry.gst_invoice_number &&
                !!entry.billing_statement_id &&
                entry.billing_statement_status !== "draft" &&
                entry.billing_statement_status !== null;
              const hasPdf = !!entry.gst_invoice_path;

              return (
                <tr key={entry.contract_id} className="hover:bg-accent/50">
                  <td className="px-3 py-2 font-medium">{entry.contract_number}</td>
                  <td className="px-3 py-2">{entry.company}</td>
                  <td className="px-3 py-2 text-right hidden sm:table-cell text-muted-foreground">
                    {formatCurrency(entry.total_billable)}
                  </td>
                  <td className="px-3 py-2 text-right hidden sm:table-cell font-medium">
                    {entry.total_paid > 0
                      ? formatCurrency(entry.total_paid)
                      : <span className="text-muted-foreground">—</span>}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs">
                    {entry.gst_invoice_number ?? <span className="text-muted-foreground">—</span>}
                  </td>
                  <td className="px-3 py-2">{getStatusBadge(entry)}</td>
                  <td className="px-3 py-2">
                    <div className="flex items-center justify-center gap-1">
                      {/* Generate GST invoice — for finalized statements with no invoice yet */}
                      {canGenerate && (
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7 text-xs gap-1"
                          title="Generate & send GST invoice"
                          onClick={() => handleGenerate(entry)}
                          disabled={generating === entry.contract_id}
                        >
                          {generating === entry.contract_id ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : (
                            <FileCheck className="h-3 w-3" />
                          )}
                          Generate
                        </Button>
                      )}

                      {/* Download PDF — available when a system-generated PDF exists */}
                      {hasPdf && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          title="Download GST invoice PDF"
                          onClick={() => handleDownload(entry)}
                          disabled={downloading === entry.contract_id}
                        >
                          {downloading === entry.contract_id ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <Download className="h-3.5 w-3.5" />
                          )}
                        </Button>
                      )}

                      {/* Re-send email — only when a PDF exists */}
                      {hasPdf && (entry.payment_id || entry.billing_statement_id) && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          title="Re-send GST invoice by email"
                          onClick={() => setEmailDialogEntry(entry)}
                        >
                          <Mail className="h-3.5 w-3.5" />
                        </Button>
                      )}

                      {/* Nothing yet */}
                      {!canGenerate && !hasPdf && (
                        <span className="text-xs text-muted-foreground px-1">—</span>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {emailDialogEntry && (
        <GstInvoiceEmailDialog
          open={!!emailDialogEntry}
          onOpenChange={(open) => !open && setEmailDialogEntry(null)}
          paymentId={emailDialogEntry.payment_id!}
          contractNumber={emailDialogEntry.contract_number}
          company={emailDialogEntry.company}
          leadEmail={emailDialogEntry.lead_email}
          leadSecondaryEmail={emailDialogEntry.lead_secondary_email}
          leadPhone={emailDialogEntry.lead_phone}
          onSuccess={onRefresh}
        />
      )}
    </>
  );
}
