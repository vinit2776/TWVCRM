"use client";

import Link from "next/link";
import { useState } from "react";
import { Lock, Settings2, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { RollbackDialog } from "@/components/procurement/rollback-dialog";
import { MR_APPROVED_STATUSES } from "@/lib/procurement/mr-rollback";

type LivePo = { id: string; po_number: string; status: string };

type Props = {
  prId: string;
  prNumber: string;
  status: string;
  /** The MR's purchase orders (any status); cancelled ones are ignored. */
  pos: LivePo[];
  /** The procurement cycle is closed — corrections are disabled until reopened. */
  locked?: boolean;
  isAdmin: boolean;
  onDone: () => void;
};

type Mode = "revoke_approval" | "reopen_cancelled" | null;

// Admin-only "Correct" menu for a material request. Each action undoes ONE step:
// approval can only be revoked once its purchase orders are cancelled — the
// menu names them with links, and the server enforces it.
export function MrCorrectMenu({ prId, prNumber, status, pos, locked, isAdmin, onDone }: Props) {
  const [mode, setMode] = useState<Mode>(null);
  if (!isAdmin) return null;

  if (locked) {
    return (
      <Button size="sm" variant="outline" className="gap-1.5" disabled title="This procurement cycle is closed. Reopen it first.">
        <Lock className="h-3.5 w-3.5" /> Correct
      </Button>
    );
  }

  const approved = (MR_APPROVED_STATUSES as readonly string[]).includes(status);
  const cancelled = status === "cancelled";
  if (!approved && !cancelled) return null;

  const livePos = pos.filter((p) => p.status !== "cancelled");

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="sm" variant="outline" className="gap-1.5">
            <Settings2 className="h-3.5 w-3.5" /> Correct
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-80">
          <DropdownMenuLabel className="text-xs text-muted-foreground">Admin — undo one step</DropdownMenuLabel>
          <DropdownMenuSeparator />
          {approved && (
            <DropdownMenuItem disabled={livePos.length > 0} onSelect={() => setMode("revoke_approval")}>
              <Undo2 className="h-3.5 w-3.5 mr-2" /> Revoke approval…
            </DropdownMenuItem>
          )}
          {approved && livePos.length > 0 && (
            <div className="px-2 pb-1.5 text-xs text-muted-foreground">
              Cancel its purchase order{livePos.length === 1 ? "" : "s"} first:{" "}
              {livePos.map((p, i) => (
                <span key={p.id}>
                  {i > 0 && ", "}
                  <Link href={`/procurement/orders/${p.id}`} className="text-primary underline underline-offset-2">{p.po_number}</Link>
                </span>
              ))}
            </div>
          )}
          {cancelled && (
            <DropdownMenuItem onSelect={() => setMode("reopen_cancelled")}>
              <Undo2 className="h-3.5 w-3.5 mr-2" /> Reopen cancelled MR…
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <RollbackDialog
        open={mode === "revoke_approval"}
        onOpenChange={(o) => !o && setMode(null)}
        title={`Revoke approval — ${prNumber}`}
        description="The approval was given by mistake. The MR goes back to the approval queue."
        impact={[
          "MR returns to Submitted, editable and ready to be approved again",
          "The approval, its code and the price-tolerance decision are cleared",
          "Its amount stops counting as committed department budget",
          "Refused while it still has purchase orders, or customer invoices (reimbursement MRs)",
        ]}
        confirmLabel="Revoke approval"
        successMessage={`${prNumber} returned to approval`}
        url={`/api/procurement/requests/${prId}`}
        method="PATCH"
        extraBody={{ action: "revoke_approval" }}
        onDone={onDone}
      />
      <RollbackDialog
        open={mode === "reopen_cancelled"}
        onOpenChange={(o) => !o && setMode(null)}
        title={`Reopen cancelled MR — ${prNumber}`}
        description="The MR was cancelled by mistake."
        impact={[
          "MR returns to the status it was cancelled from (Draft or Submitted)",
          "MRs cancelled before this was recorded go back to Draft",
        ]}
        confirmLabel="Reopen MR"
        successMessage={`${prNumber} reopened`}
        url={`/api/procurement/requests/${prId}`}
        method="PATCH"
        extraBody={{ action: "reopen_cancelled" }}
        onDone={onDone}
      />
    </>
  );
}
