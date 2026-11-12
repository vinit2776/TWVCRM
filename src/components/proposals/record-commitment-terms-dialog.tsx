"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PROPOSAL_MAX_TENURE_MONTHS, maxNoticePeriodMonths, validateCommitmentTerms } from "@/lib/proposal-terms";
import type { CommitmentValues } from "@/lib/contract-commitment";

function monthLabel(m: number) {
  return `${m} month${m !== 1 ? "s" : ""}`;
}

/**
 * One-time backfill of the term / lock-in / notice period agreed on a proposal
 * created before these were captured. See POST /api/proposals/[id]/commitment-terms.
 */
export function RecordCommitmentTermsDialog({
  proposalId,
  proposalNumber,
  open,
  onOpenChange,
  onRecorded,
}: {
  proposalId: string;
  proposalNumber: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRecorded: (terms: CommitmentValues) => void;
}) {
  const [tenure, setTenure] = useState<number | null>(null);
  const [lockIn, setLockIn] = useState<number | null>(null);
  const [notice, setNotice] = useState<number | null>(null);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);

  const maxNotice = tenure != null && lockIn != null ? maxNoticePeriodMonths(tenure, lockIn) : null;

  const handleSave = async () => {
    const error = validateCommitmentTerms({ tenure_months: tenure, lock_in_months: lockIn, notice_period_months: notice });
    if (error) return toast.error(error);
    if (note.trim().length < 10) return toast.error("Say where these terms were agreed");

    setSaving(true);
    const terms = { tenure_months: tenure as number, lock_in_months: lockIn as number, notice_period_months: notice as number };
    const res = await fetch(`/api/proposals/${proposalId}/commitment-terms`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...terms, note: note.trim() }),
    });
    setSaving(false);
    if (!res.ok) {
      const err = await res.json().catch(() => null);
      return toast.error(err?.error || "Failed to record the agreed terms");
    }
    toast.success(`Agreed terms recorded on ${proposalNumber}`);
    onRecorded(terms);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Record agreed terms — {proposalNumber}</DialogTitle>
          <DialogDescription>
            Enter what the customer accepted. This can only be recorded once, and the contract will be locked to it.
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className="space-y-2">
            <Label htmlFor="record-tenure">Term</Label>
            <Select
              value={tenure != null ? String(tenure) : ""}
              onValueChange={(v) => {
                const t = parseInt(v);
                setTenure(t);
                const l = lockIn != null ? Math.min(lockIn, t) : null;
                setLockIn(l);
                if (l != null && notice != null) setNotice(Math.min(notice, maxNoticePeriodMonths(t, l)));
              }}
            >
              <SelectTrigger id="record-tenure">
                <SelectValue placeholder="Select" />
              </SelectTrigger>
              <SelectContent>
                {Array.from({ length: PROPOSAL_MAX_TENURE_MONTHS }, (_, i) => i + 1).map((m) => (
                  <SelectItem key={m} value={String(m)}>{monthLabel(m)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="record-lock-in">Lock-in</Label>
            <Select
              value={lockIn != null ? String(lockIn) : ""}
              disabled={tenure == null}
              onValueChange={(v) => {
                const l = parseInt(v);
                setLockIn(l);
                if (tenure != null && notice != null) setNotice(Math.min(notice, maxNoticePeriodMonths(tenure, l)));
              }}
            >
              <SelectTrigger id="record-lock-in">
                <SelectValue placeholder={tenure == null ? "Term first" : "Select"} />
              </SelectTrigger>
              <SelectContent>
                {Array.from({ length: tenure ?? 0 }, (_, i) => i + 1).map((m) => (
                  <SelectItem key={m} value={String(m)}>{monthLabel(m)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="record-notice">Notice period</Label>
            <Select value={notice != null ? String(notice) : ""} disabled={maxNotice == null} onValueChange={(v) => setNotice(parseInt(v))}>
              <SelectTrigger id="record-notice">
                <SelectValue placeholder={maxNotice == null ? "Lock-in first" : "Select"} />
              </SelectTrigger>
              <SelectContent>
                {Array.from({ length: (maxNotice ?? -1) + 1 }, (_, i) => i).map((m) => (
                  <SelectItem key={m} value={String(m)}>{m === 0 ? "None (0 months)" : monthLabel(m)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <div className="space-y-2">
          <Label htmlFor="record-note">Where were these agreed?</Label>
          <Textarea
            id="record-note"
            rows={2}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Signed proposal PDF / customer email of 12 Sep"
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Record terms
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
