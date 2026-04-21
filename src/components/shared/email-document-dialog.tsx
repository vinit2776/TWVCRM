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
import { Loader2, Plus, X, Mail, AlertTriangle, SendHorizonal } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { MessageCircle } from "lucide-react";
import { toast } from "sonner";

interface EmailDocumentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  documentType: "proposal" | "invoice" | "contract";
  documentId: string;
  documentNumber: string;
  leadEmail?: string;
  /** If provided, shows the "Also send via WhatsApp" checkbox */
  leadPhone?: string;
  onGeneratePDF: () => string | Promise<string>; // Returns base64 string (sync or async)
  onSuccess?: () => void;
}

export function EmailDocumentDialog({
  open,
  onOpenChange,
  documentType,
  documentId,
  documentNumber,
  leadEmail,
  leadPhone,
  onGeneratePDF,
  onSuccess,
}: EmailDocumentDialogProps) {
  const [recipients, setRecipients] = useState<string[]>(
    leadEmail ? [leadEmail] : []
  );
  const [newEmail, setNewEmail] = useState("");
  const [sending, setSending] = useState(false);
  const [sendWhatsApp, setSendWhatsApp] = useState(false);

  // ── Deposit link failure state ─────────────────────────────────────────────
  // When the API returns 422 + deposit_link_failed, we switch to a warning
  // state inside the dialog. The user must explicitly confirm to override.
  const [depositLinkError, setDepositLinkError] = useState<string | null>(null);
  // Cached PDF blob so we don't regenerate on retry
  const [cachedPdfBlob, setCachedPdfBlob] = useState<Blob | null>(null);

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

  // Core send function — forceSendWithoutLink bypasses the deposit-link guard
  const doSend = async (forceSendWithoutLink = false) => {
    if (recipients.length === 0) {
      toast.error("Please add at least one recipient");
      return;
    }

    setSending(true);

    try {
      // Generate PDF (use cached blob if retrying after a deposit-link failure)
      let pdfBlob: Blob;
      if (cachedPdfBlob && forceSendWithoutLink) {
        pdfBlob = cachedPdfBlob;
      } else {
        const pdfBase64 = await Promise.resolve(onGeneratePDF());
        const byteChars = atob(pdfBase64);
        const byteArray = new Uint8Array(byteChars.length);
        for (let i = 0; i < byteChars.length; i++) byteArray[i] = byteChars.charCodeAt(i);
        pdfBlob = new Blob([byteArray], { type: "application/pdf" });
        setCachedPdfBlob(pdfBlob);
      }

      const apiPath =
        documentType === "proposal"
          ? `/api/proposals/${documentId}/email`
          : documentType === "contract"
            ? `/api/contracts/${documentId}/email`
            : `/api/invoices/${documentId}/email`;

      const formData = new FormData();
      formData.append("recipients", JSON.stringify(recipients));
      formData.append("pdf", pdfBlob, "document.pdf");
      if (forceSendWithoutLink) {
        formData.append("force_send_without_link", "true");
      }
      if (sendWhatsApp && leadPhone) {
        formData.append("send_via_whatsapp", "true");
      }

      const res = await fetch(apiPath, { method: "POST", body: formData });

      if (res.ok) {
        const docLabel = documentType === "proposal" ? "Proposal" : documentType === "contract" ? "Agreement" : "Invoice";
        toast.success(`${docLabel} sent to ${recipients.length} recipient${recipients.length > 1 ? "s" : ""}`);
        setDepositLinkError(null);
        setCachedPdfBlob(null);
        onOpenChange(false);
        onSuccess?.();
        return;
      }

      const err = await res.json().catch(() => null);

      // 422 = deposit link creation failed — switch to warning state, don't close dialog
      if (res.status === 422 && err?.deposit_link_failed) {
        setDepositLinkError(err.razorpay_error || err.error || "Unknown Razorpay error");
        return;
      }

      toast.error(err?.error || "Failed to send email");
    } catch {
      toast.error("Failed to generate PDF or send email");
    } finally {
      setSending(false);
    }
  };

  const handleSend = () => doSend(false);
  const handleForceOverride = () => doSend(true);

  // Reset state when dialog opens/closes
  const handleOpenChange = (isOpen: boolean) => {
    if (isOpen) {
      setRecipients(leadEmail ? [leadEmail] : []);
      setNewEmail("");
      setDepositLinkError(null);
      setCachedPdfBlob(null);
      setSendWhatsApp(false);
    }
    onOpenChange(isOpen);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Mail className="h-5 w-5" />
            Email {documentType === "proposal" ? "Proposal" : documentType === "contract" ? "Agreement" : "Invoice"}
          </DialogTitle>
          <p className="text-sm text-muted-foreground">{documentNumber}</p>
        </DialogHeader>

        {/* ── Deposit link failure warning ── */}
        {depositLinkError ? (
          <div className="space-y-4">
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 space-y-2">
              <div className="flex items-start gap-2">
                <AlertTriangle className="h-5 w-5 text-amber-600 shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm font-semibold text-amber-900">
                    Security deposit payment link could not be created
                  </p>
                  <p className="text-xs text-amber-700 mt-1">
                    {depositLinkError}
                  </p>
                </div>
              </div>
              <p className="text-xs text-amber-800 bg-amber-100 rounded p-2 mt-2">
                The customer will receive the proposal PDF and bank transfer details, but <strong>no Razorpay payment button</strong>. You will need to send the payment link separately after fixing the issue.
              </p>
            </div>

            <div className="flex flex-col gap-2">
              <Button
                variant="outline"
                className="w-full border-amber-300 text-amber-900 hover:bg-amber-50"
                onClick={handleForceOverride}
                disabled={sending}
              >
                {sending
                  ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Sending…</>
                  : <><SendHorizonal className="mr-2 h-4 w-4" />Send anyway (without payment link)</>}
              </Button>
              <Button
                variant="ghost"
                className="w-full"
                onClick={() => { setDepositLinkError(null); setSending(false); }}
                disabled={sending}
              >
                Cancel — fix the issue first
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            {/* Recipients */}
            <div className="space-y-2">
              <Label>Recipients</Label>

              {recipients.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {recipients.map((email, idx) => {
                    const isPrimary = idx === 0;
                    return (
                      <Badge
                        key={email}
                        variant="secondary"
                        className={`flex items-center gap-1 px-2 py-1 ${isPrimary ? "bg-primary/10 text-primary border border-primary/20" : "bg-muted text-muted-foreground"}`}
                      >
                        <span className={`text-[10px] font-bold uppercase mr-0.5 ${isPrimary ? "text-primary" : "text-muted-foreground"}`}>
                          {isPrimary ? "To" : "CC"}
                        </span>
                        {email}
                        <button
                          type="button"
                          onClick={() => removeRecipient(email)}
                          className="ml-1 rounded-full hover:bg-muted p-0.5"
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </Badge>
                    );
                  })}
                </div>
              )}

              <div className="flex gap-2">
                <Input
                  placeholder="Add CC recipient..."
                  value={newEmail}
                  onChange={(e) => setNewEmail(e.target.value)}
                  onKeyDown={handleKeyDown}
                  type="email"
                />
                <Button type="button" variant="outline" size="icon" onClick={addRecipient}>
                  <Plus className="h-4 w-4" />
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                First recipient is <strong>To</strong>. Additional recipients are added as <strong>CC</strong>.
              </p>
            </div>

            {/* WhatsApp opt-in — only shown when phone is available */}
            {leadPhone && (
              <div className="flex items-center gap-2.5 rounded-md border bg-muted/40 px-3 py-2.5">
                <Checkbox
                  id="send-whatsapp"
                  checked={sendWhatsApp}
                  onCheckedChange={(v) => setSendWhatsApp(!!v)}
                />
                <label htmlFor="send-whatsapp" className="flex items-center gap-1.5 text-sm cursor-pointer select-none">
                  <MessageCircle className="h-4 w-4 text-green-600" />
                  Also send PDF via WhatsApp
                  <span className="text-muted-foreground text-xs">({leadPhone})</span>
                </label>
              </div>
            )}

            {/* Actions */}
            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button onClick={handleSend} disabled={sending || recipients.length === 0}>
                {sending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {sending
                  ? "Sending..."
                  : `Send to ${recipients.length} recipient${recipients.length !== 1 ? "s" : ""}`}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
