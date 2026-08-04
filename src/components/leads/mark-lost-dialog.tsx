"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { LOST_REASONS, LOST_REASON_LABELS } from "@/lib/constants";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

interface MarkLostDialogProps {
  leadId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
}

export function MarkLostDialog({
  leadId,
  open,
  onOpenChange,
  onSuccess,
}: MarkLostDialogProps) {
  const [lostReason, setLostReason] = useState("");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const resetForm = () => {
    setLostReason("");
    setNotes("");
  };

  const handleOpenChange = (o: boolean) => {
    if (!o) resetForm();
    onOpenChange(o);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!lostReason) return;
    setSubmitting(true);

    const res = await fetch(`/api/leads/${leadId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "lost", lost_reason: lostReason }),
    });

    if (!res.ok) {
      setSubmitting(false);
      toast.error("Failed to mark lead as lost");
      return;
    }

    // Auto-log a "note" activity so the reason stays in the timeline,
    // matching the behavior of the full edit-form lost flow.
    if (notes.trim()) {
      await fetch(`/api/leads/${leadId}/activities`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "note",
          subject: "Lead marked as lost",
          description: notes.trim(),
        }),
      }).catch(() => {
        // Non-fatal — lead was saved successfully; activity log failure is silent
      });
    }

    setSubmitting(false);
    toast.success("Lead marked as lost");
    resetForm();
    onOpenChange(false);
    onSuccess();
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Mark Lead as Lost</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label>
              Lost Reason <span className="text-destructive">*</span>
            </Label>
            <Select value={lostReason} onValueChange={setLostReason}>
              <SelectTrigger>
                <SelectValue placeholder="Select a reason…" />
              </SelectTrigger>
              <SelectContent>
                {LOST_REASONS.map((r) => (
                  <SelectItem key={r} value={r}>
                    {LOST_REASON_LABELS[r]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label className="flex items-center gap-1">
              Additional notes
              <span className="text-xs text-muted-foreground font-normal">
                (logged as an activity)
              </span>
            </Label>
            <Textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="What happened? Budget issue, went with competitor, wrong timing…"
              rows={3}
            />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => handleOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              variant="destructive"
              disabled={submitting || !lostReason}
            >
              {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Mark as Lost
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
