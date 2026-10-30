"use client";

/**
 * "Cancellations" tab of the Tally Inbox: GST invoices an admin/manager asked
 * to cancel. Accounts (and admin) create the credit note in Tally, then upload
 * it here; that voids the invoice. Managers can see the list but not act.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Loader2, Ban } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatCurrency, formatDate } from "@/lib/utils";
import { CreditNoteUploadDialog } from "@/components/billing/credit-note-upload-dialog";

interface Lead { id: string; first_name?: string; last_name?: string; company?: string }
interface Row {
  id: string;
  statement_number: string | null;
  total_amount: number;
  payment_status: string;
  tally_invoice_number: string | null;
  cancellation_requested_at: string;
  cancellation_reason: string | null;
  requested_by_user: { full_name: string } | null;
  contract: { id: string; contract_number: string; lead?: Lead } | null;
  invoice: { id: string; invoice_number: string; lead?: Lead } | null;
}

function nameOf(lead?: Lead): string {
  if (!lead) return "—";
  return lead.company || `${lead.first_name || ""} ${lead.last_name || ""}`.trim() || "—";
}

export function CancellationsInbox({
  currentUserRole,
  onOpenCountChange,
}: {
  currentUserRole: string;
  onOpenCountChange?: (count: number) => void;
}) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [target, setTarget] = useState<Row | null>(null);
  // Matches the server rule in upload-credit-note: accounts and admin only.
  const canAct = currentUserRole === "accounts" || currentUserRole === "admin";

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/accounting/inbox/cancellations", { cache: "no-store" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to load");
      setRows(json.rows);
      onOpenCountChange?.(json.open_count ?? 0);
    } catch {
      toast.error("Could not load the cancellations list");
      setRows([]);
    }
  }, [onOpenCountChange]);

  useEffect(() => { load(); }, [load]);

  if (rows === null) {
    return <div className="p-8 text-center text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin inline mr-2" /> Loading…</div>;
  }
  if (rows.length === 0) {
    return <div className="p-12 text-center text-muted-foreground">No GST invoices are waiting for a credit note.</div>;
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Create a credit note in Tally for the full amount, then upload it here. The invoice is cancelled once you do.
        {!canAct && " Only Accounts can upload the credit note."}
      </p>
      {rows.map((r) => {
        const ref = r.contract
          ? { label: r.contract.contract_number, href: `/contracts/${r.contract.id}`, lead: r.contract.lead }
          : { label: r.invoice?.invoice_number ?? "—", href: `/leads/${r.invoice?.lead?.id ?? ""}`, lead: r.invoice?.lead };
        return (
          <div key={r.id} className="rounded-lg border p-4 flex flex-col sm:flex-row sm:items-center gap-3 justify-between">
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <Link href={ref.href} className="font-medium text-teal-700 hover:underline">{ref.label}</Link>
                <span className="text-sm">{nameOf(ref.lead)}</span>
                <Badge className="bg-red-100 text-red-800 border-red-300 flex items-center gap-1">
                  <Ban className="h-3 w-3" /> Cancel GST invoice
                </Badge>
              </div>
              <div className="text-xs text-muted-foreground font-mono mt-1">
                {r.tally_invoice_number} · {formatCurrency(r.total_amount)} · requested {formatDate(r.cancellation_requested_at)}
                {r.requested_by_user?.full_name ? ` by ${r.requested_by_user.full_name}` : ""}
              </div>
              {r.cancellation_reason && <div className="text-sm mt-1">Reason: {r.cancellation_reason}</div>}
            </div>
            {canAct && (
              <Button onClick={() => setTarget(r)} className="shrink-0">Upload credit note</Button>
            )}
          </div>
        );
      })}
      {target && (
        <CreditNoteUploadDialog
          statement={{
            id: target.id,
            statement_number: target.statement_number,
            tally_invoice_number: target.tally_invoice_number,
            total_amount: target.total_amount,
            payment_status: target.payment_status,
          }}
          defaultReason={target.cancellation_reason ?? ""}
          onCancelled={() => { setTarget(null); load(); }}
          onClose={() => setTarget(null)}
        />
      )}
    </div>
  );
}
