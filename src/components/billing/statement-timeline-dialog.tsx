"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Loader2, FileText, Send, Bell, IndianRupee, BadgeIndianRupee, Receipt,
  GitCommitHorizontal, Eye, AlertTriangle,
} from "lucide-react";
import { toast } from "sonner";
import { formatCurrency } from "@/lib/utils";
import type { StatementTimelineEvent, StatementTimelineKind } from "@/types";

/**
 * The full history of a billing statement — every send, reminder, payment,
 * GST handoff and workflow override, in one chronological list.
 *
 * Replaces the send-only "Send history" table. That version read just the
 * send log and reminder table, so a workflow override (e.g. cancelling the
 * proforma to issue a GST invoice before payment) left no trace on screen and
 * the statement looked inconsistent — GST issued, nothing paid, no reason why.
 */

const KIND_ICON: Record<StatementTimelineKind, React.ComponentType<{ className?: string }>> = {
  lifecycle: FileText,
  send: Send,
  reminder: Bell,
  payment: IndianRupee,
  // Distinct from `payment`: a claim someone made, not money in the bank.
  payment_report: BadgeIndianRupee,
  gst: Receipt,
  audit: GitCommitHorizontal,
};

const KIND_STYLE: Record<StatementTimelineKind, string> = {
  lifecycle: "bg-slate-100 text-slate-600 border-slate-200",
  send: "bg-blue-100 text-blue-700 border-blue-200",
  reminder: "bg-amber-100 text-amber-700 border-amber-200",
  payment: "bg-emerald-100 text-emerald-700 border-emerald-200",
  // Teal, matching the "Report paid" button on AR — and deliberately not the
  // emerald of a real payment, which this is not until accounts verify it.
  payment_report: "bg-teal-100 text-teal-700 border-teal-200",
  gst: "bg-violet-100 text-violet-700 border-violet-200",
  audit: "bg-gray-100 text-gray-500 border-gray-200",
};

function StatusBadge({ status, error }: { status: string | null; error: string | null }) {
  if (!status || status === "ok") return null;
  if (status === "opened") {
    return (
      <Badge className="bg-teal-100 text-teal-800 border-teal-300 text-[10px] flex items-center gap-1 w-fit">
        <Eye className="h-2.5 w-2.5" /> OPENED
      </Badge>
    );
  }
  if (status === "delivered") {
    return <Badge className="bg-emerald-100 text-emerald-800 border-emerald-300 text-[10px]">DELIVERED</Badge>;
  }
  if (status === "sent") {
    return <Badge className="bg-emerald-50 text-emerald-700 border-emerald-200 text-[10px]">SENT</Badge>;
  }
  return (
    <Badge className="bg-red-100 text-red-800 border-red-300 text-[10px]" title={error || ""}>
      {status.toUpperCase()}
    </Badge>
  );
}

const fmtWhen = (iso: string) =>
  new Date(iso).toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short",
  });

export function StatementTimelineDialog({
  statement,
  onClose,
}: {
  statement: { id: string; statement_number: string } | null;
  onClose: () => void;
}) {
  const [events, setEvents] = useState<StatementTimelineEvent[]>([]);
  const [loading, setLoading] = useState(false);

  const statementId = statement?.id;

  const load = useCallback(async () => {
    if (!statementId) return;
    setLoading(true);
    setEvents([]);
    try {
      const res = await fetch(`/api/billing-statements/${statementId}/timeline`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to load history");
      setEvents(json.events || []);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to load history");
    } finally {
      setLoading(false);
    }
  }, [statementId]);

  useEffect(() => { void load(); }, [load]);

  return (
    <Dialog open={!!statement} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>History — {statement?.statement_number}</DialogTitle>
        </DialogHeader>

        {loading ? (
          <div className="p-6 text-center text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin inline mr-2" /> Loading…
          </div>
        ) : events.length === 0 ? (
          <div className="p-6 text-center text-muted-foreground">
            No history recorded for this statement yet.
          </div>
        ) : (
          <div className="max-h-[460px] overflow-y-auto pr-1">
            <ol className="relative border-l ml-3">
              {events.map((e) => {
                const Icon = KIND_ICON[e.kind] ?? FileText;
                return (
                  <li key={e.id} className="ml-6 pb-4 last:pb-0">
                    <span
                      className={`absolute -left-3 flex h-6 w-6 items-center justify-center rounded-full border ${KIND_STYLE[e.kind]}`}
                    >
                      <Icon className="h-3 w-3" />
                    </span>
                    <div
                      className={
                        e.highlight
                          ? "rounded-md border border-amber-300 bg-amber-50 px-3 py-2"
                          : ""
                      }
                    >
                      <div className="flex items-start justify-between gap-3">
                        <p className="text-sm font-medium leading-snug flex items-center gap-1.5">
                          {e.highlight && <AlertTriangle className="h-3.5 w-3.5 text-amber-600 shrink-0" />}
                          {e.label}
                          {e.amount != null && (
                            <span className="text-emerald-700">{formatCurrency(e.amount)}</span>
                          )}
                        </p>
                        <StatusBadge status={e.status} error={e.error} />
                      </div>
                      <p className="text-[11px] text-muted-foreground mt-0.5">
                        {fmtWhen(e.at)}
                        {e.actor ? ` · ${e.actor}` : ""}
                        {e.channel ? ` · ${e.channel.toUpperCase()}` : ""}
                        {e.recipient ? ` · ${e.recipient}` : ""}
                      </p>
                      {e.detail && (
                        <p className="text-[11px] text-gray-600 mt-1 whitespace-pre-wrap">{e.detail}</p>
                      )}
                      {e.error && (
                        <p className="text-[11px] text-red-600 mt-1 whitespace-pre-wrap">{e.error}</p>
                      )}
                    </div>
                  </li>
                );
              })}
            </ol>
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
