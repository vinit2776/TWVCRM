"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Upload, Download, Mail, Loader2, Check, Save } from "lucide-react";
import { toast } from "sonner";
import { prepareUpload, UploadTooLargeError } from "@/lib/uploads/upload-gate";
import { formatCurrency, formatDate } from "@/lib/utils";
import { GstInvoiceEmailDialog } from "./gst-invoice-email-dialog";

interface GstEntry {
  contract_id: string;
  contract_number: string;
  company: string;
  lead_email?: string;
  lead_secondary_email?: string;
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
  const [uploading, setUploading] = useState<string | null>(null);
  const [downloading, setDownloading] = useState<string | null>(null);
  const [editingInvoiceNo, setEditingInvoiceNo] = useState<Record<string, string>>({});
  const [savingInvoiceNo, setSavingInvoiceNo] = useState<string | null>(null);
  const [emailDialogEntry, setEmailDialogEntry] = useState<GstEntry | null>(null);

  const handleUpload = async (entry: GstEntry, raw: File) => {
    if (!entry.payment_id) {
      toast.error("No payment found for this contract. Record a payment first.");
      return;
    }
    setUploading(entry.contract_id);
    try {
      // Normalize before sending: PDFs → stripped, images → JPEG 2048px.
      const file = await prepareUpload(raw);
      if (!file) return;

      const formData = new FormData();
      formData.append("file", file);

      const res = await fetch(`/api/accounting/gst-invoices/${entry.payment_id}/upload`, {
        method: "POST",
        body: formData,
      });

      if (!res.ok) {
        const err = await res.json();
        toast.error(err.error || "Upload failed");
        return;
      }

      toast.success("GST invoice uploaded");
      onRefresh();
    } catch (e) {
      if (e instanceof UploadTooLargeError) {
        toast.error(e.message);
      } else {
        toast.error(e instanceof Error ? e.message : "Network error");
      }
    } finally {
      setUploading(null);
    }
  };

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

  const handleSaveInvoiceNumber = async (entry: GstEntry) => {
    if (!entry.payment_id) return;
    const value = editingInvoiceNo[entry.contract_id];
    if (!value) return;

    setSavingInvoiceNo(entry.contract_id);
    try {
      const res = await fetch(`/api/accounting/contract-payments/${entry.payment_id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ gst_invoice_number: value }),
      });

      if (!res.ok) {
        const err = await res.json();
        toast.error(err.error || "Failed to save");
        return;
      }

      toast.success("Invoice number saved");
      setEditingInvoiceNo((prev) => {
        const next = { ...prev };
        delete next[entry.contract_id];
        return next;
      });
      onRefresh();
    } catch {
      toast.error("Network error");
    } finally {
      setSavingInvoiceNo(null);
    }
  };

  const getStatusBadge = (entry: GstEntry) => {
    if (entry.gst_invoice_status === "sent") {
      return (
        <Badge className="bg-green-100 text-green-800 border-green-200">
          <Check className="h-3 w-3 mr-1" />
          Sent {entry.gst_invoice_sent_at && `on ${formatDate(entry.gst_invoice_sent_at)}`}
        </Badge>
      );
    }
    if (entry.gst_invoice_status === "invoiced") {
      return <Badge className="bg-blue-100 text-blue-800 border-blue-200">Invoiced</Badge>;
    }
    return <Badge variant="outline" className="text-muted-foreground">No Invoice</Badge>;
  };

  if (entries.length === 0) {
    return (
      <p className="text-sm text-muted-foreground py-4 text-center">
        No active contracts this period
      </p>
    );
  }

  return (
    <>
      <div className="border rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr>
              <th className="text-left px-3 py-2 font-medium">Contract</th>
              <th className="text-left px-3 py-2 font-medium">Company</th>
              <th className="text-right px-3 py-2 font-medium">Billable</th>
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
                <td className="px-3 py-2 text-right">{formatCurrency(entry.total_billable)}</td>
                <td className="px-3 py-2">
                  {entry.gst_invoice_number && !editingInvoiceNo[entry.contract_id] ? (
                    <span
                      className="cursor-pointer hover:underline"
                      onClick={() =>
                        setEditingInvoiceNo((prev) => ({
                          ...prev,
                          [entry.contract_id]: entry.gst_invoice_number || "",
                        }))
                      }
                    >
                      {entry.gst_invoice_number}
                    </span>
                  ) : (
                    <div className="flex items-center gap-1">
                      <Input
                        className="h-7 w-32 text-xs"
                        value={editingInvoiceNo[entry.contract_id] ?? entry.gst_invoice_number ?? ""}
                        onChange={(e) =>
                          setEditingInvoiceNo((prev) => ({
                            ...prev,
                            [entry.contract_id]: e.target.value,
                          }))
                        }
                        placeholder="Invoice #"
                      />
                      {editingInvoiceNo[entry.contract_id] !== undefined && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6"
                          onClick={() => handleSaveInvoiceNumber(entry)}
                          disabled={savingInvoiceNo === entry.contract_id}
                        >
                          {savingInvoiceNo === entry.contract_id ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : (
                            <Save className="h-3 w-3" />
                          )}
                        </Button>
                      )}
                    </div>
                  )}
                </td>
                <td className="px-3 py-2">{getStatusBadge(entry)}</td>
                <td className="px-3 py-2">
                  <div className="flex items-center justify-center gap-1">
                    {/* Upload */}
                    <label className="cursor-pointer">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        asChild
                        disabled={uploading === entry.contract_id}
                      >
                        <span>
                          {uploading === entry.contract_id ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <Upload className="h-3.5 w-3.5" />
                          )}
                        </span>
                      </Button>
                      <input
                        type="file"
                        accept=".pdf,image/*"
                        className="hidden"
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          if (file) handleUpload(entry, file);
                          e.target.value = "";
                        }}
                      />
                    </label>

                    {/* Download */}
                    {entry.gst_invoice_path && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
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

                    {/* Email */}
                    {entry.gst_invoice_path && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        onClick={() => setEmailDialogEntry(entry)}
                      >
                        <Mail className="h-3.5 w-3.5" />
                      </Button>
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
          onSuccess={onRefresh}
        />
      )}
    </>
  );
}
