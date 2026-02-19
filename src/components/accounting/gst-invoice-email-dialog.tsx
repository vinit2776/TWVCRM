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
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Loader2, Mail } from "lucide-react";
import { toast } from "sonner";

interface GstInvoiceEmailDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  paymentId: string;
  contractNumber: string;
  company: string;
  leadEmail?: string;
  leadSecondaryEmail?: string;
  onSuccess: () => void;
}

export function GstInvoiceEmailDialog({
  open,
  onOpenChange,
  paymentId,
  contractNumber,
  company,
  leadEmail,
  leadSecondaryEmail,
  onSuccess,
}: GstInvoiceEmailDialogProps) {
  const [selectedEmails, setSelectedEmails] = useState<Set<string>>(
    new Set([leadEmail, leadSecondaryEmail].filter(Boolean) as string[])
  );
  const [sending, setSending] = useState(false);

  const availableEmails = [leadEmail, leadSecondaryEmail].filter(Boolean) as string[];

  const toggleEmail = (email: string) => {
    setSelectedEmails((prev) => {
      const next = new Set(prev);
      if (next.has(email)) {
        next.delete(email);
      } else {
        next.add(email);
      }
      return next;
    });
  };

  const handleSend = async () => {
    if (selectedEmails.size === 0) {
      toast.error("Select at least one recipient");
      return;
    }

    setSending(true);
    try {
      const res = await fetch(`/api/accounting/gst-invoices/${paymentId}/email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ recipients: Array.from(selectedEmails) }),
      });

      if (!res.ok) {
        const err = await res.json();
        toast.error(err.error || "Failed to send email");
        return;
      }

      toast.success("GST invoice emailed successfully");
      onSuccess();
      onOpenChange(false);
    } catch {
      toast.error("Network error");
    } finally {
      setSending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Email GST Invoice</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div>
            <p className="text-sm text-muted-foreground">
              Send GST invoice for <strong>{contractNumber}</strong> ({company}) to:
            </p>
          </div>

          {availableEmails.length > 0 ? (
            <div className="space-y-3">
              {availableEmails.map((email) => (
                <div key={email} className="flex items-center gap-3">
                  <Checkbox
                    id={email}
                    checked={selectedEmails.has(email)}
                    onCheckedChange={() => toggleEmail(email)}
                  />
                  <Label htmlFor={email} className="text-sm font-normal cursor-pointer">
                    {email}
                    {email === leadEmail && (
                      <span className="text-muted-foreground ml-1">(primary)</span>
                    )}
                    {email === leadSecondaryEmail && email !== leadEmail && (
                      <span className="text-muted-foreground ml-1">(secondary)</span>
                    )}
                  </Label>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              No email addresses found for this lead. Please add email addresses to the lead record.
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={handleSend}
            disabled={sending || selectedEmails.size === 0}
          >
            {sending ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Mail className="mr-2 h-4 w-4" />
            )}
            Send Invoice
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
