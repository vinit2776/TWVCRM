"use client";

import { useState, useEffect, useRef, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ChevronLeft, Loader2, Paperclip, X, FileText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { createClient as createBrowserClient } from "@/lib/supabase/client";
import { formatCurrency } from "@/lib/utils";
import { AlertTriangle } from "lucide-react";
import type { ProcurementVendor, PurchaseOrder } from "@/types";

function computeReceivedValue(po: PurchaseOrder): number | null {
  if (!po.purchase_order_items || !po.po_delivery_receipts) return null;
  const priceMap: Record<string, number> = {};
  for (const item of po.purchase_order_items) {
    priceMap[item.id] = Number(item.unit_price ?? 0);
  }
  let total = 0;
  for (const receipt of po.po_delivery_receipts) {
    for (const ri of receipt.po_delivery_receipt_items ?? []) {
      total += (priceMap[ri.po_item_id] ?? 0) * Number(ri.qty_received);
    }
  }
  return total;
}

const ACCEPTED_TYPES = ["application/pdf", "image/jpeg", "image/jpg", "image/png", "image/webp"];
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

function NewVendorBillForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const poId = searchParams.get("po_id");

  const today = new Date().toISOString().split("T")[0];

  const [vendorId, setVendorId] = useState("");
  const [invoiceNumber, setInvoiceNumber] = useState("");
  const [invoiceDate, setInvoiceDate] = useState(today);
  const [dueDate, setDueDate] = useState("");
  const [totalAmount, setTotalAmount] = useState("");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // File upload state
  const [invoiceFile, setInvoiceFile] = useState<File | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [vendors, setVendors] = useState<ProcurementVendor[]>([]);
  const [poData, setPoData] = useState<PurchaseOrder | null>(null);
  const [loadingPo, setLoadingPo] = useState(false);
  const [vendorLocked, setVendorLocked] = useState(false);

  useEffect(() => {
    fetch("/api/procurement/vendors").then((r) => r.json()).then((j) => {
      setVendors(j.data || []);
    });
  }, []);

  useEffect(() => {
    if (!poId) return;
    setLoadingPo(true);
    fetch(`/api/procurement/orders/${poId}`)
      .then((r) => r.json())
      .then((json) => {
        const po = json.data;
        if (!po) return;
        setPoData(po);
        setVendorId(po.vendor_id);
        setVendorLocked(true);
        if (po.total_ordered_amount > 0) {
          // Pre-fill with received value if there's a shortfall, otherwise full PO value
          const rv = po.po_type !== "service" ? computeReceivedValue(po) : null;
          const prefill = (rv !== null && rv < Number(po.total_ordered_amount)) ? rv : Number(po.total_ordered_amount);
          setTotalAmount(String(prefill));
        }
      })
      .finally(() => setLoadingPo(false));
  }, [poId]);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!ACCEPTED_TYPES.includes(file.type)) {
      toast.error("Only PDF, JPEG, PNG, or WebP files are accepted");
      e.target.value = "";
      return;
    }
    if (file.size > MAX_FILE_SIZE) {
      toast.error("File size must be under 10 MB");
      e.target.value = "";
      return;
    }
    setInvoiceFile(file);
  };

  const removeFile = () => {
    setInvoiceFile(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const receivedValue = poData && poData.po_type !== "service" ? computeReceivedValue(poData) : null;
  const hasShortfall = receivedValue !== null && receivedValue < Number(poData?.total_ordered_amount ?? 0);
  // Effective ceiling: received value if shortfall, otherwise full PO value
  const effectiveCeiling = hasShortfall ? receivedValue! : (poData ? Number(poData.total_ordered_amount) : null);

  const validate = (): string | null => {
    if (!vendorId) return "Please select a vendor";
    if (!invoiceDate) return "Invoice date is required";
    const amount = parseFloat(totalAmount);
    if (!totalAmount || isNaN(amount) || amount <= 0) return "Invoice amount must be greater than 0";
    // File is mandatory when linked to a PO
    if (poId && !invoiceFile) return "Please upload the vendor invoice file";
    // Proportionate ceiling check: if shortfall, cap at received value
    if (hasShortfall && amount > receivedValue!) {
      return `Invoice amount (${formatCurrency(amount)}) exceeds the proportionate value of goods received (${formatCurrency(receivedValue!)}). Only goods worth ${formatCurrency(receivedValue!)} have been received against the PO value of ${formatCurrency(poData!.total_ordered_amount)}.`;
    }
    // Full PO ceiling
    if (poData && poData.total_ordered_amount > 0 && amount > Number(poData.total_ordered_amount)) {
      return `Invoice amount (${formatCurrency(amount)}) cannot exceed PO value (${formatCurrency(poData.total_ordered_amount)})`;
    }
    return null;
  };

  const handleSubmit = async () => {
    const err = validate();
    if (err) { toast.error(err); return; }

    setSubmitting(true);
    try {
      let invoiceFileUrl: string | null = null;

      // Upload file to Supabase Storage if provided
      if (invoiceFile) {
        const supabase = createBrowserClient();
        const ext = invoiceFile.name.split(".").pop() ?? "pdf";
        const filePath = `${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
        const { error: uploadError } = await supabase.storage
          .from("vendor-invoices")
          .upload(filePath, invoiceFile);

        if (uploadError) {
          toast.error(`File upload failed: ${uploadError.message}`);
          return;
        }

        const { data: urlData } = supabase.storage
          .from("vendor-invoices")
          .getPublicUrl(filePath);
        invoiceFileUrl = urlData.publicUrl;
      }

      const payload = {
        po_id: poId ?? null,
        vendor_id: vendorId,
        invoice_number: invoiceNumber.trim() || null,
        invoice_date: invoiceDate,
        due_date: dueDate || null,
        total_amount: parseFloat(totalAmount),
        notes: notes.trim() || null,
        invoice_file_url: invoiceFileUrl,
      };

      const res = await fetch("/api/procurement/bills", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = await res.json();
      if (!res.ok) {
        toast.error(typeof json.error === "string" ? json.error : "Failed to create vendor invoice");
        return;
      }
      toast.success(`Vendor invoice recorded — ${json.data.bill_number}`);
      router.push(`/procurement/bills/${json.data.id}`);
    } finally {
      setSubmitting(false);
    }
  };

  if (loadingPo) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-2xl mx-auto">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={() => router.back()}>
          <ChevronLeft className="h-5 w-5" />
        </Button>
        <div>
          <h1 className="text-2xl font-bold">Vendor Invoice</h1>
          <p className="text-sm text-muted-foreground">
            {poData ? `Recording invoice for ${poData.po_number}` : "Record a vendor invoice"}
          </p>
        </div>
      </div>

      {/* PO context banner */}
      {poData && (
        <div className="rounded-lg border border-blue-200 bg-blue-50/50 px-4 py-3 text-sm text-blue-800">
          Recording invoice for PO <strong>{poData.po_number}</strong>.
          {Number(poData.total_ordered_amount) > 0 && (
            <> PO value: <strong>{formatCurrency(poData.total_ordered_amount)}</strong>.</>
          )}
        </div>
      )}

      {/* Shortfall warning */}
      {hasShortfall && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 flex items-start gap-3">
          <AlertTriangle className="h-4 w-4 flex-shrink-0 mt-0.5 text-amber-600" />
          <div>
            <strong>Delivery shortfall detected.</strong> Only goods worth{" "}
            <strong>{formatCurrency(receivedValue!)}</strong> have been received out of the PO value of{" "}
            <strong>{formatCurrency(poData!.total_ordered_amount)}</strong>. The invoice amount cannot exceed{" "}
            <strong>{formatCurrency(receivedValue!)}</strong>.
          </div>
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Invoice Details</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Vendor */}
          <div className="space-y-1.5">
            <Label htmlFor="vendor">Vendor <span className="text-red-500">*</span></Label>
            <Select
              value={vendorId || "__none__"}
              onValueChange={(v) => { if (!vendorLocked) setVendorId(v === "__none__" ? "" : v); }}
              disabled={vendorLocked}
            >
              <SelectTrigger id="vendor" className={vendorLocked ? "bg-muted/50" : ""}>
                <SelectValue placeholder="Select vendor" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">Select a vendor…</SelectItem>
                {vendors.map((v) => (
                  <SelectItem key={v.id} value={v.id}>{v.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            {vendorLocked && (
              <p className="text-xs text-muted-foreground">Vendor is locked to the linked purchase order</p>
            )}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="invoice_number">Invoice Number</Label>
              <Input
                id="invoice_number"
                placeholder="Vendor's invoice #"
                value={invoiceNumber}
                onChange={(e) => setInvoiceNumber(e.target.value)}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="total_amount">
                Invoice Amount (₹) <span className="text-red-500">*</span>
              </Label>
              <Input
                id="total_amount"
                type="number"
                min="0.01"
                max={effectiveCeiling ?? undefined}
                step="0.01"
                placeholder="0.00"
                value={totalAmount}
                onChange={(e) => setTotalAmount(e.target.value)}
              />
              {effectiveCeiling !== null && effectiveCeiling > 0 && (
                <p className="text-xs text-muted-foreground">
                  Max: {formatCurrency(effectiveCeiling)} ({hasShortfall ? "proportionate received value" : "PO value"})
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="invoice_date">Invoice Date <span className="text-red-500">*</span></Label>
              <Input
                id="invoice_date"
                type="date"
                value={invoiceDate}
                onChange={(e) => setInvoiceDate(e.target.value)}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="due_date">Due Date</Label>
              <Input
                id="due_date"
                type="date"
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
              />
            </div>
          </div>

          {/* Invoice File Upload */}
          <div className="space-y-1.5">
            <Label>
              Invoice File{" "}
              {poId ? (
                <span className="text-red-500">*</span>
              ) : (
                <span className="text-muted-foreground text-xs">(optional)</span>
              )}
            </Label>
            {invoiceFile ? (
              <div className="flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-2.5">
                <FileText className="h-4 w-4 text-primary flex-shrink-0" />
                <span className="text-sm flex-1 truncate">{invoiceFile.name}</span>
                <span className="text-xs text-muted-foreground">
                  {(invoiceFile.size / 1024).toFixed(0)} KB
                </span>
                <button
                  type="button"
                  onClick={removeFile}
                  className="ml-1 text-muted-foreground hover:text-destructive"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            ) : (
              <div
                className="flex items-center justify-center rounded-md border-2 border-dashed border-muted-foreground/25 px-4 py-6 cursor-pointer hover:border-muted-foreground/50 transition-colors"
                onClick={() => fileInputRef.current?.click()}
              >
                <div className="text-center">
                  <Paperclip className="h-6 w-6 text-muted-foreground mx-auto mb-1" />
                  <p className="text-sm text-muted-foreground">
                    Click to upload invoice (PDF, JPG, PNG — max 10 MB)
                  </p>
                </div>
              </div>
            )}
            <input
              ref={fileInputRef}
              type="file"
              accept=".pdf,.jpg,.jpeg,.png,.webp"
              className="sr-only"
              onChange={handleFileChange}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="notes">Notes</Label>
            <Textarea
              id="notes"
              placeholder="Any additional notes..."
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
            />
          </div>
        </CardContent>
      </Card>

      <div className="flex justify-end">
        <Button onClick={handleSubmit} disabled={submitting} size="lg">
          {submitting ? (
            <><Loader2 className="h-4 w-4 animate-spin mr-2" /> Saving…</>
          ) : (
            "Save Vendor Invoice"
          )}
        </Button>
      </div>
    </div>
  );
}

export default function NewVendorBillPage() {
  return (
    <Suspense fallback={
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    }>
      <NewVendorBillForm />
    </Suspense>
  );
}
