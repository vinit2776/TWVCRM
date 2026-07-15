"use client";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { CheckCircle2, XCircle } from "lucide-react";
import { CommunicationLogRow } from "@/components/communications/communication-log-row";
import type { CommunicationLogEntry } from "@/types";

/**
 * Result modal shown immediately after a send succeeds — explicit dismiss
 * required, unlike a toast. Shows exactly what was sent via a single
 * expanded <CommunicationLogRow>.
 */
export function CommunicationSentDialog({
  entry,
  open,
  onOpenChange,
}: {
  entry: CommunicationLogEntry | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  if (!entry) return null;
  const failed = entry.status === "failed";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {failed ? (
              <>
                <XCircle className="h-5 w-5 text-red-600" />
                Send failed
              </>
            ) : (
              <>
                <CheckCircle2 className="h-5 w-5 text-green-600" />
                Sent
              </>
            )}
          </DialogTitle>
        </DialogHeader>

        <CommunicationLogRow entry={entry} defaultExpanded />

        <DialogFooter>
          <Button onClick={() => onOpenChange(false)}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
