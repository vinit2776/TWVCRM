"use client";

/**
 * SendPiDialog — optional proforma invoice for a booking, sent with the payment
 * link so the customer can pay in advance. Previewing builds the PDF only; it
 * creates no link and contacts nobody. Nothing reaches the customer until
 * "Send PI" is clicked.
 */

import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { RecipientFields, recipientsValid } from "@/components/bookings/recipient-fields";
import { FileText, Loader2, Mail } from "lucide-react";
import { toast } from "sonner";
import { formatCurrency } from "@/lib/utils";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  bookingId: string;
  piNumber: string;
  amountDue: number;
  customerEmail: string | null;
  /** Set when a PI already went out, so the dialog reads as a resend. */
  alreadySentAt: string | null;
  onSent: () => void;
}

export function SendPiDialog({
  open, onOpenChange, bookingId, piNumber, amountDue, customerEmail, alreadySentAt, onSent,
}: Props) {
  const [previewing, setPreviewing] = useState(false);
  const [sending, setSending] = useState(false);
  const [recipient, setRecipient] = useState(customerEmail ?? "");
  const [cc, setCc] = useState("");
  // Starts from the booking's email each time the dialog opens.
  useEffect(() => { if (open) { setRecipient(customerEmail ?? ""); setCc(""); } }, [open, customerEmail]);
  const recipientValid = recipientsValid(recipient, cc);

  const preview = async () => {
    setPreviewing(true);
    try {
      const res = await fetch(`/api/bookings/${bookingId}/pi`);
      if (!res.ok) {
        const json = await res.json().catch(() => null);
        toast.error(json?.error || "Couldn't build the preview");
        return;
      }
      const url = URL.createObjectURL(await res.blob());
      window.open(url, "_blank", "noopener");
    } finally {
      setPreviewing(false);
    }
  };

  const send = async () => {
    setSending(true);
    try {
      // The link is created with Razorpay's own notification off: the PI email
      // is the one message the customer gets.
      const linkRes = await fetch("/api/payments/create-payment-link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ booking_id: bookingId, skip_notify: true }),
      });
      if (!linkRes.ok) {
        const json = await linkRes.json().catch(() => null);
        toast.error(json?.error || "Couldn't create the payment link");
        return;
      }
      const res = await fetch(`/api/bookings/${bookingId}/pi`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to: recipient.trim(), cc }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        toast.error(json?.error || "Couldn't send the PI");
        return;
      }
      if (json.data.warning) {
        toast.warning(`PI emailed to ${json.data.pi_sent_to}`, { description: json.data.warning, duration: 15000 });
      } else {
        toast.success(`PI emailed to ${json.data.pi_sent_to}`, {
          description: "Payment status updates by itself when the customer pays.",
        });
      }
      onSent();
      onOpenChange(false);
    } finally {
      setSending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[460px]">
        <DialogHeader>
          <DialogTitle>{alreadySentAt ? "Resend proforma invoice" : "Send proforma invoice"}</DialogTitle>
        </DialogHeader>

        <div className="space-y-3 text-sm">
          <div className="rounded-lg border bg-card p-3 space-y-1">
            <div className="flex justify-between"><span className="text-muted-foreground">PI number</span><span className="font-medium">{piNumber}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Amount payable</span><span className="font-semibold">{formatCurrency(amountDue)}</span></div>
          </div>
          <RecipientFields to={recipient} cc={cc} onTo={setRecipient} onCc={setCc} savedEmail={customerEmail} idPrefix="pi" />
          <p className="text-xs text-muted-foreground">
            The PI is optional. The customer can pay with the link in advance or at the counter on arrival.
            It is not a tax invoice. Over usage and additional facilities are charged as applicable, and the GST invoice is provided on full payment.
          </p>
        </div>

        <div className="flex justify-between gap-2 pt-1">
          <Button variant="outline" size="sm" onClick={preview} disabled={previewing}>
            {previewing ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <FileText className="mr-1 h-4 w-4" />}
            Preview PDF
          </Button>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button size="sm" onClick={send} disabled={sending || !recipientValid}>
              {sending ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Mail className="mr-1 h-4 w-4" />}
              Send PI
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
