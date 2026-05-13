"use client";

import { useState, useEffect, useRef, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ChevronLeft, Loader2, Paperclip, X, FileText, AlertCircle, Lightbulb, TrendingUp, CalendarClock, PackageSearch } from "lucide-react";
import Link from "next/link";
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
import type { BillHintsResponse } from "@/app/api/finance-intelligence/bill-hints/route";

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
  const replacesId = searchParams.get("replaces");

  const today = new Date().toISOString().split("T")[0];

  const [vendorId, setVendorId] = useState("");
  const [invoiceNumber, setInvoiceNumber] = useState("");
  const [invoiceDate, setInvoiceDate] = useState(today);
  const [dueDate, setDueDate] = useState("");
  const [totalAmount, setTotalAmount] = useState("");
  const [gstRate, setGstRate] = useState<number>(0);
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // Duplicate-invoice detector (Finance Intelligence — Day 2)
  type DupCandidate = {
    bill_id: string; bill_number: string;
    invoice_number: string | null; invoice_date: string;
    total_amount: number; similarity_score: number; match_reason: string;
    approval_status: string;
  };
  const [duplicates, setDuplicates] = useState<DupCandidate[]>([]);
  const [checkingDuplicates, setCheckingDuplicates] = useState(false);
  const [duplicateDismissed, setDuplicateDismissed] = useState(false);

  // Bill hints (Finance Intelligence — Day 3-5)
  const [hints, setHints] = useState<BillHintsResponse | null>(null);
  const [dueDateHintDismissed, setDueDateHintDismissed] = useState(false);
  const [anomalyDismissed, setAnomalyDismissed] = useState(false);

  // Note suggestions (Finance Intelligence — Day 7)
  const [noteSuggestions, setNoteSuggestions] = useState<string[]>([]);
  const [notesFocused, setNotesFocused] = useState(false);

  // File upload state
  const [invoiceFile, setInvoiceFile] = useState<File | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [vendors, setVendors] = useState<ProcurementVendor[]>([]);
  const [poData, setPoData] = useState<PurchaseOrder | null>(null);
  const [loadingPo, setLoadingPo] = useState(false);
  const [vendorLocked, setVendorLocked] = useState(false);

  // Replacement-bill mode
  const [replacesBill, setReplacesBill] = useState<{
    id: string;
    bill_number: string;
    rejection_reason: string | null;
  } | null>(null);

  useEffect(() => {
    fetch("/api/procurement/vendors").then((r) => r.json()).then((j) => {
      setVendors(j.data || []);
    });
  }, []);

  // When ?replaces=<id> is present, fetch the predecessor bill so we can show its
  // number + rejection reason and prefill notes
  useEffect(() => {
    if (!replacesId) return;
    fetch(`/api/procurement/bills/${replacesId}`)
      .then((r) => r.json())
      .then((json) => {
        const b = json.data;
        if (!b) return;
        setReplacesBill({ id: b.id, bill_number: b.bill_number, rejection_reason: b.rejection_reason });
        // Pre-fill notes with reference to the rejected bill so accounts has context
        setNotes((prev) =>
          prev.trim()
            ? prev
            : `Replaces ${b.bill_number}${b.rejection_reason ? ` (rejected: ${b.rejection_reason})` : ""}`
        );
      })
      .catch(() => {});
  }, [replacesId]);

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

  // ── Duplicate-invoice detector — debounced check ─────────────────────────
  useEffect(() => {
    // Reset dismissal whenever the inputs change
    setDuplicateDismissed(false);

    const amt = parseFloat(totalAmount);
    if (!vendorId || !invoiceNumber.trim() || !isFinite(amt) || amt <= 0 || !invoiceDate) {
      setDuplicates([]);
      return;
    }

    let cancelled = false;
    setCheckingDuplicates(true);

    const t = setTimeout(async () => {
      try {
        const res = await fetch("/api/procurement/bills/check-duplicate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            vendor_id: vendorId,
            invoice_number: invoiceNumber.trim(),
            total_amount: amt,
            invoice_date: invoiceDate,
          }),
        });
        if (cancelled) return;
        const json = await res.json();
        setDuplicates(json.candidates ?? []);
      } catch {
        if (!cancelled) setDuplicates([]);
      } finally {
        if (!cancelled) setCheckingDuplicates(false);
      }
    }, 500);

    return () => { cancelled = true; clearTimeout(t); };
  }, [vendorId, invoiceNumber, totalAmount, invoiceDate]);

  // ── Bill hints — debounced fetch (Day 3-5) ──────────────────────────────────
  useEffect(() => {
    // Reset dismissals when inputs change
    setDueDateHintDismissed(false);
    setAnomalyDismissed(false);

    const amt = parseFloat(totalAmount);
    if (!vendorId) { setHints(null); return; }

    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const res = await fetch("/api/finance-intelligence/bill-hints", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            vendor_id: vendorId,
            ...(isFinite(amt) && amt > 0 ? { total_amount: amt } : {}),
            ...(invoiceDate ? { invoice_date: invoiceDate } : {}),
            ...(poId ? { po_id: poId } : {}),
          }),
        });
        if (!cancelled && res.ok) {
          setHints(await res.json());
        }
      } catch {
        // non-fatal — hints are cosmetic
      }
    }, 600);

    return () => { cancelled = true; clearTimeout(t); };
  }, [vendorId, totalAmount, invoiceDate, poId]);

  // ── Note suggestions — debounced fetch (Day 7) ──────────────────────────────
  useEffect(() => {
    if (!vendorId || !notesFocused) { setNoteSuggestions([]); return; }
    const q = notes.trim();
    // Only query when ≥3 chars typed, or on first focus (show recent notes)
    if (q.length > 0 && q.length < 3) { setNoteSuggestions([]); return; }

    let cancelled = false;
    const delay = q.length === 0 ? 0 : 300;
    const t = setTimeout(async () => {
      try {
        const params = new URLSearchParams({ vendor_id: vendorId });
        if (q) params.set("q", q);
        const res = await fetch(`/api/finance-intelligence/note-suggestions?${params}`);
        if (!cancelled && res.ok) {
          const json = await res.json();
          // Don't show suggestions that exactly match what's already typed
          const filtered = (json.suggestions as string[]).filter(
            (s) => s.toLowerCase() !== q.toLowerCase(),
          );
          setNoteSuggestions(filtered);
        }
      } catch { /* non-fatal */ }
    }, delay);

    return () => { cancelled = true; clearTimeout(t); };
  }, [vendorId, notes, notesFocused]);

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

  // Inline real-time error shown below the amount field
  const amountNum = parseFloat(totalAmount);
  const amountError: string | null = (() => {
    if (!totalAmount || isNaN(amountNum) || amountNum <= 0) return null;
    if (hasShortfall && amountNum > receivedValue!) {
      return `Exceeds received value of ${formatCurrency(receivedValue!)} — only ${formatCurrency(receivedValue!)} of goods received out of PO value ${formatCurrency(poData!.total_ordered_amount)}.`;
    }
    if (poData && poData.total_ordered_amount > 0 && amountNum > Number(poData.total_ordered_amount)) {
      return `Exceeds PO value of ${formatCurrency(poData.total_ordered_amount)}.`;
    }
    return null;
  })();

  const validate = (): string | null => {
    if (!vendorId) return "Please select a vendor";
    if (!invoiceDate) return "Invoice date is required";
    const amount = parseFloat(totalAmount);
    if (!totalAmount || isNaN(amount) || amount <= 0) return "Invoice amount must be greater than 0";
    if (amountError) return amountError;
    // File is mandatory when linked to a PO
    if (poId && !invoiceFile) return "Please upload the vendor invoice file";
    return null;
  };

  const handleSubmit = async () => {
    const err = validate();
    if (err) { toast.error(err, { duration: 6000 }); return; }

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
        gst_rate: gstRate,
        notes: notes.trim() || null,
        invoice_file_url: invoiceFileUrl,
        replaces_bill_id: replacesBill?.id ?? null,
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

      {/* Replacement banner — when replacing a previously rejected bill */}
      {replacesBill && (
        <div className="rounded-lg border border-orange-200 bg-orange-50 px-4 py-3 text-sm text-orange-900 flex items-start gap-3">
          <FileText className="h-4 w-4 flex-shrink-0 mt-0.5 text-orange-600" />
          <div>
            <p className="font-medium">
              Replacing rejected invoice <span className="font-mono">{replacesBill.bill_number}</span>
            </p>
            {replacesBill.rejection_reason && (
              <p className="text-xs text-orange-800 mt-0.5">
                Original rejection: &ldquo;{replacesBill.rejection_reason}&rdquo;
              </p>
            )}
            <p className="text-xs text-orange-800 mt-1">
              The new invoice will be linked to {replacesBill.bill_number} for full lineage tracking.
            </p>
          </div>
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

          {/* Duplicate-invoice warning (Finance Intelligence) */}
          {!duplicateDismissed && duplicates.length > 0 && (
            <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 space-y-2">
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-start gap-2 min-w-0">
                  <AlertCircle className="h-4 w-4 text-amber-600 shrink-0 mt-0.5" />
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-amber-900">
                      Possible duplicate{duplicates.length > 1 ? "s" : ""} found
                    </p>
                    <p className="text-xs text-amber-700 mt-0.5">
                      A bill matching these details already exists for this vendor. Review before saving.
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setDuplicateDismissed(true)}
                  className="text-xs text-amber-700 hover:text-amber-900 shrink-0"
                  aria-label="Dismiss"
                >
                  Dismiss
                </button>
              </div>
              <div className="space-y-1 mt-2">
                {duplicates.map((d) => (
                  <div
                    key={d.bill_id}
                    className="flex items-center justify-between gap-2 bg-white/60 rounded px-2 py-1.5 text-xs"
                  >
                    <div className="flex flex-wrap items-baseline gap-x-2 min-w-0">
                      <Link
                        href={`/procurement/bills/${d.bill_id}`}
                        target="_blank"
                        className="font-mono font-medium text-amber-900 hover:underline"
                      >
                        {d.bill_number}
                      </Link>
                      <span className="text-amber-700">{formatCurrency(d.total_amount)}</span>
                      <span className="text-amber-600">{d.invoice_date}</span>
                      <span className="text-amber-700 text-[10px]">· {d.match_reason}</span>
                    </div>
                    <span className="text-amber-900 font-semibold tabular-nums text-[10px] shrink-0">
                      {Math.round(d.similarity_score * 100)}% match
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ── Finance Intelligence hints (Day 3-5) ────────────────────────── */}

          {/* PO cumulative warning */}
          {hints?.po_cumulative?.is_warning && (
            <div className={`rounded-lg border px-3 py-2.5 text-sm flex items-start gap-2.5 ${
              hints.po_cumulative.is_over_budget
                ? "border-red-300 bg-red-50 text-red-900"
                : "border-amber-200 bg-amber-50 text-amber-900"
            }`}>
              <PackageSearch className={`h-4 w-4 shrink-0 mt-0.5 ${hints.po_cumulative.is_over_budget ? "text-red-600" : "text-amber-600"}`} />
              <div>
                <p className="font-medium text-xs">
                  {hints.po_cumulative.is_over_budget
                    ? "Over budget — this bill exceeds the PO value"
                    : `PO ${hints.po_cumulative.consumed_pct}% consumed after this bill`}
                </p>
                <p className="text-xs mt-0.5 text-current/70">
                  Existing: {formatCurrency(hints.po_cumulative.consumed_amount)}
                  {hints.po_cumulative.existing_bill_count > 0 && ` across ${hints.po_cumulative.existing_bill_count} bill${hints.po_cumulative.existing_bill_count !== 1 ? "s" : ""}`}
                  {" · "}PO value: {formatCurrency(hints.po_cumulative.po_value)}
                  {" · "}
                  {hints.po_cumulative.remaining_after >= 0
                    ? `Remaining: ${formatCurrency(hints.po_cumulative.remaining_after)}`
                    : `Over by: ${formatCurrency(Math.abs(hints.po_cumulative.remaining_after))}`}
                </p>
              </div>
            </div>
          )}

          {/* Amount anomaly warning */}
          {!anomalyDismissed && hints?.amount_anomaly?.is_anomaly && (
            <div className="rounded-lg border border-orange-300 bg-orange-50 px-3 py-2.5 text-sm flex items-start justify-between gap-2">
              <div className="flex items-start gap-2.5 min-w-0">
                <TrendingUp className="h-4 w-4 text-orange-600 shrink-0 mt-0.5" />
                <div>
                  <p className="font-medium text-xs text-orange-900">Unusually high amount for this vendor</p>
                  <p className="text-xs text-orange-800 mt-0.5">
                    {hints.amount_anomaly.reason}
                    {" — "}avg is {formatCurrency(hints.amount_anomaly.baseline_average)} across {hints.amount_anomaly.baseline_count} bills
                  </p>
                </div>
              </div>
              <button type="button" onClick={() => setAnomalyDismissed(true)}
                className="text-orange-700 hover:text-orange-900 shrink-0 text-xs">
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="invoice_number">
                Invoice Number
                {checkingDuplicates && (
                  <span className="ml-2 text-[10px] text-muted-foreground inline-flex items-center gap-1">
                    <Loader2 className="h-3 w-3 animate-spin" />
                    Checking for duplicates…
                  </span>
                )}
              </Label>
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
                className={amountError ? "border-red-500 focus-visible:ring-red-500" : ""}
              />
              {amountError ? (
                <p className="text-xs text-red-600 flex items-start gap-1">
                  <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" />
                  {amountError}
                </p>
              ) : effectiveCeiling !== null && effectiveCeiling > 0 ? (
                <p className="text-xs text-muted-foreground">
                  Max: {formatCurrency(effectiveCeiling)} ({hasShortfall ? "proportionate received value" : "PO value"})
                </p>
              ) : null}
            </div>

            {/* GST Rate */}
            <div className="space-y-1.5">
              <Label htmlFor="gst_rate">GST Rate</Label>
              <Select value={String(gstRate)} onValueChange={(v) => setGstRate(Number(v))}>
                <SelectTrigger id="gst_rate">
                  <SelectValue placeholder="Select GST rate" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="0">0% — Exempt / Not applicable</SelectItem>
                  <SelectItem value="5">5% GST</SelectItem>
                  <SelectItem value="12">12% GST</SelectItem>
                  <SelectItem value="18">18% GST</SelectItem>
                  <SelectItem value="28">28% GST</SelectItem>
                </SelectContent>
              </Select>
              {gstRate > 0 && totalAmount && !isNaN(parseFloat(totalAmount)) && parseFloat(totalAmount) > 0 && (() => {
                const amt = parseFloat(totalAmount);
                const gstAmt = Math.round(amt * gstRate / (100 + gstRate) * 100) / 100;
                const baseAmt = Math.round((amt - gstAmt) * 100) / 100;
                return (
                  <p className="text-xs text-muted-foreground">
                    Base ₹{baseAmt.toLocaleString("en-IN", { minimumFractionDigits: 2 })} + GST ₹{gstAmt.toLocaleString("en-IN", { minimumFractionDigits: 2 })} = Total ₹{amt.toLocaleString("en-IN", { minimumFractionDigits: 2 })}
                  </p>
                );
              })()}
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
              {/* Due-date suggestion (due_date_learning) */}
              {!dueDateHintDismissed && hints?.due_date_suggestion && !dueDate && (
                <div className="flex items-center justify-between gap-2 rounded border border-blue-200 bg-blue-50 px-2.5 py-1.5 text-xs text-blue-800">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <Lightbulb className="h-3.5 w-3.5 text-blue-500 shrink-0" />
                    <span>
                      Suggested: <strong>{hints.due_date_suggestion.date}</strong>
                      {" "}({hints.due_date_suggestion.net_days}d · {hints.due_date_suggestion.sample_size} bills)
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <button
                      type="button"
                      onClick={() => setDueDate(hints.due_date_suggestion!.date)}
                      className="font-medium text-blue-700 hover:text-blue-900 underline"
                    >Use</button>
                    <button type="button" onClick={() => setDueDateHintDismissed(true)}
                      className="text-blue-500 hover:text-blue-700">
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                </div>
              )}
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
              onFocus={() => setNotesFocused(true)}
              onBlur={() => setTimeout(() => setNotesFocused(false), 150)}
              rows={2}
            />
            {/* Past-notes suggestion chips (description_templates) */}
            {notesFocused && noteSuggestions.length > 0 && (
              <div className="flex flex-wrap gap-1.5 pt-0.5">
                {noteSuggestions.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onMouseDown={(e) => {
                      e.preventDefault(); // keep textarea focused
                      setNotes(s);
                      setNoteSuggestions([]);
                    }}
                    className="text-xs bg-muted hover:bg-muted/70 border border-border rounded-full px-2.5 py-1 text-foreground/80 transition-colors text-left max-w-[280px] truncate"
                    title={s}
                  >
                    {s}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Batch-date suggestion (batch_date_suggestion) */}
          {hints?.batch_suggestion && (
            <div className="flex items-center gap-2 rounded border border-green-200 bg-green-50 px-2.5 py-2 text-xs text-green-800">
              <CalendarClock className="h-3.5 w-3.5 text-green-600 shrink-0" />
              <span>
                <strong>Payment batch:</strong> This vendor&apos;s bills are usually paid on the{" "}
                <strong>{hints.batch_suggestion.batch_type === "immediate" ? "same day" : hints.batch_suggestion.batch_type}</strong>
                {" "}({hints.batch_suggestion.frequency}/{hints.batch_suggestion.sample_size} bills).
                {" "}This will be set automatically on approval.
              </span>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="flex justify-end">
        <Button onClick={handleSubmit} disabled={submitting || !!amountError} size="lg">
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
