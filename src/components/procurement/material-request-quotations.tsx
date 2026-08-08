"use client";

import { useCallback, useEffect, useState } from "react";
import { FileText, Paperclip, Plus, Trash2, Upload, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import { createClient as createBrowserClient } from "@/lib/supabase/client";
import { prepareUpload, UploadTooLargeError } from "@/lib/uploads/upload-gate";
import { formatCurrency, formatDate } from "@/lib/utils";
import type { MaterialRequestQuotation } from "@/types";

type Props = {
  prId: string;
  prStatus: string;
  onChange?: () => void;
};

export function MaterialRequestQuotations({ prId, prStatus, onChange }: Props) {
  const [quotations, setQuotations] = useState<MaterialRequestQuotation[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [vendorName, setVendorName] = useState("");
  const [amount, setAmount] = useState("");
  const [notes, setNotes] = useState("");
  const [file, setFile] = useState<File | null>(null);

  const isEditable = ["draft", "submitted", "rejected"].includes(prStatus);
  const isMissingForApproval = prStatus === "submitted" && quotations.length === 0;

  const fetchQuotations = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/procurement/requests/${prId}/quotations`);
      if (res.ok) {
        const json = await res.json();
        setQuotations(json.data ?? []);
      }
    } finally {
      setLoading(false);
    }
  }, [prId]);

  useEffect(() => {
    fetchQuotations();
  }, [fetchQuotations]);

  const resetForm = () => {
    setVendorName("");
    setAmount("");
    setNotes("");
    setFile(null);
  };

  const handleUpload = async () => {
    if (!file) {
      toast.error("Please choose a file");
      return;
    }
    if (!vendorName.trim()) {
      toast.error("Vendor name is required");
      return;
    }
    const amt = parseFloat(amount);
    if (isNaN(amt) || amt < 0) {
      toast.error("A valid amount is required");
      return;
    }
    setUploading(true);
    try {
      // Normalize client-side, then upload directly to storage via a signed
      // URL — proxying the raw file through our API route would hit
      // Vercel's 4.5MB serverless request body limit.
      const prepared = await prepareUpload(file);
      if (!prepared) return;

      const urlRes = await fetch("/api/documents/upload-url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fileName: prepared.name,
          mimeType: prepared.type,
          path: `material-requests/${prId}`,
        }),
      });
      if (!urlRes.ok) throw new Error("Failed to get upload URL");
      const { token, path: filePath } = await urlRes.json();

      const supabase = createBrowserClient();
      const { error: storageError } = await supabase.storage
        .from("crm-documents")
        .uploadToSignedUrl(filePath, token, prepared, {
          contentType: prepared.type || "application/octet-stream",
        });
      if (storageError) throw new Error(storageError.message);

      const res = await fetch(`/api/procurement/requests/${prId}/quotations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filePath,
          fileName: prepared.name,
          mimeType: prepared.type,
          vendor_name: vendorName.trim(),
          amount,
          notes: notes.trim() || undefined,
        }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        toast.error(json?.error ?? "Failed to upload quotation");
        return;
      }
      toast.success("Quotation uploaded");
      setUploadOpen(false);
      resetForm();
      await fetchQuotations();
      onChange?.();
    } catch (e) {
      if (e instanceof UploadTooLargeError) {
        toast.error(e.message);
      } else {
        toast.error(e instanceof Error ? e.message : "Failed to upload quotation");
      }
    } finally {
      setUploading(false);
    }
  };

  const handleDelete = async (quotationId: string) => {
    if (!confirm("Delete this quotation? The file will be removed.")) return;
    setDeletingId(quotationId);
    try {
      const res = await fetch(
        `/api/procurement/requests/${prId}/quotations/${quotationId}`,
        { method: "DELETE" }
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(json.error ?? "Failed to delete quotation");
        return;
      }
      toast.success("Quotation removed");
      await fetchQuotations();
      onChange?.();
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <Card className={isMissingForApproval ? "border-amber-300 ring-1 ring-amber-200" : undefined}>
      <CardHeader className="pb-3 flex flex-row items-center justify-between">
        <div className="flex items-center gap-2">
          <Paperclip className="h-4 w-4 text-muted-foreground" />
          <CardTitle className="text-base">
            Vendor Quotations / Estimates
            {!loading && (
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                ({quotations.length})
              </span>
            )}
          </CardTitle>
        </div>
        {isEditable && (
          <Button size="sm" variant="outline" onClick={() => setUploadOpen(true)}>
            <Plus className="h-4 w-4 mr-1" /> Add Quotation
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        {isMissingForApproval && (
          <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800">
            ⚠ No quotations attached. Approval is blocked until at least one estimate / bill
            is uploaded.
          </div>
        )}
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : quotations.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No quotations attached yet.
            {isEditable && " Use Add Quotation to upload a vendor estimate or bill."}
          </p>
        ) : (
          <div className="rounded-md border overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/50">
                  <th className="px-3 py-2 text-left font-medium">Vendor</th>
                  <th className="px-3 py-2 text-right font-medium">Amount</th>
                  <th className="px-3 py-2 text-left font-medium hidden sm:table-cell">
                    Uploaded
                  </th>
                  <th className="px-3 py-2 text-left font-medium">File</th>
                  {isEditable && <th className="px-3 py-2"></th>}
                </tr>
              </thead>
              <tbody>
                {quotations.map((q) => (
                  <tr key={q.id} className="border-b last:border-0">
                    <td className="px-3 py-2 align-top">
                      <div className="font-medium">{q.vendor_name}</div>
                      {q.notes && (
                        <div className="text-xs text-muted-foreground mt-0.5">
                          {q.notes}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right font-medium align-top">
                      {formatCurrency(Number(q.amount))}
                    </td>
                    <td className="px-3 py-2 text-xs text-muted-foreground align-top hidden sm:table-cell">
                      <div>{formatDate(q.created_at)}</div>
                      {q.uploader && (
                        <div className="text-[11px]">
                          by {q.uploader.full_name ?? q.uploader.email}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2 align-top">
                      {q.signed_url ? (
                        <a
                          href={q.signed_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 text-blue-600 hover:underline text-xs"
                        >
                          <FileText className="h-3.5 w-3.5" />
                          {q.file_name}
                          <ExternalLink className="h-3 w-3" />
                        </a>
                      ) : (
                        <span className="text-xs text-muted-foreground">
                          {q.file_name}
                        </span>
                      )}
                    </td>
                    {isEditable && (
                      <td className="px-3 py-2 align-top text-right">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 text-destructive hover:text-destructive"
                          onClick={() => handleDelete(q.id)}
                          disabled={deletingId === q.id}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>

      <Dialog
        open={uploadOpen}
        onOpenChange={(o) => {
          if (!o) resetForm();
          setUploadOpen(o);
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Upload Quotation / Estimate</DialogTitle>
            <DialogDescription>
              Attach a vendor quote, estimate, or bill so the approver has context.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label className="text-xs">
                Vendor Name <span className="text-red-500">*</span>
              </Label>
              <Input
                placeholder="e.g. ABC Suppliers Pvt Ltd"
                value={vendorName}
                onChange={(e) => setVendorName(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">
                Quoted Amount (₹) <span className="text-red-500">*</span>
              </Label>
              <Input
                type="number"
                min="0"
                step="0.01"
                placeholder="0.00"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">
                File <span className="text-red-500">*</span>{" "}
                <span className="text-muted-foreground font-normal">
                  (PDF / JPG / PNG / WEBP / HEIC, max 50 MB)
                </span>
              </Label>
              <Input
                type="file"
                accept="application/pdf,image/jpeg,image/png,image/webp,image/heic,image/heif"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">
                Notes <span className="text-muted-foreground">(optional)</span>
              </Label>
              <Input
                placeholder="Discount, validity, lead time…"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setUploadOpen(false)}
              disabled={uploading}
            >
              Cancel
            </Button>
            <Button onClick={handleUpload} disabled={uploading}>
              {uploading ? (
                "Uploading…"
              ) : (
                <>
                  <Upload className="h-4 w-4 mr-1" /> Upload
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
