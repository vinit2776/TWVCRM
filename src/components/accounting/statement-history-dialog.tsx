"use client";

/**
 * Lightweight "what happened, when, and what did we send" dialog for a
 * single billing statement — reachable from the Tally Inbox's "History"
 * button (open or closed rows). Deliberately narrower than
 * <ViewStatementDialog> (src/components/billing/view-statement-dialog.tsx):
 * this is read-only history, not statement management, so it skips the
 * lifecycle/void/reissue actions that live on the Billing page's dialog and
 * would just duplicate what the Inbox row's own buttons already do.
 */

import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { StatementTimeline } from "./statement-timeline";
import { RecentCommunicationsCard } from "@/components/communications/recent-communications-card";

interface StatementHistoryDialogProps {
  statementId: string | null;
  statementNumber?: string | null;
  onOpenChange: (open: boolean) => void;
}

export function StatementHistoryDialog({
  statementId,
  statementNumber,
  onOpenChange,
}: StatementHistoryDialogProps) {
  return (
    <Dialog open={!!statementId} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>History{statementNumber ? ` — ${statementNumber}` : ""}</DialogTitle>
        </DialogHeader>
        {statementId && (
          <div className="space-y-5">
            <div>
              <p className="text-xs font-medium text-muted-foreground mb-1.5">Timeline</p>
              <StatementTimeline statementId={statementId} maxHeight="280px" />
            </div>
            <div>
              <p className="text-xs font-medium text-muted-foreground mb-1.5">Recent communications</p>
              <RecentCommunicationsCard entityType="billing_statement" entityId={statementId} />
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
