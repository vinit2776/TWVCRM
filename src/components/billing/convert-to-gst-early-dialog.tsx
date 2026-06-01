"use client";

import { useState } from "react";
import { AlertTriangle, FileCheck, Loader2, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";

interface ConvertToGstEarlyDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  statementId: string;
  statementNumber: string;
  customerName: string;
  customerEmail: string | null | undefined;
  periodLabel: string;
  totalAmount: number;
  hasExistingPaymentLink: boolean;
  onSuccess: () => void;
}

export function ConvertToGstEarlyDialog({
  open,
  onOpenChange,
  statementId,
  statementNumber,
  customerName,
  customerEmail,
  periodLabel,
  totalAmount,
  hasExistingPaymentLink,
  onSuccess,
}: ConvertToGstEarlyDialogProps) {
  const [reason, setReason] = useState("");
  const [sendEmail, setSendEmail] = useState(true);
  const [loading, setLoading] = useState(false);

  const amountFormatted = Math.round(totalAmount).toLocaleString("en-IN", { maximumFractionDigits: 0 });
  const reasonValid = reason.trim().length >= 5;

  async function handleConfirm() {
    if (!reasonValid) {
      toast.error("Please enter a reason (at least 5 characters)");
      return;
    }

    setLoading(true);
    try {
      const res = await fetch(`/api/billing-statements/${statementId}/convert-to-gst-early`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: reason.trim(), sendEmail }),
      });
      const json = await res.json() as { success?: boolean; invoiceNumber?: string; error?: string; emailedTo?: string };

      if (!res.ok) {
        toast.error(json.error || "Failed to issue early GST invoice");
        return;
      }

      toast.success(
        sendEmail && json.emailedTo
          ? `Tax Invoice ${json.invoiceNumber} issued and emailed to ${json.emailedTo}`
          : `Tax Invoice ${json.invoiceNumber} issued. Email skipped — send manually if needed.`,
        { duration: 6000 }
      );
      onOpenChange(false);
      setReason("");
      setSendEmail(true);
      onSuccess();
    } catch {
      toast.error("Network error — please try again");
    } finally {
      setLoading(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!loading) onOpenChange(v); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-amber-700">
            <AlertTriangle className="h-5 w-5 shrink-0" />
            Issue GST Invoice — Override Proforma
          </DialogTitle>
          <DialogDescription>
            This action cancels the proforma and issues a formal tax invoice immediately,
            before payment is received.
          </DialogDescription>
        </DialogHeader>

        {/* What will happen */}
        <div className="rounded-lg border bg-muted/40 p-4 space-y-2 text-sm">
          <p className="font-medium text-foreground mb-3">What will happen:</p>
          <div className="flex items-start gap-2">
            <X className="h-4 w-4 text-destructive mt-0.5 shrink-0" />
            <span>
              Proforma Invoice <strong>{statementNumber}</strong> will be marked cancelled
            </span>
          </div>
          {hasExistingPaymentLink && (
            <div className="flex items-start gap-2">
              <X className="h-4 w-4 text-destructive mt-0.5 shrink-0" />
              <span>The existing payment link will be cancelled on Razorpay</span>
            </div>
          )}
          <div className="flex items-start gap-2">
            <FileCheck className="h-4 w-4 text-green-600 mt-0.5 shrink-0" />
            <span>
              A Tax Invoice will be generated for{" "}
              <strong>
                {customerName} — {periodLabel} — ₹{amountFormatted}
              </strong>
            </span>
          </div>
          <div className="flex items-start gap-2">
            <FileCheck className="h-4 w-4 text-green-600 mt-0.5 shrink-0" />
            <span>
              Invoice date = <strong>today</strong> · Due date = <strong>immediate</strong>
            </span>
          </div>
          {hasExistingPaymentLink && (
            <div className="flex items-start gap-2">
              <FileCheck className="h-4 w-4 text-green-600 mt-0.5 shrink-0" />
              <span>A new payment link will be created referencing the Tax Invoice</span>
            </div>
          )}
          <div className="flex items-start gap-2">
            <FileCheck className="h-4 w-4 text-green-600 mt-0.5 shrink-0" />
            <span>
              All future reminders will reference the Tax Invoice, with a note about the
              cancelled proforma so the customer has continuity
            </span>
          </div>
        </div>

        <Separator />

        {/* Reason */}
        <div className="space-y-1.5">
          <Label htmlFor="override-reason">
            Reason <span className="text-destructive">*</span>
          </Label>
          <Textarea
            id="override-reason"
            placeholder="e.g. Customer's procurement policy requires a tax invoice before releasing payment"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            disabled={loading}
            className="resize-none"
          />
          <p className="text-xs text-muted-foreground">
            Recorded in the audit log and appended to the statement notes.
          </p>
        </div>

        {/* Send email toggle */}
        <div className="flex items-center justify-between rounded-lg border p-3">
          <div className="space-y-0.5">
            <Label htmlFor="send-email-toggle" className="cursor-pointer">
              Email Tax Invoice to customer
            </Label>
            <p className="text-xs text-muted-foreground">
              {customerEmail
                ? `Will send to ${customerEmail} with the invoice PDF attached`
                : "No email on file — toggle has no effect"}
            </p>
          </div>
          <Switch
            id="send-email-toggle"
            checked={sendEmail}
            onCheckedChange={setSendEmail}
            disabled={loading || !customerEmail}
          />
        </div>

        {/* Irreversibility warning */}
        <div className="rounded-md bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-800">
          <strong>This cannot be undone.</strong> A GST invoice, once issued, is a legal
          tax document. The proforma will be permanently cancelled.
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={loading}>
            Cancel
          </Button>
          <Button
            onClick={handleConfirm}
            disabled={loading || !reasonValid}
            className="bg-amber-600 hover:bg-amber-700 text-white"
          >
            {loading ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <FileCheck className="mr-2 h-4 w-4" />
            )}
            Confirm &amp; Issue Tax Invoice
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
