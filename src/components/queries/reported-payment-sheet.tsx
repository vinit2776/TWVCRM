"use client";

import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { QueryThreadPanel } from "@/components/queries/query-thread-panel";
import { QUERIES_CHANGED_EVENT } from "@/hooks/use-sidebar-badges";

/**
 * A reported payment's thread in a side drawer, for surfaces that flag a report
 * on a row (the Tally Inbox statement rows). It embeds the ordinary thread
 * panel, so accepting an already-recorded payment, verifying and recording,
 * "not found yet" and "no such payment" all run through PaymentReportCard and
 * the one Record Payment dialog; nothing here writes a payment.
 */
export function ReportedPaymentSheet({
  report,
  onClose,
  onChanged,
}: {
  report: { query_id: string; entity_type: string; entity_id: string; title: string } | null;
  onClose: () => void;
  onChanged?: () => void;
}) {
  return (
    <Sheet open={!!report} onOpenChange={(o) => { if (!o) onClose(); }}>
      <SheetContent side="right" className="w-full sm:max-w-md overflow-y-auto p-4">
        <SheetHeader className="mb-3">
          <SheetTitle className="text-base">{report?.title ?? "Reported payment"}</SheetTitle>
          <p className="text-xs text-muted-foreground">
            Check the bank statement. If this payment is already recorded on the invoice, accept it; otherwise verify and
            record it, or tell the reporter it isn&apos;t there yet.
          </p>
        </SheetHeader>
        {report && (
          <QueryThreadPanel
            key={report.query_id}
            entityType={report.entity_type}
            entityId={report.entity_id}
            initialQueryId={report.query_id}
            onChanged={() => {
              onChanged?.();
              window.dispatchEvent(new Event(QUERIES_CHANGED_EVENT));
            }}
          />
        )}
      </SheetContent>
    </Sheet>
  );
}
