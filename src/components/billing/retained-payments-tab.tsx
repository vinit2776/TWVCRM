"use client";

/**
 * RetainedPaymentsTab — finance surface for cancelled bookings whose
 * payment was retained (no refund). Each row needs a GST invoice
 * issued for the kept amount; finance ticks them off as they go.
 *
 * Sourced from `bookings WHERE status='cancelled' AND
 * gst_invoice_required=true`. Once finance hits "Mark as Issued"
 * with the invoice number, the row drops off this list.
 */

import { useEffect, useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Loader2, FileText, ScrollText } from "lucide-react";
import Link from "next/link";
import { toast } from "sonner";
import { formatCurrency, formatDate } from "@/lib/utils";
import {
  BOOKING_CANCELLATION_REASON_LABELS,
} from "@/lib/constants";
import { createClient } from "@/lib/supabase/client";

interface RetainedRow {
  id: string;
  booking_number: string;
  booking_date: string;
  total_amount: number;
  total_amount_with_gst: number;
  cancellation_reason: string | null;
  cancellation_details: string | null;
  cancelled_at: string | null;
  customer_type: string;
  guest_name: string | null;
  lead?: { first_name: string; last_name: string; company: string | null } | null;
  location?: { id: string; name: string; code: string } | null;
}

export function RetainedPaymentsTab() {
  const [rows, setRows] = useState<RetainedRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [marking, setMarking] = useState<RetainedRow | null>(null);

  const fetchRows = useCallback(async () => {
    setLoading(true);
    const supabase = createClient();
    const { data } = await supabase
      .from("bookings")
      .select(`
        id, booking_number, booking_date, total_amount, total_amount_with_gst,
        cancellation_reason, cancellation_details, cancelled_at, customer_type, guest_name,
        lead:leads!bookings_lead_id_fkey(first_name, last_name, company),
        location:locations!bookings_location_id_fkey(id, name, code)
      `)
      .eq("status", "cancelled")
      .eq("gst_invoice_required", true)
      .order("cancelled_at", { ascending: false });
    setRows((data || []) as unknown as RetainedRow[]);
    setLoading(false);
  }, []);

  useEffect(() => { fetchRows(); }, [fetchRows]);

  return (
    <div className="space-y-3">
      <div className="rounded-md bg-blue-50 border border-blue-200 p-3 text-xs text-blue-900 flex items-start gap-2">
        <ScrollText className="h-3.5 w-3.5 mt-0.5 shrink-0" />
        <span>
          Cancelled bookings where payment was retained. Issue a GST invoice for the kept
          amount in your existing finance tooling, then mark the row as issued here so it
          drops off the queue.
        </span>
      </div>

      {loading ? (
        <div className="text-sm text-muted-foreground py-6 text-center flex items-center justify-center gap-2">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading…
        </div>
      ) : rows.length === 0 ? (
        <div className="text-sm text-muted-foreground italic py-6 text-center">
          No cancelled bookings with retained payment awaiting GST invoice.
        </div>
      ) : (
        <div className="rounded-md border overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-xs">
              <tr>
                <th className="text-left px-3 py-2 font-medium">Booking</th>
                <th className="text-left px-3 py-2 font-medium">Customer</th>
                <th className="text-left px-3 py-2 font-medium">Centre</th>
                <th className="text-right px-3 py-2 font-medium">Amount retained</th>
                <th className="text-left px-3 py-2 font-medium">Cancelled</th>
                <th className="text-right px-3 py-2 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((b) => {
                const customer = b.lead
                  ? b.lead.company || `${b.lead.first_name} ${b.lead.last_name}`
                  : b.guest_name || "—";
                return (
                  <tr key={b.id} className="border-t hover:bg-muted/20">
                    <td className="px-3 py-2 font-mono text-xs">
                      <Link
                        href={`/bookings/${b.id}`}
                        target="_blank"
                        rel="noopener"
                        className="text-primary hover:underline"
                      >
                        {b.booking_number}
                      </Link>
                      <div className="text-[10px] text-muted-foreground mt-0.5">
                        {formatDate(b.booking_date)}
                      </div>
                    </td>
                    <td className="px-3 py-2">{customer}</td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">
                      {b.location?.name || "—"}
                    </td>
                    <td className="px-3 py-2 text-right font-semibold">
                      {formatCurrency(Number(b.total_amount_with_gst) || Number(b.total_amount))}
                    </td>
                    <td className="px-3 py-2 text-xs">
                      <div>{b.cancelled_at ? formatDate(b.cancelled_at) : "—"}</div>
                      {b.cancellation_reason && (
                        <div className="text-[10px] text-muted-foreground mt-0.5">
                          {BOOKING_CANCELLATION_REASON_LABELS[b.cancellation_reason] || b.cancellation_reason}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <Button
                        size="sm"
                        className="h-7 text-xs"
                        onClick={() => setMarking(b)}
                      >
                        <FileText className="h-3 w-3 mr-1" />Mark as Issued
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {marking && (
        <MarkIssuedDialog
          booking={marking}
          onClose={() => setMarking(null)}
          onSubmitted={fetchRows}
        />
      )}
    </div>
  );
}

function MarkIssuedDialog({
  booking, onClose, onSubmitted,
}: {
  booking: RetainedRow;
  onClose: () => void;
  onSubmitted: () => void;
}) {
  const [invoiceNumber, setInvoiceNumber] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    setSubmitting(true);
    try {
      const res = await fetch(`/api/bookings/${booking.id}/clear-gst-invoice-required`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ invoice_number: invoiceNumber.trim() || undefined }),
      });
      const json = await res.json();
      if (!res.ok) {
        toast.error(json.error || "Failed to update");
        return;
      }
      toast.success("Marked as issued");
      onSubmitted();
      onClose();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle>Mark GST invoice issued — {booking.booking_number}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">
            Confirms that the GST invoice for the retained payment has been issued in your
            finance tooling. Optional invoice number is stored in the audit trail.
          </p>
          <div className="space-y-1">
            <Label htmlFor="inv-num" className="text-xs">Invoice number (optional)</Label>
            <Input
              id="inv-num"
              value={invoiceNumber}
              onChange={(e) => setInvoiceNumber(e.target.value)}
              placeholder="e.g. INV-2026-0142"
            />
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="ghost" onClick={onClose} disabled={submitting}>Cancel</Button>
            <Button onClick={submit} disabled={submitting}>
              {submitting
                ? <><Loader2 className="h-4 w-4 mr-1 animate-spin" />Saving…</>
                : "Mark as Issued"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
