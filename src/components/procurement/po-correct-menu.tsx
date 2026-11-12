"use client";

import { useState } from "react";
import { Loader2, Lock, Settings2, Undo2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";

type RollbackAction =
  | "unorder" | "unmark_received" | "restore_cancelled"
  | "restore_partial_cancel" | "reopen_advance" | "reverse_advance" | "reinstate_amc";

type Props = {
  poId: string;
  poNumber: string;
  status: string;
  advanceStatus: string | null;
  advanceApprovalStatus: string | null;
  /** AMC contract was terminated mid-term. */
  amcTerminated?: boolean;
  /** The procurement cycle is closed — corrections are disabled until an admin reopens it. */
  locked?: boolean;
  isAdmin: boolean;
  onDone: () => void;
};

const MIN_REASON = 10;

const COPY: Record<RollbackAction, { menu: string; title: string; button: string; done: string; intro: string; impact: string[] }> = {
  unorder: {
    menu: "Move back to Pending…",
    title: "Move back to Pending",
    button: "Move to Pending",
    done: "moved back to pending",
    intro: "The order was marked as placed by mistake.",
    impact: [
      "PO returns to Pending so it can be edited and re-ordered",
      "Refused if goods, bills, service work or a paid advance exist — undo those first",
      "Prices already learned into the vendor catalogue are left as they are",
    ],
  },
  unmark_received: {
    menu: "Un-mark received…",
    title: "Un-mark received",
    button: "Un-mark received",
    done: "no longer marked received",
    intro: "Use this when Received was clicked without the goods arriving.",
    impact: [
      "Status goes back to what the delivery receipts support (Ordered or Partially Received)",
      "Refused if receipts cover the whole order — reject the wrong delivery instead",
    ],
  },
  restore_cancelled: {
    menu: "Restore cancelled PO…",
    title: "Restore cancelled PO",
    button: "Restore PO",
    done: "restored",
    intro: "The PO was cancelled by mistake.",
    impact: [
      "PO returns to the status it had before it was cancelled",
      "The material request's ordered quantity is re-counted",
      "Refused if another PO has since used that quantity",
    ],
  },
  restore_partial_cancel: {
    menu: "Restore partial cancellation…",
    title: "Restore partial cancellation",
    button: "Restore quantities",
    done: "partial cancellation reversed",
    intro: "The original quantities, total and unapproved bill amounts are put back.",
    impact: [
      "Item quantities and the PO total return to what they were",
      "Pending and rejected bills get their original amounts back",
      "Refused if a bill was approved at the reduced amount — un-approve it first",
    ],
  },
  reopen_advance: {
    menu: "Re-open advance approval…",
    title: "Re-open advance approval",
    button: "Re-open",
    done: "advance approval re-opened",
    intro: "The approve or reject decision on the advance was wrong.",
    impact: [
      "Advance goes back to Pending Review so an admin can decide again",
      "Refused once the advance has been paid",
    ],
  },
  reinstate_amc: {
    menu: "Reinstate terminated AMC…",
    title: "Reinstate AMC",
    button: "Reinstate AMC",
    done: "AMC reinstated",
    intro: "The contract was terminated by mistake or the vendor has resumed service.",
    impact: [
      "The termination is cleared and the AMC returns to the status its dates and visits imply",
      "New visits can be logged against it again",
      "Refused if the purchase order itself is cancelled — restore that first",
    ],
  },
  reverse_advance: {
    menu: "Reverse advance payment…",
    title: "Reverse advance payment",
    button: "Reverse advance",
    done: "advance payment reversed",
    intro: "The advance was recorded as paid in error.",
    impact: [
      "Advance returns to Pending (still approved) and the payment details are cleared",
      "Refused while live bills on this PO carry the advance credit — withdraw them first",
    ],
  },
};

// Admin-only "Correct" menu for a purchase order. Each action undoes ONE step;
// the server refuses when a later step still stands, and says which to undo first.
export function PoCorrectMenu({ poId, poNumber, status, advanceStatus, advanceApprovalStatus, amcTerminated, locked, isAdmin, onDone }: Props) {
  const [action, setAction] = useState<RollbackAction | null>(null);
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);

  if (!isAdmin) return null;
  if (locked) {
    return (
      <Button size="sm" variant="outline" className="gap-1.5" disabled title="This procurement cycle is closed. Reopen it first.">
        <Lock className="h-3.5 w-3.5" /> Correct
      </Button>
    );
  }

  const available: RollbackAction[] = [];
  if (status === "ordered") available.push("unorder");
  if (status === "received") available.push("unmark_received");
  if (status === "cancelled") available.push("restore_cancelled");
  if (status === "partially_cancelled") available.push("restore_partial_cancel");
  if (advanceStatus === "processed") available.push("reverse_advance");
  else if (advanceApprovalStatus === "approved" || advanceApprovalStatus === "rejected") available.push("reopen_advance");

  if (amcTerminated) available.push("reinstate_amc");

  const invoiced = status === "invoice_received" || status === "invoice_approved";
  if (available.length === 0 && !invoiced) return null;

  const open = (a: RollbackAction) => { setReason(""); setAction(a); };

  const submit = async () => {
    if (!action) return;
    if (reason.trim().length < MIN_REASON) {
      toast.error(`Give a reason of at least ${MIN_REASON} characters — it is saved to the audit trail`);
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch(`/api/procurement/orders/${poId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, reason: reason.trim() }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(typeof json.error === "string" ? json.error : "Could not complete the rollback");
        return;
      }
      toast.success(`${poNumber} ${COPY[action].done}`);
      setAction(null);
      onDone();
    } finally {
      setSubmitting(false);
    }
  };

  const copy = action ? COPY[action] : null;

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="sm" variant="outline" className="gap-1.5">
            <Settings2 className="h-3.5 w-3.5" /> Correct
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-72">
          <DropdownMenuLabel className="text-xs text-muted-foreground">Admin — undo one step</DropdownMenuLabel>
          <DropdownMenuSeparator />
          {available.map((a) => (
            <DropdownMenuItem key={a} onSelect={() => open(a)}>
              <Undo2 className="h-3.5 w-3.5 mr-2" /> {COPY[a].menu}
            </DropdownMenuItem>
          ))}
          {invoiced && (
            <p className="px-2 py-1.5 text-xs text-muted-foreground">
              This PO has an invoice. To roll back further, withdraw its bills from the bill page first
              (un-approve them if approved).
            </p>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={action !== null} onOpenChange={(o) => !o && !submitting && setAction(null)}>
        <DialogContent className="max-w-md">
          {copy && (
            <>
              <DialogHeader>
                <DialogTitle>{copy.title} — {poNumber}</DialogTitle>
                <DialogDescription>{copy.intro}</DialogDescription>
              </DialogHeader>
              <div className="space-y-3">
                <div className="rounded-md border bg-muted/30 p-3 text-sm">
                  <p className="font-medium mb-1">This will:</p>
                  <ul className="list-disc pl-5 space-y-0.5 text-muted-foreground">
                    {copy.impact.map((line) => <li key={line}>{line}</li>)}
                  </ul>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="po-rb-reason">
                    Reason <span className="text-red-500">*</span>
                  </Label>
                  <Textarea
                    id="po-rb-reason"
                    rows={3}
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    placeholder="Saved to the audit trail"
                  />
                </div>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setAction(null)} disabled={submitting}>Cancel</Button>
                <Button variant="destructive" onClick={submit} disabled={submitting}>
                  {submitting && <Loader2 className="h-4 w-4 animate-spin mr-1" />}
                  {copy.button}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
