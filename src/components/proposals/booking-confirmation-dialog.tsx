"use client";

import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  CheckCircle2,
  Loader2,
  Mail,
  MessageSquare,
  ShieldCheck,
  FileText,
} from "lucide-react";
import { toast } from "sonner";
import type { Proposal, Lead } from "@/types";

interface BookingConfirmationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  proposal: Proposal & { lead?: Lead };
  onSuccess: () => void;
}

/**
 * Shown when the CRM user clicks "Accept" on a proposal.
 *
 * Generates the proposal PDF client-side, then POSTs to /api/proposals/[id]/accept
 * which:
 *   1. Marks proposal → accepted
 *   2. Creates Razorpay deposit link (if deposit required)
 *   3. Sends booking-confirmation email (PDF attached + deposit button)
 *   4. Sends WhatsApp text (deposit link)
 *   5. Sends WhatsApp document (proposal PDF)
 */
export function BookingConfirmationDialog({
  open,
  onOpenChange,
  proposal,
  onSuccess,
}: BookingConfirmationDialogProps) {
  const [submitting, setSubmitting] = useState(false);

  const lead = proposal.lead;
  const customerName = lead
    ? `${lead.first_name || ""} ${lead.last_name || ""}`.trim()
    : "Customer";
  const customerEmail = lead?.email;
  const customerPhone = lead?.phone || lead?.mobile;

  const depositAmount = Number(proposal.security_deposit_amount || 0);
  const depositMonths = Number(proposal.security_deposit_months || 0);
  const hasDeposit = depositAmount > 0;

  const handleAcceptAndSend = async () => {
    setSubmitting(true);
    try {
      // Generate proposal PDF on the client. Dynamic import keeps jsPDF + autotable
      // out of the initial bundle; loads only when the user accepts a proposal.
      const [{ generateProposalPDF }, sqRes] = await Promise.all([
        import("@/lib/pdf-generator"),
        fetch(`/api/proposals/${proposal.id}/service-quotas`).then((r) => r.ok ? r.json() : { data: [] }),
      ]);
      const doc = generateProposalPDF(proposal, lead || undefined, undefined, undefined, sqRes.data ?? []);
      const pdfArrayBuffer = doc.output("arraybuffer");
      const pdfBlob = new Blob([pdfArrayBuffer], { type: "application/pdf" });

      const formData = new FormData();
      formData.append("pdf", pdfBlob, `${proposal.proposal_number}.pdf`);

      const res = await fetch(`/api/proposals/${proposal.id}/accept`, {
        method: "POST",
        body: formData,
      });
      const json = await res.json();

      if (res.ok) {
        toast.success(
          `Proposal accepted. Booking confirmation sent to ${json.sent_to || customerEmail || "customer"}.`,
          { duration: 6000 }
        );
        onOpenChange(false);
        onSuccess();
      } else {
        toast.error(json.error || "Failed to accept proposal");
      }
    } catch (err) {
      console.error("[BookingConfirmationDialog]", err);
      toast.error("Unexpected error — please try again");
    } finally {
      setSubmitting(false);
    }
  };

  const handleAcceptOnly = async () => {
    setSubmitting(true);
    try {
      const res = await fetch(`/api/proposals/${proposal.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "accepted", accepted_at: new Date().toISOString() }),
      });
      if (res.ok) {
        toast.success("Proposal marked as accepted");
        onOpenChange(false);
        onSuccess();
      } else {
        const err = await res.json().catch(() => null);
        toast.error(err?.error || "Failed to update status");
      }
    } catch {
      toast.error("Unexpected error");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={!submitting ? onOpenChange : undefined}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CheckCircle2 className="h-5 w-5 text-green-600" />
            Accept Proposal — {proposal.proposal_number}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* Customer info */}
          <div className="rounded-lg border bg-muted/30 px-4 py-3 space-y-1 text-sm">
            <p className="font-medium">{customerName}</p>
            {customerEmail && <p className="text-muted-foreground">{customerEmail}</p>}
            {customerPhone && <p className="text-muted-foreground">{customerPhone}</p>}
          </div>

          {/* What will be sent */}
          <div className="space-y-2">
            <p className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
              What &quot;Accept &amp; Send&quot; does
            </p>

            <div className="space-y-2">
              <div className="flex items-start gap-3 rounded-md border px-3 py-2.5 text-sm">
                <CheckCircle2 className="h-4 w-4 text-green-600 mt-0.5 shrink-0" />
                <p>Marks proposal as <strong>Accepted</strong></p>
              </div>

              <div className="flex items-start gap-3 rounded-md border px-3 py-2.5 text-sm">
                <Mail className="h-4 w-4 text-primary mt-0.5 shrink-0" />
                <div>
                  <p className="font-medium">Booking confirmation email</p>
                  <p className="text-muted-foreground text-xs mt-0.5">
                    Proposal PDF attached
                    {hasDeposit && ` · Security deposit payment button (₹${depositAmount.toLocaleString("en-IN")})`}
                  </p>
                </div>
              </div>

              {hasDeposit && (
                <div className="flex items-start gap-3 rounded-md border px-3 py-2.5 text-sm">
                  <MessageSquare className="h-4 w-4 text-green-600 mt-0.5 shrink-0" />
                  <div>
                    <p className="font-medium">WhatsApp message</p>
                    <p className="text-muted-foreground text-xs mt-0.5">
                      Deposit payment link + proposal PDF document
                    </p>
                  </div>
                </div>
              )}

              {!hasDeposit && (
                <div className="flex items-start gap-3 rounded-md border px-3 py-2.5 text-sm">
                  <MessageSquare className="h-4 w-4 text-green-600 mt-0.5 shrink-0" />
                  <div>
                    <p className="font-medium">WhatsApp document</p>
                    <p className="text-muted-foreground text-xs mt-0.5">
                      Proposal PDF sent via WhatsApp
                    </p>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Deposit callout */}
          {hasDeposit && (
            <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2.5 flex items-start gap-2 text-sm">
              <ShieldCheck className="h-4 w-4 text-amber-600 mt-0.5 shrink-0" />
              <div>
                <p className="font-medium text-amber-800">
                  Security deposit · ₹{depositAmount.toLocaleString("en-IN")}
                  <Badge variant="outline" className="ml-2 text-[10px] border-amber-400 text-amber-700">
                    {depositMonths} month{depositMonths > 1 ? "s" : ""} · refundable
                  </Badge>
                </p>
                <p className="text-amber-700 text-xs mt-0.5">
                  A Razorpay payment link will be created and included in the email and WhatsApp.
                </p>
              </div>
            </div>
          )}

          {!customerEmail && (
            <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 flex items-center gap-2">
              <FileText className="h-3.5 w-3.5 shrink-0" />
              No email on file for this lead. &quot;Accept &amp; Send&quot; will still mark the proposal
              as accepted and attempt WhatsApp delivery, but no email will be sent.
            </div>
          )}
        </div>

        <div className="flex justify-between gap-2 pt-2">
          <Button
            variant="outline"
            onClick={handleAcceptOnly}
            disabled={submitting}
            className="text-muted-foreground"
          >
            {submitting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Accept Only
          </Button>
          <div className="flex gap-2">
            <Button
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button
              className="bg-green-600 hover:bg-green-700 text-white"
              onClick={handleAcceptAndSend}
              disabled={submitting}
            >
              {submitting
                ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Sending…</>
                : <><CheckCircle2 className="mr-2 h-4 w-4" />Accept &amp; Send</>
              }
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
