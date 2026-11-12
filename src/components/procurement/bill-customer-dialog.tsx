"use client";

import { useEffect, useState } from "react";
import { Plus, Trash2, Loader2, ArrowLeft, Paperclip, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import { formatCurrency } from "@/lib/utils";
import { computeGstAndRounding } from "@/lib/gst-math";
import { createClient as createBrowserClient } from "@/lib/supabase/client";
import { prepareUpload, UploadTooLargeError } from "@/lib/uploads/upload-gate";

interface BillLineItem {
  id: string; // local draft id
  description: string;
  quantity: string;
  unit_price: string;
}

interface StagedDocument {
  id: string; // local draft id
  file: File;
}

function generateLocalId() {
  return Math.random().toString(36).slice(2);
}

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  prId: string;
  prNumber: string;
  contractLabel: string;
  /** Contract's locked GST rate — used to show an accurate preview total before anything is sent. */
  taxPercentage: number;
  /** 'proforma_first' sends a pay-first PI; 'gst_direct' sends the GST tax invoice immediately. */
  billingMode?: string;
  /** Pre-fills the line-item editor from the MR's own items — pricing is entered fresh, not copied. */
  seedItems: { item_name: string; quantity: number }[];
  onSuccess: () => void;
};

export function BillCustomerDialog({
  open, onOpenChange, prId, prNumber, contractLabel, taxPercentage, billingMode, seedItems, onSuccess,
}: Props) {
  const [items, setItems] = useState<BillLineItem[]>([]);
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [supportingDocs, setSupportingDocs] = useState<StagedDocument[]>([]);

  useEffect(() => {
    if (!open) return;
    setItems(
      seedItems.length > 0
        ? seedItems.map((it) => ({
            id: generateLocalId(),
            description: it.item_name,
            quantity: String(it.quantity ?? 1),
            unit_price: "",
          }))
        : [{ id: generateLocalId(), description: "", quantity: "1", unit_price: "" }]
    );
    setNotes("");
    setPreviewing(false);
    setSupportingDocs([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const addSupportingDocs = (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setSupportingDocs((prev) => [
      ...prev,
      ...Array.from(files).map((file) => ({ id: generateLocalId(), file })),
    ]);
  };

  const removeSupportingDoc = (localId: string) => {
    setSupportingDocs((prev) => prev.filter((d) => d.id !== localId));
  };

  const addItem = () => {
    setItems((prev) => [...prev, { id: generateLocalId(), description: "", quantity: "1", unit_price: "" }]);
  };

  const removeItem = (localId: string) => {
    setItems((prev) => (prev.length <= 1 ? prev : prev.filter((li) => li.id !== localId)));
  };

  const updateItem = (localId: string, field: keyof BillLineItem, value: string) => {
    setItems((prev) => prev.map((li) => (li.id === localId ? { ...li, [field]: value } : li)));
  };

  const subtotal = items.reduce((sum, li) => {
    const q = parseFloat(li.quantity);
    const p = parseFloat(li.unit_price);
    if (!isNaN(q) && !isNaN(p)) return sum + q * p;
    return sum;
  }, 0);

  const cleanedItems = items
    .map((li) => ({
      description: li.description.trim(),
      quantity: parseFloat(li.quantity),
      unit_price: parseFloat(li.unit_price),
    }))
    .filter((li) => li.description && !isNaN(li.quantity) && li.quantity > 0 && !isNaN(li.unit_price) && li.unit_price >= 0);

  const gst = computeGstAndRounding(subtotal, taxPercentage);

  const goToPreview = () => {
    if (cleanedItems.length === 0) {
      toast.error("Add at least one line item with a description, quantity, and price");
      return;
    }
    if (subtotal <= 0) {
      toast.error("Total amount must be greater than zero");
      return;
    }
    setPreviewing(true);
  };

  const handleConfirmSend = async () => {
    setSubmitting(true);
    try {
      // Upload any staged supporting documents first — files are not sent
      // until the user confirms, so a cancelled dialog leaves nothing orphaned.
      const uploadedDocs: { filePath: string; fileName: string; mimeType: string }[] = [];
      if (supportingDocs.length > 0) {
        const supabase = createBrowserClient();
        for (const staged of supportingDocs) {
          let prepared;
          try {
            prepared = await prepareUpload(staged.file);
          } catch (e) {
            toast.error(e instanceof UploadTooLargeError ? e.message : "Failed to prepare a supporting document");
            return;
          }
          if (!prepared) return; // user declined the large-file confirm

          const urlRes = await fetch("/api/documents/upload-url", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              fileName: prepared.name,
              mimeType: prepared.type,
              path: `reimbursement-support/${prId}`,
            }),
          });
          if (!urlRes.ok) {
            toast.error(`Failed to upload "${staged.file.name}"`);
            return;
          }
          const { token, path: filePath } = await urlRes.json();

          const { error: storageError } = await supabase.storage
            .from("crm-documents")
            .uploadToSignedUrl(filePath, token, prepared, {
              contentType: prepared.type || "application/octet-stream",
            });
          if (storageError) {
            toast.error(`Failed to upload "${staged.file.name}": ${storageError.message}`);
            return;
          }

          uploadedDocs.push({ filePath, fileName: prepared.name, mimeType: prepared.type || "application/octet-stream" });
        }
      }

      const res = await fetch(`/api/procurement/requests/${prId}/bill-customer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items: cleanedItems,
          notes: notes.trim() || undefined,
          supportingDocuments: uploadedDocs.length > 0 ? uploadedDocs : undefined,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        toast.error(json.error || "Failed to create invoice");
        return;
      }
      if (json.data.supportingDocumentsError) {
        toast.warning("Invoice created, but attaching the supporting documents failed. You can re-attach them later.");
      }

      // Finalize + dispatch immediately — same one-click behaviour as the
      // Usage tab's "Verify & Send". Rolls back to draft on dispatch failure.
      const sendRes = await fetch(`/api/billing-statements/${json.data.id}/finalize-and-send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const sendJson = await sendRes.json();
      if (!sendRes.ok) {
        toast.error(
          `Invoice ${json.data.statement_number} created but sending failed: ${sendJson.error || "unknown error"}. Find it as a draft on the Billing page and retry.`
        );
        onSuccess();
        onOpenChange(false);
        return;
      }

      toast.success(
        sendJson.no_contact
          ? `Invoice ${json.data.statement_number} created, but the customer has no email/phone on file — send it manually.`
          : `Invoice ${json.data.statement_number} sent to the customer (${formatCurrency(sendJson.total_amount)}).`
      );
      onSuccess();
      onOpenChange(false);
    } catch (err) {
      toast.error("Something went wrong billing the customer");
      console.error(err);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        {!previewing ? (
          <>
            <DialogHeader>
              <DialogTitle>Bill Customer — {prNumber}</DialogTitle>
              <DialogDescription>
                Invoicing {contractLabel}. Enter the customer-facing price for each line — this is manually
                marked up, it does not have to match the vendor cost. You can bill this in full now, or bill
                part of it as an advance and the rest later.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-3">
              <div className="grid grid-cols-[1fr_80px_110px_36px] gap-2 text-xs font-medium text-muted-foreground px-1">
                <span>Description</span>
                <span>Qty</span>
                <span>Price</span>
                <span />
              </div>
              {items.map((li) => (
                <div key={li.id} className="grid grid-cols-[1fr_80px_110px_36px] gap-2 items-start">
                  <Input
                    placeholder="e.g. Office chairs (x4)"
                    value={li.description}
                    onChange={(e) => updateItem(li.id, "description", e.target.value)}
                  />
                  <Input
                    type="number"
                    min="0"
                    step="0.01"
                    value={li.quantity}
                    onChange={(e) => updateItem(li.id, "quantity", e.target.value)}
                  />
                  <Input
                    type="number"
                    min="0"
                    step="0.01"
                    placeholder="Rate"
                    value={li.unit_price}
                    onChange={(e) => updateItem(li.id, "unit_price", e.target.value)}
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    className="text-muted-foreground hover:text-red-600"
                    onClick={() => removeItem(li.id)}
                    disabled={items.length <= 1}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}
              <Button variant="outline" size="sm" onClick={addItem}>
                <Plus className="h-4 w-4 mr-1" /> Add line
              </Button>

              <div className="space-y-1.5 pt-2">
                <Label htmlFor="bill-customer-notes">Notes (optional)</Label>
                <Textarea
                  id="bill-customer-notes"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  rows={2}
                  placeholder="Internal note — not shown on the invoice"
                />
              </div>

              <div className="space-y-1.5 pt-2">
                <Label>
                  Supporting Documents <span className="text-red-600 font-normal">(required)</span>
                </Label>
                <p className="text-xs text-muted-foreground">
                  Receipts / vendor bills — merged as extra pages onto the invoice sent to the customer, so it&apos;s
                  self-explanatory without anyone chasing the receipt separately.
                </p>
                {supportingDocs.length === 0 && (
                  <p className="text-xs text-amber-700">At least one document is required before you can continue.</p>
                )}
                {supportingDocs.length > 0 && (
                  <div className="space-y-1">
                    {supportingDocs.map((d) => (
                      <div key={d.id} className="flex items-center justify-between gap-2 text-xs bg-muted/40 rounded px-2 py-1.5">
                        <span className="flex items-center gap-1 truncate">
                          <Paperclip className="h-3 w-3 shrink-0" /> {d.file.name}
                        </span>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-5 w-5 text-muted-foreground hover:text-red-600 shrink-0"
                          onClick={() => removeSupportingDoc(d.id)}
                        >
                          <Trash2 className="h-3 w-3" />
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
                <Label
                  htmlFor="bill-customer-supporting-docs"
                  className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground border rounded-md px-2.5 py-1.5 cursor-pointer hover:bg-muted/50 w-fit"
                >
                  <Upload className="h-3.5 w-3.5" /> Add file(s)
                </Label>
                <input
                  id="bill-customer-supporting-docs"
                  type="file"
                  multiple
                  accept="application/pdf,image/jpeg,image/png,image/webp,image/heic,image/heif"
                  className="hidden"
                  onChange={(e) => {
                    addSupportingDocs(e.target.files);
                    e.target.value = "";
                  }}
                />
              </div>

              <div className="flex justify-end text-sm font-medium pt-2 border-t">
                Subtotal: {formatCurrency(subtotal)} <span className="text-muted-foreground font-normal ml-1">(+ GST)</span>
              </div>
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button onClick={goToPreview} disabled={subtotal <= 0 || supportingDocs.length === 0}>
                Preview Invoice
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Preview — {prNumber}</DialogTitle>
              <DialogDescription>
                Nothing has been sent yet. Check every line before confirming — this is exactly what will
                go out to the customer.
              </DialogDescription>
            </DialogHeader>

            <div className="rounded-md border overflow-hidden">
              <div className="bg-muted/50 px-4 py-2.5 text-sm">
                <p className="font-medium">{contractLabel}</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Will be sent as{" "}
                  {billingMode === "gst_direct"
                    ? "a GST tax invoice, immediately"
                    : "a proforma invoice — the GST invoice follows after payment"}
                </p>
              </div>
              <div className="divide-y">
                {cleanedItems.map((li, i) => (
                  <div key={i} className="flex items-center justify-between gap-4 px-4 py-2.5 text-sm">
                    <span>{li.description}</span>
                    <span className="font-medium shrink-0">{formatCurrency(li.quantity * li.unit_price)}</span>
                  </div>
                ))}
              </div>
              <div className="border-t px-4 py-3 space-y-1 text-sm">
                <div className="flex justify-between text-muted-foreground">
                  <span>Subtotal</span>
                  <span>{formatCurrency(subtotal)}</span>
                </div>
                <div className="flex justify-between text-muted-foreground">
                  <span>GST ({taxPercentage}%)</span>
                  <span>{formatCurrency(gst.taxAmount)}</span>
                </div>
                <div className="flex justify-between font-semibold text-base pt-1 border-t">
                  <span>Total</span>
                  <span>{formatCurrency(gst.totalAmount)}</span>
                </div>
              </div>
            </div>

            {supportingDocs.length > 0 && (
              <p className="text-xs text-muted-foreground flex items-center gap-1">
                <Paperclip className="h-3.5 w-3.5" />
                {supportingDocs.length} supporting document{supportingDocs.length === 1 ? "" : "s"} will be attached to the invoice.
              </p>
            )}

            <DialogFooter>
              <Button variant="outline" onClick={() => setPreviewing(false)} disabled={submitting}>
                <ArrowLeft className="h-4 w-4 mr-1" /> Back to edit
              </Button>
              <Button onClick={handleConfirmSend} disabled={submitting}>
                {submitting ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : null}
                Confirm & Send to Customer
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
