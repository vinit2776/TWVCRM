"use client";

import Link from "next/link";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog";
import { formatCurrency, formatDate } from "@/lib/utils";
import type { BillingPaymentStatus, BreakdownMetric, BreakdownResponse } from "./types";

const METRIC_LABEL: Record<BreakdownMetric, string> = {
  sales: "Sales",
  billed: "Billed",
  collections: "Collections",
};

const PAYMENT_STATUS_LABEL: Record<BillingPaymentStatus, string> = {
  unpaid: "Unpaid",
  partially_paid: "Partial",
  paid: "Paid",
};

const PAYMENT_STATUS_COLOR: Record<BillingPaymentStatus, string> = {
  unpaid: "bg-red-100 text-red-800",
  partially_paid: "bg-yellow-100 text-yellow-800",
  paid: "bg-green-100 text-green-800",
};

function PaymentStatusBadge({ status }: { status: BillingPaymentStatus }) {
  return (
    <span className={`whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${PAYMENT_STATUS_COLOR[status]}`}>
      {PAYMENT_STATUS_LABEL[status]}
    </span>
  );
}

const REFERENCE_LABEL: Record<BreakdownMetric, string> = {
  sales: "Contract",
  billed: "Statement",
  collections: "Statement",
};

const DATE_LABEL: Record<BreakdownMetric, string> = {
  sales: "Activated",
  billed: "Period start",
  collections: "Paid on",
};

export function BreakdownDialog({
  open,
  onOpenChange,
  centerName,
  metric,
  data,
  loading,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  centerName: string;
  metric: BreakdownMetric | null;
  data: BreakdownResponse | null;
  loading: boolean;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[80vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{metric ? METRIC_LABEL[metric] : ""} — {centerName}</DialogTitle>
          <DialogDescription>
            {data ? `${data.items.length} item${data.items.length === 1 ? "" : "s"} in the selected period` : "Loading…"}
          </DialogDescription>
        </DialogHeader>

        {loading && <p className="py-6 text-sm text-muted-foreground">Loading…</p>}

        {data && !loading && (
          data.items.length === 0 ? (
            <p className="py-6 text-sm text-muted-foreground">Nothing in this period.</p>
          ) : (
            <div className="space-y-1">
              <div className={`grid ${metric === "billed" ? "grid-cols-[1fr_auto_auto_auto]" : "grid-cols-[1fr_auto_auto]"} gap-3 border-b pb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground`}>
                <span>{REFERENCE_LABEL[metric!]} / client</span>
                <span>{DATE_LABEL[metric!]}</span>
                {metric === "billed" && <span>Status</span>}
                <span className="text-right">Amount</span>
              </div>
              {data.items.map((item) => (
                <div key={item.id} className={`grid ${metric === "billed" ? "grid-cols-[1fr_auto_auto_auto]" : "grid-cols-[1fr_auto_auto]"} items-center gap-3 border-b py-2 text-sm last:border-0`}>
                  <div className="min-w-0">
                    {item.href ? (
                      <Link href={item.href} className="font-medium text-primary hover:underline">
                        {item.reference}
                      </Link>
                    ) : (
                      <span className="font-medium">{item.reference}</span>
                    )}
                    <div className="truncate text-xs text-muted-foreground">{item.client_name}</div>
                  </div>
                  <span className="whitespace-nowrap text-xs text-muted-foreground">{formatDate(item.date)}</span>
                  {metric === "billed" && item.payment_status && <PaymentStatusBadge status={item.payment_status} />}
                  <span className="whitespace-nowrap text-right font-medium">{formatCurrency(item.amount)}</span>
                </div>
              ))}
              <div className={`grid ${metric === "billed" ? "grid-cols-[1fr_auto_auto_auto]" : "grid-cols-[1fr_auto_auto]"} gap-3 pt-2 text-sm font-semibold`}>
                <span>Total</span>
                <span />
                {metric === "billed" && <span />}
                <span className="text-right">{formatCurrency(data.total)}</span>
              </div>
            </div>
          )
        )}
      </DialogContent>
    </Dialog>
  );
}
