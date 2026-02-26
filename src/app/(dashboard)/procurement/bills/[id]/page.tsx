"use client";

import { useState, useEffect, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import {
  ChevronLeft, Loader2, Truck, FileText, Calendar, CreditCard, Package, ExternalLink,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import {
  BILL_PAYMENT_STATUS_LABELS, BILL_PAYMENT_STATUS_COLORS,
  BILL_PAYMENT_MODES, BILL_PAYMENT_MODE_LABELS,
} from "@/lib/constants";
import { formatDate, formatCurrency } from "@/lib/utils";
import type { VendorBill } from "@/types";

export default function VendorBillDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();

  const [bill, setBill] = useState<VendorBill | null>(null);
  const [loading, setLoading] = useState(true);
  const [paymentDialog, setPaymentDialog] = useState(false);
  const [paymentLoading, setPaymentLoading] = useState(false);

  const today = new Date().toISOString().split("T")[0];

  const [paymentAmount, setPaymentAmount] = useState("");
  const [paymentMode, setPaymentMode] = useState<"cash" | "upi" | "bank_transfer">("upi");
  const [paymentReference, setPaymentReference] = useState("");
  const [paymentDate, setPaymentDate] = useState(today);

  const fetchBill = useCallback(async () => {
    setLoading(true);
    const res = await fetch(`/api/procurement/bills/${id}`);
    if (res.ok) {
      const json = await res.json();
      setBill(json.data);
    } else {
      toast.error("Failed to load bill");
      router.push("/procurement/bills");
    }
    setLoading(false);
  }, [id, router]);

  useEffect(() => { fetchBill(); }, [fetchBill]);

  const openPaymentDialog = () => {
    if (!bill) return;
    const remaining = Number(bill.total_amount) - Number(bill.amount_paid);
    setPaymentAmount(remaining > 0 ? String(remaining) : "");
    setPaymentMode("upi");
    setPaymentReference("");
    setPaymentDate(today);
    setPaymentDialog(true);
  };

  const handleRecordPayment = async () => {
    const amount = parseFloat(paymentAmount);
    if (!paymentAmount || isNaN(amount) || amount <= 0) {
      toast.error("Enter a valid payment amount");
      return;
    }

    setPaymentLoading(true);
    try {
      const res = await fetch(`/api/procurement/bills/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "record_payment",
          amount,
          payment_mode: paymentMode,
          payment_reference: paymentReference.trim() || null,
          payment_date: paymentDate || null,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        toast.error(json.error || "Failed to record payment");
        return;
      }
      toast.success("Payment recorded successfully");
      setPaymentDialog(false);
      await fetchBill();
    } finally {
      setPaymentLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!bill) return null;

  const vendor = bill.procurement_vendors as { id: string; name: string; contact_name?: string; contact_phone?: string } | null;
  const remaining = Number(bill.total_amount) - Number(bill.amount_paid);

  return (
    <div className="space-y-6 max-w-4xl mx-auto">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={() => router.push("/procurement/bills")}>
            <ChevronLeft className="h-5 w-5" />
          </Button>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-bold font-mono">{bill.bill_number}</h1>
              <Badge variant="secondary" className={BILL_PAYMENT_STATUS_COLORS[bill.payment_status]}>
                {BILL_PAYMENT_STATUS_LABELS[bill.payment_status]}
              </Badge>
            </div>
            <p className="text-sm text-muted-foreground mt-0.5">
              {vendor?.name ?? "Unknown vendor"}
            </p>
          </div>
        </div>

        {bill.payment_status !== "paid" && (
          <Button
            onClick={openPaymentDialog}
            className="bg-green-600 hover:bg-green-700"
          >
            <CreditCard className="h-4 w-4 mr-1" /> Record Payment
          </Button>
        )}
      </div>

      {/* Details grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium text-muted-foreground">Bill Info</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center gap-2.5">
              <Truck className="h-4 w-4 text-muted-foreground flex-shrink-0" />
              <span className="text-sm">
                <span className="text-muted-foreground">Vendor: </span>
                <span className="font-medium">{vendor?.name ?? "—"}</span>
              </span>
            </div>
            {vendor?.contact_name && (
              <div className="flex items-center gap-2.5 pl-[26px]">
                <span className="text-xs text-muted-foreground">
                  {vendor.contact_name}
                  {vendor.contact_phone ? ` · ${vendor.contact_phone}` : ""}
                </span>
              </div>
            )}
            {bill.purchase_orders && (
              <div className="flex items-center gap-2.5">
                <Package className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                <span className="text-sm">
                  <span className="text-muted-foreground">Purchase Order: </span>
                  <Link
                    href={`/procurement/orders/${bill.purchase_orders.id}`}
                    className="text-primary hover:underline font-mono"
                  >
                    {bill.purchase_orders.po_number}
                  </Link>
                </span>
              </div>
            )}
            {bill.invoice_number && (
              <div className="flex items-center gap-2.5">
                <FileText className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                <span className="text-sm">
                  <span className="text-muted-foreground">Invoice #: </span>
                  {bill.invoice_number}
                </span>
              </div>
            )}
            <div className="flex items-center gap-2.5">
              <Calendar className="h-4 w-4 text-muted-foreground flex-shrink-0" />
              <span className="text-sm">
                <span className="text-muted-foreground">Invoice Date: </span>
                {formatDate(bill.invoice_date)}
              </span>
            </div>
            {bill.due_date && (
              <div className="flex items-center gap-2.5">
                <Calendar className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                <span className="text-sm">
                  <span className="text-muted-foreground">Due Date: </span>
                  <span className={bill.due_date < today && bill.payment_status !== "paid" ? "text-amber-700 font-medium" : ""}>
                    {formatDate(bill.due_date)}
                    {bill.due_date < today && bill.payment_status !== "paid" && " (Overdue)"}
                  </span>
                </span>
              </div>
            )}
            {bill.invoice_file_url && (
              <div className="flex items-center gap-2.5">
                <FileText className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                <span className="text-sm">
                  <span className="text-muted-foreground">Invoice File: </span>
                  <a
                    href={bill.invoice_file_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary hover:underline inline-flex items-center gap-1"
                  >
                    View Invoice <ExternalLink className="h-3 w-3" />
                  </a>
                </span>
              </div>
            )}
            {bill.notes && (
              <div className="flex items-start gap-2.5">
                <FileText className="h-4 w-4 text-muted-foreground flex-shrink-0 mt-0.5" />
                <span className="text-sm">
                  <span className="text-muted-foreground">Notes: </span>
                  {bill.notes}
                </span>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium text-muted-foreground">Payment Summary</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex justify-between items-center">
              <span className="text-sm text-muted-foreground">Total Amount</span>
              <span className="text-xl font-bold">{formatCurrency(bill.total_amount)}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Amount Paid</span>
              <span className="font-medium text-green-700">{formatCurrency(bill.amount_paid)}</span>
            </div>
            <div className="flex justify-between text-sm border-t pt-2">
              <span className="font-medium">Balance Due</span>
              <span className={`font-bold ${remaining > 0 ? "text-red-600" : "text-green-600"}`}>
                {formatCurrency(remaining > 0 ? remaining : 0)}
              </span>
            </div>
            {bill.payment_mode && (
              <>
                <div className="border-t pt-2 space-y-1.5">
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">Payment Mode</span>
                    <span>{BILL_PAYMENT_MODE_LABELS[bill.payment_mode as keyof typeof BILL_PAYMENT_MODE_LABELS] ?? bill.payment_mode}</span>
                  </div>
                  {bill.payment_reference && (
                    <div className="flex justify-between text-sm">
                      <span className="text-muted-foreground">Reference</span>
                      <span className="font-mono text-xs">{bill.payment_reference}</span>
                    </div>
                  )}
                  {bill.payment_date && (
                    <div className="flex justify-between text-sm">
                      <span className="text-muted-foreground">Payment Date</span>
                      <span>{formatDate(bill.payment_date)}</span>
                    </div>
                  )}
                </div>
              </>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Record Payment Dialog */}
      <Dialog open={paymentDialog} onOpenChange={setPaymentDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Record Payment</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <p className="text-sm text-muted-foreground">
              Balance due: <strong>{formatCurrency(remaining > 0 ? remaining : 0)}</strong>
            </p>
            <div className="space-y-1.5">
              <Label>Amount (₹) <span className="text-red-500">*</span></Label>
              <Input
                type="number"
                min="0.01"
                step="0.01"
                placeholder="0.00"
                value={paymentAmount}
                onChange={(e) => setPaymentAmount(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Payment Mode <span className="text-red-500">*</span></Label>
              <Select value={paymentMode} onValueChange={(v) => setPaymentMode(v as typeof paymentMode)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {BILL_PAYMENT_MODES.map((m) => (
                    <SelectItem key={m} value={m}>{BILL_PAYMENT_MODE_LABELS[m]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Reference / Transaction ID</Label>
              <Textarea
                placeholder="UTR number, cheque no., receipt no. (optional)"
                value={paymentReference}
                onChange={(e) => setPaymentReference(e.target.value)}
                rows={2}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Payment Date</Label>
              <Input
                type="date"
                value={paymentDate}
                onChange={(e) => setPaymentDate(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPaymentDialog(false)}>Cancel</Button>
            <Button
              className="bg-green-600 hover:bg-green-700"
              onClick={handleRecordPayment}
              disabled={paymentLoading}
            >
              {paymentLoading && <Loader2 className="h-4 w-4 animate-spin mr-1" />}
              Record Payment
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
