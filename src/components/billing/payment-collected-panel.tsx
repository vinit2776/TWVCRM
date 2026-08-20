import { CheckCircle2 } from "lucide-react";
import { formatCurrency } from "@/lib/utils";
import type { InboxPayment } from "@/lib/tally-handoff";

/** Human label for a payment_mode value. Shared so every "how was this paid"
 *  surface (Tally Inbox, the invoice payment popover, …) reads identically. */
export function paymentModeLabel(mode: string): string {
  const map: Record<string, string> = {
    razorpay: "Razorpay",
    upi: "UPI",
    cash: "Cash",
    card: "Card",
    neft: "NEFT",
    rtgs: "RTGS",
    cheque: "Cheque",
    bank_transfer: "Bank Transfer",
  };
  return map[mode.toLowerCase()] ?? mode;
}

/**
 * Renders the payment(s) collected against a billing statement — one card per
 * billing_payments row, with Razorpay-specific fields (txn id, settlement) or
 * manual-payment fields (reference, recorded by) depending on how it was paid.
 *
 * Originally built for the Tally Inbox row detail; also used by the ad-hoc
 * invoice "Paid" badge popover on the lead page so both surfaces show
 * identical payment detail for the same underlying billing_payments rows.
 */
export function StatementPaymentPanel({
  payments,
  totalAmount,
  nextStepMessage,
}: {
  payments: InboxPayment[];
  totalAmount: number;
  nextStepMessage?: string;
}) {
  const totalPaid = payments.reduce((s, p) => s + p.amount, 0);
  const isFullyPaid = Math.abs(totalPaid - totalAmount) < 0.5;

  return (
    <div className="p-3 rounded-lg bg-green-50 border border-green-200 text-xs">
      <div className="flex items-center justify-between mb-2">
        <span className="font-medium text-green-900 flex items-center gap-1.5">
          <CheckCircle2 className="h-3.5 w-3.5" />
          Payment collected
        </span>
        <span className={`text-[10px] px-1.5 py-0.5 rounded border font-medium ${
          isFullyPaid
            ? "bg-green-100 text-green-800 border-green-300"
            : "bg-amber-100 text-amber-800 border-amber-200"
        }`}>
          {isFullyPaid ? "Fully paid" : `Partial · ${formatCurrency(totalPaid)} of ${formatCurrency(totalAmount)}`}
        </span>
      </div>
      <div className="space-y-2">
        {payments.map((p) => {
          const txnDate = new Date(p.payment_date).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
          const isRazorpay = !!p.razorpay_payment_id;
          return (
            <div key={p.id} className="rounded border border-green-200 bg-white/60 px-2.5 py-2 space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="font-semibold text-green-900 tabular-nums">{formatCurrency(p.amount)}</span>
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-100 text-green-800 border border-green-200 font-medium">
                  {paymentModeLabel(p.payment_mode)}
                </span>
              </div>
              {isRazorpay ? (
                <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-[11px]">
                  <span className="text-muted-foreground">Txn ID</span>
                  <span className="font-mono text-green-800 break-all">{p.razorpay_payment_id}</span>
                  <span className="text-muted-foreground">Transacted on</span>
                  <span>{txnDate}</span>
                  {p.settled === true ? (
                    <>
                      <span className="text-muted-foreground">Settled to bank</span>
                      <span className="text-green-700 font-medium">
                        {p.settled_at ? new Date(p.settled_at).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }) : "—"}
                      </span>
                      {p.settlement_utr && (
                        <>
                          <span className="text-muted-foreground">Bank UTR</span>
                          <span className="font-mono text-green-800">{p.settlement_utr}</span>
                        </>
                      )}
                    </>
                  ) : p.settled === false ? (
                    <>
                      <span className="text-muted-foreground">Settlement</span>
                      <span className="text-amber-700">Pending — not yet settled to bank</span>
                    </>
                  ) : (
                    <>
                      <span className="text-muted-foreground">Settlement</span>
                      <span className="text-muted-foreground italic">Not synced yet</span>
                    </>
                  )}
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-[11px]">
                  <span className="text-muted-foreground">Date recorded</span>
                  <span>{txnDate}</span>
                  {p.payment_reference && (
                    <>
                      <span className="text-muted-foreground">Reference</span>
                      <span className="font-mono text-green-800">{p.payment_reference}</span>
                    </>
                  )}
                  {p.recorded_by_name && (
                    <>
                      <span className="text-muted-foreground">Recorded by</span>
                      <span>{p.recorded_by_name}</span>
                    </>
                  )}
                </div>
              )}
              {p.notes && (
                <div className="text-[11px] text-green-800 border-t border-green-100 pt-1.5">
                  <span className="text-muted-foreground">Notes: </span>
                  {p.notes}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {nextStepMessage && (
        <div className="mt-2 pt-2 border-t border-green-200 flex items-center gap-1.5 text-green-800">
          <CheckCircle2 className="h-3.5 w-3.5 flex-shrink-0 text-green-600" aria-hidden />
          {nextStepMessage}
        </div>
      )}
    </div>
  );
}
