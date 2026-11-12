"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";

const MIN_REASON = 10;

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  /** Bullet list under "This will:". */
  impact: string[];
  confirmLabel: string;
  successMessage: string;
  /** The admin-only endpoint. The reason is sent as `{ reason, ...extraBody }`. */
  url: string;
  method?: "POST" | "PATCH";
  extraBody?: Record<string, unknown>;
  onDone: () => void;
};

// Reason-required confirmation for an admin rollback (one step back, audited).
// The server enforces the role and the rules; this only collects the reason and
// surfaces the server's message when it refuses.
export function RollbackDialog({
  open, onOpenChange, title, description, impact, confirmLabel, successMessage,
  url, method = "POST", extraBody, onDone,
}: Props) {
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    if (reason.trim().length < MIN_REASON) {
      toast.error(`Give a reason of at least ${MIN_REASON} characters — it is saved to the audit trail`);
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...extraBody, reason: reason.trim() }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(typeof json.error === "string" ? json.error : "Could not complete the rollback");
        return;
      }
      toast.success(successMessage);
      setReason("");
      onOpenChange(false);
      onDone();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!submitting) { onOpenChange(o); if (!o) setReason(""); } }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="rounded-md border bg-muted/30 p-3 text-sm">
            <p className="font-medium mb-1">This will:</p>
            <ul className="list-disc pl-5 space-y-0.5 text-muted-foreground">
              {impact.map((line) => <li key={line}>{line}</li>)}
            </ul>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="rb-dialog-reason">
              Reason <span className="text-red-500">*</span>
            </Label>
            <Textarea
              id="rb-dialog-reason"
              rows={3}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Saved to the audit trail"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>Cancel</Button>
          <Button variant="destructive" onClick={submit} disabled={submitting}>
            {submitting && <Loader2 className="h-4 w-4 animate-spin mr-1" />}
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
