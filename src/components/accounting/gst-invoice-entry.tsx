"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Download, Mail, Loader2, Check, AlertCircle } from "lucide-react";
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
  payment_id: string | null;
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
  const [emailDialogEntry, setEmailDialogEntry] = useState<GstEntry | null>(null);

  const handleDownload = async (entry: GstEntry) => {
    if (!entry.payment_id) return;
    setDownloading(entry.contract_id);
    try {
      const res = await fetch(`/api/accounting/gst-invoices/${entry.payment_id}/download`);
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
    if (entry.total_paid > 0) {
      return (
        <Badge variant="outline" className="text-amber-700 border-amber-300 bg-amber-50">
          <AlertCircle className="h-3 w-3 mr-1" />
          Pending
        </Badge>
      );
    }
    return <Badge variant="outline" className="text-muted-foreground">Awaiting Payment</Badge>;
  };

  if (entries.length === 0) {
    return (
      <p className="text-sm text-muted-foreground py-4 text-center">
        No active contracts this period
      </p>
    );
  }

  // Separate into rows that need attention (paid but no invoice) vs done
  const pendingRows = entries.filter((e) => e.total_paid > 0 && !e.gst_invoice_number);

  return (
    <>
      {pendingRows.length > 0 && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 mb-4 flex items-start gap-2">
          <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
          <span>
            <strong>{pendingRows.length} contract{pendingRows.length > 1 ? "s" : ""}</strong> {pendingRows.length > 1 ? "have" : "has"} payment recorded but no GST invoice issued yet.
            Go to the <strong>Statements</strong> tab, open the contract row, and choose{" "}
            <strong>Generate &amp; Send GST Invoice</strong> from the actions menu.
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
            {entries.map((entry) => (
              <tr key={entry.contract_id} className="hover:bg-accent/50">
                <td className="px-3 py-2 font-medium">{entry.contract_number}</td>
                <td className="px-3 py-2">{entry.company}</td>
                <td className="px-3 py-2 text-right hidden sm:table-cell text-muted-foreground">
                  {formatCurrency(entry.total_billable)}
                </td>
                <td className="px-3 py-2 text-right hidden sm:table-cell font-medium">
                  {entry.total_paid > 0 ? formatCurrency(entry.total_paid) : <span className="text-muted-foreground">—</span>}
                </td>
                <td className="px-3 py-2 font-mono text-xs">
                  {entry.gst_invoice_number ?? <span className="text-muted-foreground">—</span>}
                </td>
                <td className="px-3 py-2">{getStatusBadge(entry)}</td>
                <td className="px-3 py-2">
                  <div className="flex items-center justify-center gap-1">
                    {/* Download — only available when a PDF is stored */}
                    {entry.gst_invoice_path && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        title="Download GST invoice"
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
                    {entry.gst_invoice_path && (
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

                    {/* No actions when no PDF yet */}
                    {!entry.gst_invoice_path && (
                      <span className="text-xs text-muted-foreground px-1">—</span>
                    )}
                  </div>
                </td>
              </tr>
            ))}
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
