"use client";

/**
 * Review & send ONE existing rent statement from Billing → Unbilled →
 * "Current cycle — ready to send". Never creates a statement: it previews the
 * one that already exists and sends that same row, through the routes the
 * statement dialog and the Usage tab already use:
 *   draft     → POST finalize-and-send (finalizes + dispatches; rolls back to
 *               draft if dispatch fails; routes GST Direct to the Tally Inbox)
 *   finalized → POST send-proforma (the statement dialog's "Send Proforma")
 * Preview is read-only: proforma-pdf?preview=1 and preview-send.
 */

import { useEffect, useState } from "react";
import { Loader2, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import { formatCurrency } from "@/lib/utils";

export interface ReviewSendTarget {
  statementId: string;
  status: string;
  contractNumber: string;
  customerName: string;
  periodLabel: string;
  amount: number | null;
}

interface PreviewEmail { subject: string; to: string[]; html: string; no_contact: boolean }

export function ReviewSendStatementDialog({
  target,
  onClose,
  onSent,
}: {
  target: ReviewSendTarget | null;
  onClose: () => void;
  onSent: () => void | Promise<void>;
}) {
  const [tab, setTab] = useState<"invoice" | "email">("invoice");
  const [email, setEmail] = useState<PreviewEmail | null>(null);
  const [emailLoading, setEmailLoading] = useState(false);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (!target) return;
    setTab("invoice");
    setEmail(null);
    setEmailError(null);
    setEmailLoading(true);
    fetch(`/api/billing-statements/${target.statementId}/preview-send`)
      .then(async (res) => {
        const json = await res.json().catch(() => ({}));
        if (res.ok) setEmail(json.data as PreviewEmail);
        else setEmailError(json.error || "Email preview unavailable");
      })
      .catch(() => setEmailError("Email preview unavailable"))
      .finally(() => setEmailLoading(false));
  }, [target]);

  const send = async () => {
    if (!target) return;
    setSending(true);
    try {
      const isDraft = target.status === "draft";
      const res = await fetch(
        `/api/billing-statements/${target.statementId}/${isDraft ? "finalize-and-send" : "send-proforma"}`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) },
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(json.error || "Couldn't send this invoice");
        return;
      }
      const emailedTo: string | null = json.emailed_to ?? json.emailedTo ?? null;
      const noContact: boolean = json.no_contact ?? json.noContact ?? false;
      if (noContact) {
        toast.error("Raised, but nothing was emailed — no email or phone on file for this customer.");
      } else {
        toast.success(emailedTo ? `${target.contractNumber} sent to ${emailedTo}` : `${target.contractNumber} sent`);
      }
      onClose();
      await onSent();
    } catch {
      toast.error("Couldn't send this invoice");
    } finally {
      setSending(false);
    }
  };

  const noRecipient = !!email && email.no_contact;

  return (
    <Dialog open={!!target} onOpenChange={(open) => { if (!open && !sending) onClose(); }}>
      <DialogContent className="sm:max-w-3xl max-h-[90vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <Send className="h-4 w-4" />
            Review &amp; send — {target?.contractNumber}
          </DialogTitle>
          <DialogDescription>
            {target?.customerName} · {target?.periodLabel}
            {target?.amount != null ? ` · ${formatCurrency(target.amount)}` : ""}. This sends the invoice
            that already exists — nothing new is created. Nothing goes out until you click Send.
          </DialogDescription>
        </DialogHeader>

        <div className="flex gap-1 border-b">
          {(["invoice", "email"] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={`text-xs font-semibold px-3 py-2 border-b-2 ${tab === t ? "border-teal-700 text-teal-800" : "border-transparent text-muted-foreground"}`}
            >
              {t === "invoice" ? "Invoice PDF" : "Email"}
            </button>
          ))}
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto rounded-md bg-muted/30">
          {!target ? null : tab === "invoice" ? (
            <iframe
              title="Invoice preview"
              src={`/api/billing-statements/${target.statementId}/proforma-pdf?preview=1`}
              className="w-full h-[55vh] bg-white rounded"
            />
          ) : emailLoading ? (
            <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground py-10">
              <Loader2 className="h-4 w-4 animate-spin" />Loading email…
            </div>
          ) : !email ? (
            <p className="text-xs text-muted-foreground py-10 text-center">{emailError || "Email preview unavailable"}</p>
          ) : (
            <div className="p-3 space-y-2">
              <div className="bg-white rounded border text-xs px-3 py-2 space-y-0.5">
                <p><span className="text-muted-foreground">To:</span> {email.to.join(", ") || <span className="italic text-red-600">no email on file</span>}</p>
                <p><span className="text-muted-foreground">Subject:</span> <span className="font-medium">{email.subject}</span></p>
              </div>
              <iframe title="Email preview" srcDoc={email.html} className="w-full h-[45vh] bg-white rounded border" />
            </div>
          )}
        </div>

        <DialogFooter className="items-center gap-2">
          {email && (
            <p className={`text-xs mr-auto ${noRecipient ? "text-red-600" : "text-muted-foreground"}`}>
              {noRecipient ? "No email on file — add one on the lead before sending." : `Will email ${email.to.join(", ")}`}
            </p>
          )}
          <Button variant="outline" onClick={onClose} disabled={sending}>Cancel</Button>
          <Button onClick={send} disabled={sending || emailLoading || noRecipient}>
            {sending && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />}
            Send to customer
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
