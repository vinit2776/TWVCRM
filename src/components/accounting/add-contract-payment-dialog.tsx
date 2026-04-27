"use client";

import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Loader2, Upload } from "lucide-react";
import { toast } from "sonner";
import { prepareUpload, UploadTooLargeError } from "@/lib/uploads/upload-gate";
import { CONTRACT_PAYMENT_MODE_LABELS } from "@/lib/constants";

interface AddContractPaymentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
  contractId: string;
  accountingPeriodId?: string;
}

export function AddContractPaymentDialog({
  open,
  onOpenChange,
  onSuccess,
  contractId,
  accountingPeriodId,
}: AddContractPaymentDialogProps) {
  const [amount, setAmount] = useState<number>(0);
  const [paymentMode, setPaymentMode] = useState<string>("bank_transfer");
  const [paymentReference, setPaymentReference] = useState("");
  const [paymentDate, setPaymentDate] = useState(new Date().toISOString().split("T")[0]);
  const [notes, setNotes] = useState("");
  const [screenshotFile, setScreenshotFile] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async () => {
    if (!amount || amount <= 0) {
      toast.error("Amount must be positive");
      return;
    }
    if (!paymentDate) {
      toast.error("Payment date is required");
      return;
    }

    setSubmitting(true);
    try {
      // Create payment
      const res = await fetch("/api/accounting/contract-payments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contract_id: contractId,
          accounting_period_id: accountingPeriodId || undefined,
          amount,
          payment_mode: paymentMode,
          payment_reference: paymentReference.trim() || undefined,
          payment_date: paymentDate,
          notes: notes.trim() || undefined,
        }),
      });

      if (!res.ok) {
        const err = await res.json();
        toast.error(err.error || "Failed to record payment");
        return;
      }

      const { data: payment } = await res.json();

      // Upload screenshot if provided — normalize client-side before send.
      if (screenshotFile && payment?.id) {
        try {
          const processed = await prepareUpload(screenshotFile);
          if (processed) {
            const formData = new FormData();
            formData.append("file", processed);
            await fetch(`/api/accounting/contract-payments/${payment.id}/screenshot`, {
              method: "POST",
              body: formData,
            });
          }
        } catch (e) {
          if (e instanceof UploadTooLargeError) {
            toast.error(e.message);
          } else {
            toast.error(e instanceof Error ? e.message : "Screenshot upload failed");
          }
        }
      }

      toast.success("Payment recorded");
      onSuccess();
      onOpenChange(false);
      resetForm();
    } catch {
      toast.error("Network error");
    } finally {
      setSubmitting(false);
    }
  };

  const resetForm = () => {
    setAmount(0);
    setPaymentMode("bank_transfer");
    setPaymentReference("");
    setPaymentDate(new Date().toISOString().split("T")[0]);
    setNotes("");
    setScreenshotFile(null);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Record Payment</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <Label htmlFor="pay-amount">Amount (₹)</Label>
            <Input
              id="pay-amount"
              type="number"
              min={0}
              step={0.01}
              value={amount || ""}
              onChange={(e) => setAmount(parseFloat(e.target.value) || 0)}
              placeholder="Enter amount"
            />
          </div>

          <div>
            <Label htmlFor="pay-mode">Payment Mode</Label>
            <Select value={paymentMode} onValueChange={setPaymentMode}>
              <SelectTrigger id="pay-mode">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(CONTRACT_PAYMENT_MODE_LABELS).map(([key, label]) => (
                  <SelectItem key={key} value={key}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div>
            <Label htmlFor="pay-ref">Payment Reference</Label>
            <Input
              id="pay-ref"
              value={paymentReference}
              onChange={(e) => setPaymentReference(e.target.value)}
              placeholder="Transaction ID, cheque no., etc."
            />
          </div>

          <div>
            <Label htmlFor="pay-date">Payment Date</Label>
            <Input
              id="pay-date"
              type="date"
              value={paymentDate}
              onChange={(e) => setPaymentDate(e.target.value)}
            />
          </div>

          {(paymentMode === "upi" || paymentMode === "bank_transfer") && (
            <div>
              <Label>Payment Screenshot</Label>
              <div className="mt-1">
                <label className="flex items-center gap-2 cursor-pointer border border-dashed rounded-md p-3 hover:bg-accent/50 transition-colors">
                  <Upload className="h-4 w-4 text-muted-foreground" />
                  <span className="text-sm text-muted-foreground">
                    {screenshotFile ? screenshotFile.name : "Upload screenshot"}
                  </span>
                  <input
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={(e) => setScreenshotFile(e.target.files?.[0] || null)}
                  />
                </label>
              </div>
            </div>
          )}

          <div>
            <Label htmlFor="pay-notes">Notes</Label>
            <Textarea
              id="pay-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Optional notes"
              rows={2}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={submitting}>
            {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Record Payment
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
