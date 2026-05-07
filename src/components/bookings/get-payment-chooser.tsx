"use client";

/**
 * GetPaymentChooser — single entry point for all payment-collection
 * paths on a booking. Replaces the trio of buttons (Collect Payment /
 * Send Payment Link / Copy Payment Link) with one "Collect Payment"
 * action that branches into:
 *   - At counter (cash / UPI manual + screenshot / card) → opens the
 *     existing CollectPaymentDialog
 *   - Send link (email / WhatsApp / SMS / clipboard) → opens the
 *     existing SharePaymentLinkDialog
 *
 * The two existing dialogs stay unchanged; this is purely an entry-
 * point consolidation. If the chooser breaks, the underlying dialogs
 * still work — they're imported as-is from the parent.
 */

import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Banknote, Link2 } from "lucide-react";
import { formatCurrency } from "@/lib/utils";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  amountDue: number;
  /** Called when staff picks "At counter" — parent opens CollectPaymentDialog. */
  onPickCounter: () => void;
  /** Called when staff picks "Send link" — parent opens SharePaymentLinkDialog. */
  onPickLink: () => void;
}

export function GetPaymentChooser({
  open, onOpenChange, amountDue, onPickCounter, onPickLink,
}: Props) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle>How are you collecting?</DialogTitle>
        </DialogHeader>

        <div className="text-sm text-muted-foreground mb-2">
          Amount due: <span className="font-semibold text-foreground">{formatCurrency(amountDue)}</span>
        </div>

        <div className="grid grid-cols-1 gap-2.5">
          {/* At counter */}
          <button
            type="button"
            onClick={() => { onPickCounter(); onOpenChange(false); }}
            className="rounded-lg border bg-card p-4 text-left hover:bg-muted/40 active:scale-[0.99] transition flex gap-3 items-start"
          >
            <div className="rounded-md bg-amber-100 p-2 shrink-0">
              <Banknote className="h-5 w-5 text-amber-700" />
            </div>
            <div>
              <div className="font-semibold">At counter</div>
              <div className="text-[12px] text-muted-foreground mt-0.5">
                Customer is here now — record cash, UPI (manual + screenshot), or card.
              </div>
            </div>
          </button>

          {/* Send link */}
          <button
            type="button"
            onClick={() => { onPickLink(); onOpenChange(false); }}
            className="rounded-lg border bg-card p-4 text-left hover:bg-muted/40 active:scale-[0.99] transition flex gap-3 items-start"
          >
            <div className="rounded-md bg-blue-100 p-2 shrink-0">
              <Link2 className="h-5 w-5 text-blue-700" />
            </div>
            <div>
              <div className="font-semibold">Send link</div>
              <div className="text-[12px] text-muted-foreground mt-0.5">
                Customer pays remotely — email / WhatsApp / SMS them a Razorpay link.
                Status auto-updates when they pay.
              </div>
            </div>
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
