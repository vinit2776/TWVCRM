"use client";

import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Printer, Loader2 } from "lucide-react";
import { formatCurrency } from "@/lib/utils";

interface ReceiptData {
  receipt_number: string;
  date: string;
  company: string;
  pan_number?: string;
  contract_number: string;
  contract_title: string;
  amount: number;
  payment_mode: string;
  payment_reference?: string;
  notes?: string;
  received_by?: string;
  status: string;
  created_at: string;
  issuer: {
    name: string;
    brand: string;
    address: string;
    phone: string;
    gst: string;
  };
}

interface PaymentReceiptProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  paymentId: string | null;
}

export function PaymentReceipt({ open, onOpenChange, paymentId }: PaymentReceiptProps) {
  const [receipt, setReceipt] = useState<ReceiptData | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (open && paymentId) {
      setLoading(true);
      fetch(`/api/accounting/contract-payments/${paymentId}/receipt`)
        .then((r) => r.json())
        .then((d) => setReceipt(d.data || null))
        .catch(() => setReceipt(null))
        .finally(() => setLoading(false));
    }
  }, [open, paymentId]);

  const handlePrint = () => {
    window.print();
  };

  if (loading) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-md">
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin" />
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  if (!receipt) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Payment Receipt</DialogTitle>
        </DialogHeader>

        <div className="print:block" id="payment-receipt">
          <div className="border rounded-lg p-6 space-y-4">
            {/* Header */}
            <div className="text-center border-b pb-4">
              <h2 className="text-lg font-bold text-primary">{receipt.issuer.brand}</h2>
              <p className="text-xs text-muted-foreground">{receipt.issuer.name}</p>
              <p className="text-xs text-muted-foreground">{receipt.issuer.address}</p>
              <p className="text-xs text-muted-foreground">GST: {receipt.issuer.gst}</p>
            </div>

            {/* Receipt info */}
            <div className="flex justify-between text-sm">
              <div>
                <p><span className="text-muted-foreground">Receipt #:</span> <strong>{receipt.receipt_number}</strong></p>
                <p><span className="text-muted-foreground">Date:</span> {new Date(receipt.date).toLocaleDateString("en-IN", { year: "numeric", month: "long", day: "numeric" })}</p>
              </div>
              <div className="text-right">
                <p><span className="text-muted-foreground">Contract:</span> {receipt.contract_number}</p>
              </div>
            </div>

            {/* Customer */}
            <div className="text-sm">
              <p><span className="text-muted-foreground">Received from:</span> <strong>{receipt.company}</strong></p>
              {receipt.pan_number && (
                <p><span className="text-muted-foreground">PAN:</span> {receipt.pan_number}</p>
              )}
            </div>

            {/* Amount */}
            <div className="bg-muted/50 rounded-md p-4 text-center">
              <p className="text-sm text-muted-foreground">Amount Received</p>
              <p className="text-2xl font-bold text-primary">{formatCurrency(receipt.amount)}</p>
            </div>

            {/* Details */}
            <div className="grid grid-cols-2 gap-2 text-sm">
              <p><span className="text-muted-foreground">Payment Mode:</span> {receipt.payment_mode}</p>
              {receipt.payment_reference && (
                <p><span className="text-muted-foreground">Reference:</span> {receipt.payment_reference}</p>
              )}
              <p><span className="text-muted-foreground">For:</span> {receipt.contract_title}</p>
              {receipt.received_by && (
                <p><span className="text-muted-foreground">Received by:</span> {receipt.received_by}</p>
              )}
            </div>

            {receipt.notes && (
              <div className="text-sm">
                <p className="text-muted-foreground">Notes:</p>
                <p>{receipt.notes}</p>
              </div>
            )}

            {/* Footer */}
            <div className="border-t pt-4 text-center">
              <p className="text-xs text-muted-foreground">
                This is a computer-generated receipt and does not require a signature.
              </p>
              <p className="text-xs text-muted-foreground">{receipt.issuer.phone}</p>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          <Button onClick={handlePrint}>
            <Printer className="mr-2 h-4 w-4" />
            Print
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
