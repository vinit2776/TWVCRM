"use client";

/**
 * BookingEmailDialog — send or resend one of a booking's customer emails (the
 * confirmation, the access PIN) choosing who gets it: the saved address or another,
 * plus any CCs. Replaces buttons that sent straight to the saved address.
 */

import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Loader2, Mail } from "lucide-react";
import { toast } from "sonner";
import { RecipientFields, recipientsValid } from "@/components/bookings/recipient-fields";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  savedEmail: string | null;
  /** Sends it; resolves with an error message, or null on success. */
  onSend: (to: string, cc: string) => Promise<string | null>;
  successMessage: (to: string) => string;
  idPrefix: string;
}

export function BookingEmailDialog({ open, onOpenChange, title, savedEmail, onSend, successMessage, idPrefix }: Props) {
  const [to, setTo] = useState(savedEmail ?? "");
  const [cc, setCc] = useState("");
  const [sending, setSending] = useState(false);
  useEffect(() => { if (open) { setTo(savedEmail ?? ""); setCc(""); } }, [open, savedEmail]);

  const send = async () => {
    setSending(true);
    try {
      const error = await onSend(to.trim(), cc);
      if (error) {
        toast.error(error);
      } else {
        toast.success(successMessage(to.trim()));
        onOpenChange(false);
      }
    } finally {
      setSending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[460px]">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <RecipientFields to={to} cc={cc} onTo={setTo} onCc={setCc} savedEmail={savedEmail} idPrefix={idPrefix} />
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button size="sm" onClick={send} disabled={sending || !recipientsValid(to, cc)}>
            {sending ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Mail className="mr-1 h-4 w-4" />}
            Send
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
