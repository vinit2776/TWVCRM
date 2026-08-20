"use client";

/**
 * "Payment received" detail dialog — shared by the Paid tab (full payment)
 * and the open-AR table's partially-paid rows (payment so far, of a larger
 * total). Shows the most recent billing_payments record for the statement;
 * older ones are summarized with a pointer to the full send/payment history.
 */

import Link from "next/link";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { IndianRupee, CreditCard, Hash, Calendar, User, StickyNote, History } from "lucide-react";
import { formatCurrency, formatDate } from "@/lib/utils";

export interface PaymentDetail {
  id: string;
  amount: number;
  payment_date: string;
  payment_mode: string;
  payment_reference: string | null;
  razorpay_payment_id: string | null;
  notes: string | null;
  recorded_by_user: { id: string; full_name: string } | null;
}

export interface PaymentDetailRow {
  id: string;
  statement_number: string;
  statement_type: string;
  period_start: string;
  period_end: string;
  total_amount: number;
  /** Set for partially-paid rows — the headline figure becomes "paid so far", with the total shown for context. Omit when the statement is paid in full. */
  amount_paid?: number;
  gst_invoice_number: string | null;
  payments: PaymentDetail[];
  partyNumber: string;
  partyCustomerName: string;
}

export function PaymentDetailDialog({
  row,
  onClose,
  onOpenHistory,
}: {
  row: PaymentDetailRow | null;
  onClose: () => void;
  onOpenHistory: (row: { id: string; statement_number: string }) => void;
}) {
  return (
    <Dialog open={!!row} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        {row && (() => {
          const payment = row.payments[0] ?? null;
          const pdfHref = row.gst_invoice_number
            ? `/api/billing-statements/${row.id}/gst-invoice-pdf`
            : `/api/billing-statements/${row.id}/proforma-pdf`;
          const isRazorpayAuto = payment?.payment_mode === "razorpay" && !payment.recorded_by_user;
          const isPartial = row.amount_paid != null && row.amount_paid < row.total_amount;
          const headline = row.amount_paid ?? row.total_amount;

          return (
            <>
              <DialogHeader>
                <DialogTitle>Payment received</DialogTitle>
                <div className="text-xs text-muted-foreground">{row.partyNumber} · {row.partyCustomerName}</div>
              </DialogHeader>

              <div className="bg-gray-50 rounded-lg p-4">
                <div className="text-2xl font-semibold">{formatCurrency(headline)}</div>
                <div className="text-xs text-muted-foreground mt-1">
                  {row.statement_number} · <span className="capitalize">{row.statement_type}</span> · {formatDate(row.period_start)} – {formatDate(row.period_end)}
                  {isPartial && <> · of {formatCurrency(row.total_amount)} total</>}
                </div>
              </div>

              {payment ? (
                <table className="w-full text-sm">
                  <tbody>
                    <tr>
                      <td className="py-1.5 text-muted-foreground"><CreditCard className="h-3.5 w-3.5 inline mr-1.5 -mt-0.5" />Mode</td>
                      <td className="py-1.5 text-right capitalize">{payment.payment_mode.replace(/_/g, " ")}</td>
                    </tr>
                    <tr>
                      <td className="py-1.5 text-muted-foreground"><Hash className="h-3.5 w-3.5 inline mr-1.5 -mt-0.5" />Reference</td>
                      <td className="py-1.5 text-right font-mono text-xs">{payment.razorpay_payment_id || payment.payment_reference || "—"}</td>
                    </tr>
                    <tr>
                      <td className="py-1.5 text-muted-foreground"><Calendar className="h-3.5 w-3.5 inline mr-1.5 -mt-0.5" />Paid on</td>
                      <td className="py-1.5 text-right">{formatDate(payment.payment_date)}</td>
                    </tr>
                    <tr>
                      <td className="py-1.5 text-muted-foreground"><User className="h-3.5 w-3.5 inline mr-1.5 -mt-0.5" />Recorded by</td>
                      <td className="py-1.5 text-right">{isRazorpayAuto ? "Captured via Razorpay" : payment.recorded_by_user?.full_name || "—"}</td>
                    </tr>
                    {payment.notes && (
                      <tr>
                        <td className="py-1.5 text-muted-foreground align-top"><StickyNote className="h-3.5 w-3.5 inline mr-1.5 -mt-0.5" />Notes</td>
                        <td className="py-1.5 text-right text-muted-foreground">{payment.notes}</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              ) : (
                <div className="text-sm text-muted-foreground py-2">No payment record found — this statement may predate offline payment tracking.</div>
              )}

              {row.payments.length > 1 && (
                <div className="text-xs text-muted-foreground -mt-2">
                  +{row.payments.length - 1} earlier payment{row.payments.length - 1 === 1 ? "" : "s"} — see full history.
                </div>
              )}

              <DialogFooter className="gap-2 sm:gap-2">
                <Button variant="outline" size="sm" asChild>
                  <Link href={pdfHref} target="_blank"><IndianRupee className="h-3.5 w-3.5 mr-1" />View Invoice</Link>
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => { onOpenHistory(row); onClose(); }}
                >
                  <History className="h-3.5 w-3.5 mr-1" />Full history
                </Button>
              </DialogFooter>
            </>
          );
        })()}
      </DialogContent>
    </Dialog>
  );
}
