"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Loader2, Plus, X, Mail } from "lucide-react";
import { toast } from "sonner";

interface EmailDocumentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  documentType: "proposal" | "invoice";
  documentId: string;
  documentNumber: string;
  leadEmail?: string;
  onGeneratePDF: () => string; // Returns base64 string
  onSuccess?: () => void;
}

export function EmailDocumentDialog({
  open,
  onOpenChange,
  documentType,
  documentId,
  documentNumber,
  leadEmail,
  onGeneratePDF,
  onSuccess,
}: EmailDocumentDialogProps) {
  const [recipients, setRecipients] = useState<string[]>(
    leadEmail ? [leadEmail] : []
  );
  const [newEmail, setNewEmail] = useState("");
  const [sending, setSending] = useState(false);

  const addRecipient = () => {
    const email = newEmail.trim().toLowerCase();
    if (!email) return;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      toast.error("Please enter a valid email address");
      return;
    }
    if (recipients.includes(email)) {
      toast.error("This email is already added");
      return;
    }
    setRecipients([...recipients, email]);
    setNewEmail("");
  };

  const removeRecipient = (email: string) => {
    setRecipients(recipients.filter((r) => r !== email));
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      addRecipient();
    }
  };

  const handleSend = async () => {
    if (recipients.length === 0) {
      toast.error("Please add at least one recipient");
      return;
    }

    setSending(true);

    try {
      // Generate PDF as base64
      const pdfBase64 = onGeneratePDF();

      const apiPath =
        documentType === "proposal"
          ? `/api/proposals/${documentId}/email`
          : `/api/invoices/${documentId}/email`;

      const res = await fetch(apiPath, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ recipients, pdfBase64 }),
      });

      if (res.ok) {
        toast.success(
          `${documentType === "proposal" ? "Proposal" : "Invoice"} sent to ${recipients.length} recipient${recipients.length > 1 ? "s" : ""}`
        );
        onOpenChange(false);
        onSuccess?.();
      } else {
        const err = await res.json().catch(() => null);
        toast.error(err?.error || "Failed to send email");
      }
    } catch {
      toast.error("Failed to generate PDF or send email");
    } finally {
      setSending(false);
    }
  };

  // Reset state when dialog opens
  const handleOpenChange = (isOpen: boolean) => {
    if (isOpen) {
      setRecipients(leadEmail ? [leadEmail] : []);
      setNewEmail("");
    }
    onOpenChange(isOpen);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Mail className="h-5 w-5" />
            Email {documentType === "proposal" ? "Proposal" : "Invoice"}
          </DialogTitle>
          <p className="text-sm text-muted-foreground">{documentNumber}</p>
        </DialogHeader>

        <div className="space-y-4">
          {/* Recipients */}
          <div className="space-y-2">
            <Label>Recipients</Label>

            {/* Recipient chips */}
            {recipients.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {recipients.map((email) => (
                  <Badge
                    key={email}
                    variant="secondary"
                    className="flex items-center gap-1 px-2 py-1"
                  >
                    {email}
                    <button
                      type="button"
                      onClick={() => removeRecipient(email)}
                      className="ml-1 rounded-full hover:bg-muted p-0.5"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </Badge>
                ))}
              </div>
            )}

            {/* Add email input */}
            <div className="flex gap-2">
              <Input
                placeholder="Add email address..."
                value={newEmail}
                onChange={(e) => setNewEmail(e.target.value)}
                onKeyDown={handleKeyDown}
                type="email"
              />
              <Button
                type="button"
                variant="outline"
                size="icon"
                onClick={addRecipient}
              >
                <Plus className="h-4 w-4" />
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Press Enter or click + to add more recipients
            </p>
          </div>

          {/* Actions */}
          <div className="flex justify-end gap-2 pt-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              onClick={handleSend}
              disabled={sending || recipients.length === 0}
            >
              {sending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {sending
                ? "Sending..."
                : `Send to ${recipients.length} recipient${recipients.length !== 1 ? "s" : ""}`}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
