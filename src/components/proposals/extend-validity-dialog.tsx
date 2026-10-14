"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { formatDate } from "@/lib/utils";

interface Props {
  proposalId: string;
  currentValidUntil?: string | null;
  isExpired: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called after a successful extend; editAfter is true when the user also wants to change terms. */
  onDone: (editAfter: boolean) => void;
}

function tomorrowPlus(days: number): string {
  const d = new Date(Date.now() + days * 86_400_000);
  return d.toISOString().slice(0, 10);
}

export function ExtendValidityDialog({ proposalId, currentValidUntil, isExpired, open, onOpenChange, onDone }: Props) {
  const [validUntil, setValidUntil] = useState(tomorrowPlus(14));
  const [reason, setReason] = useState("");
  const [editAfter, setEditAfter] = useState(false);
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (!reason.trim()) { toast.error("Enter a reason"); return; }
    setSaving(true);
    const res = await fetch(`/api/proposals/${proposalId}/extend`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ valid_until: validUntil, reason: reason.trim() }),
    });
    setSaving(false);
    if (res.ok) {
      toast.success(isExpired ? "Proposal revived" : "Validity extended");
      setReason("");
      setEditAfter(false);
      onOpenChange(false);
      onDone(editAfter);
    } else {
      const err = await res.json().catch(() => null);
      toast.error(err?.error || "Couldn't extend the proposal");
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{isExpired ? "Extend and revive proposal" : "Extend validity"}</DialogTitle>
          <DialogDescription>
            {isExpired
              ? "The proposal goes back to its previous status with the new date."
              : "Pushes the valid-until date forward. The status stays as it is."}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {currentValidUntil && (
            <p className="text-sm text-muted-foreground">Current date: {formatDate(currentValidUntil)}</p>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="ext-date">New valid until</Label>
            <Input id="ext-date" type="date" min={tomorrowPlus(1)} value={validUntil} onChange={(e) => setValidUntil(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ext-reason">Reason</Label>
            <Textarea id="ext-reason" rows={2} placeholder="Customer asked for more time" value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={editAfter} onCheckedChange={(v) => setEditAfter(v === true)} />
            Also edit terms (seats, rate) after extending
          </label>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>Cancel</Button>
          <Button onClick={submit} disabled={saving || !validUntil}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {isExpired ? "Revive proposal" : "Extend"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
