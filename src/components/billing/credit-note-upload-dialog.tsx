"use client";

/**
 * Manual credit-note cancellation for a Tally-issued invoice.
 *
 * The accountant creates the Credit Note in Tally themselves (same as they
 * already do for the original invoice via the Tally Inbox upload flow), then
 * records the resulting number/date/PDF here. Full-amount cancellation only
 * — no partial credit notes. Posts to POST /api/billing-statements/[id]/upload-credit-note.
 */

import { useState } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
import { toast } from "sonner";
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
import { formatCurrency } from "@/lib/utils";

export interface CreditNoteStatementInfo {
  id: string;
  statement_number: string | null;
  tally_invoice_number: string | null;
  total_amount: number;
  payment_status: string;
}

interface Props {
  statement: CreditNoteStatementInfo;
  onCancelled: () => void;
  onClose: () => void;
}

export function CreditNoteUploadDialog({ statement, onCancelled, onClose }: Props) {
  const [creditNoteNumber, setCreditNoteNumber] = useState("");
  const [creditNoteDate, setCreditNoteDate] = useState(new Date().toISOString().slice(0, 10));
  const [reason, setReason] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  const canSubmit =
    creditNoteNumber.trim().length > 0 &&
    !!creditNoteDate &&
    reason.trim().length >= 5 &&
    !!file &&
    !submitting;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit || !file) return;
    setSubmitting(true);
    setServerError(null);
    try {
      const formData = new FormData();
      formData.append("file", file);
      formData.append(
        "meta",
        JSON.stringify({
          credit_note_number: creditNoteNumber.trim(),
          credit_note_date: creditNoteDate,
          credit_note_amount: statement.total_amount,
          reason: reason.trim(),
        }),
      );

      const res = await fetch(`/api/billing-statements/${statement.id}/upload-credit-note`, {
        method: "POST",
        body: formData,
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(body.error || `HTTP ${res.status}`);
      }

      toast.success(`Invoice cancelled — credit note ${body.tally_credit_note_number} recorded`);
      onCancelled();
    } catch (err) {
      setServerError(err instanceof Error ? err.message : "Failed to record credit note");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Cancel Invoice via Credit Note</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-3">
          <div className="text-xs text-muted-foreground">
            {statement.statement_number} · Tally invoice{" "}
            <span className="font-mono">{statement.tally_invoice_number ?? "—"}</span>
          </div>

          {statement.payment_status !== "unpaid" && (
            <div className="rounded border border-amber-200 bg-amber-50 p-2.5 text-xs text-amber-900 flex items-start gap-1.5">
              <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
              <span>
                {formatCurrency(statement.total_amount)} was already collected against this invoice.
                Issuing a credit note does not automatically refund it — handle any refund separately.
              </span>
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="cn-number">Credit note number</Label>
            <Input
              id="cn-number"
              value={creditNoteNumber}
              onChange={(e) => setCreditNoteNumber(e.target.value)}
              placeholder="CN/A/26-27/1"
              required
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="cn-date">Credit note date</Label>
            <Input
              id="cn-date"
              type="date"
              value={creditNoteDate}
              onChange={(e) => setCreditNoteDate(e.target.value)}
              required
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="cn-amount">Credit note amount</Label>
            <Input id="cn-amount" value={formatCurrency(statement.total_amount)} disabled readOnly />
            <p className="text-xs text-muted-foreground">
              Full invoice amount — partial credit notes are not supported.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="cn-reason">Reason for cancellation</Label>
            <Textarea
              id="cn-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={2}
              required
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="cn-file">Credit note PDF</Label>
            <Input
              id="cn-file"
              type="file"
              accept="application/pdf,image/jpeg,image/png"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              required
            />
          </div>

          {serverError && (
            <div className="rounded border border-red-200 bg-red-50 p-2.5 text-xs text-red-900">
              {serverError}
            </div>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={submitting}>
              Cancel
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : "Record Credit Note & Cancel Invoice"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
