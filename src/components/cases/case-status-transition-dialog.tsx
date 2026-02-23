"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { CASE_STATUS_TRANSITIONS, CASE_STATUS_LABELS } from "@/lib/constants";
import { StatusBadge } from "@/components/shared/status-badge";

interface CaseStatusTransitionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  caseId: string;
  currentStatus: string;
  onSuccess: () => void;
}

export function CaseStatusTransitionDialog({
  open,
  onOpenChange,
  caseId,
  currentStatus,
  onSuccess,
}: CaseStatusTransitionDialogProps) {
  const [newStatus, setNewStatus] = useState("");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const availableTransitions = CASE_STATUS_TRANSITIONS[currentStatus] || [];

  const handleTransition = async () => {
    if (!newStatus) {
      toast.error("Please select a new status");
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch(`/api/cases/${caseId}/status`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: newStatus, notes: notes || undefined }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Status transition failed");
      }

      toast.success(`Status updated to ${CASE_STATUS_LABELS[newStatus]}`);
      onOpenChange(false);
      setNewStatus("");
      setNotes("");
      onSuccess();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Transition failed");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Update Case Status</DialogTitle>
          <DialogDescription>
            Current status: <StatusBadge type="case_status" value={currentStatus} className="ml-1" />
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {availableTransitions.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No transitions available from this status.
            </p>
          ) : (
            <>
              <div className="space-y-2">
                <label className="text-sm font-medium">New Status</label>
                <Select value={newStatus} onValueChange={setNewStatus}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select new status" />
                  </SelectTrigger>
                  <SelectContent>
                    {availableTransitions.map((s) => (
                      <SelectItem key={s} value={s}>
                        {CASE_STATUS_LABELS[s] || s}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">Notes (optional)</label>
                <Textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Reason for status change..."
                  rows={3}
                />
              </div>
            </>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={handleTransition}
            disabled={submitting || !newStatus}
          >
            {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Update Status
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
