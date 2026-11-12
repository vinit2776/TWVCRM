"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { SETTLEMENT_STATUS_LABELS, type SettlementStatus } from "@/lib/exit-settlement";
import { formatCurrency, formatDate } from "@/lib/utils";

interface Row {
  id: string;
  status: SettlementStatus;
  outcome: string;
  customer: string;
  contract_number: string | null;
  refund_amount: number;
  owed_amount: number;
  cleared_at: string;
  owed_invoice_reference: string | null;
}

const STYLE: Record<string, string> = {
  pending_approval: "bg-amber-100 text-amber-800",
  approved: "bg-blue-100 text-blue-800",
  paid: "bg-green-100 text-green-800",
  closed: "bg-gray-100 text-gray-700",
  returned: "bg-red-100 text-red-700",
};

/** Exit settlements in Acc Payables: deposit refunds to pay, and balances customers owe. Hidden when empty. */
export function ExitSettlementsPanel() {
  const [rows, setRows] = useState<Row[] | null>(null);

  useEffect(() => {
    fetch("/api/exit-settlements")
      .then((r) => r.json())
      .then((j) => setRows(j.data || []))
      .catch(() => setRows([]));
  }, []);

  const invoiceToRaise = (r: Row) => r.status === "closed" && r.owed_amount > 0 && !r.owed_invoice_reference;
  // Anything still needing action first; a few finished ones after for context.
  const open = (rows ?? []).filter((r) => r.status === "pending_approval" || r.status === "approved" || invoiceToRaise(r));
  const recent = (rows ?? []).filter((r) => !open.includes(r) && r.status !== "returned").slice(0, 3);
  if (!rows || (open.length === 0 && recent.length === 0)) return null;

  return (
    <Card className="mb-4 p-4" data-testid="exit-settlements-panel">
      <div className="mb-2 text-sm font-semibold">
        Exit settlements <span className="font-normal text-muted-foreground">· deposit refunds and balances owed</span>
      </div>
      <div className="divide-y text-sm">
        {[...open, ...recent].map((r) => (
          <Link key={r.id} href={`/accounting/exit-settlements/${r.id}`} className="flex items-center justify-between gap-3 py-2 hover:bg-muted/40">
            <div className="min-w-0">
              <div className="truncate font-medium">
                {r.customer} <span className="font-mono text-xs text-muted-foreground">{r.contract_number}</span>
              </div>
              <div className="text-xs text-muted-foreground">
                {r.refund_amount > 0 ? "Deposit refund" : r.owed_amount > 0 ? "Balance owed by customer" : "Settled"} · sent {formatDate(r.cleared_at)}
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-3">
              <span className="font-medium">{formatCurrency(r.refund_amount > 0 ? r.refund_amount : r.owed_amount)}</span>
              <Badge variant="secondary" className={STYLE[r.status]}>
                {invoiceToRaise(r) ? "Invoice to raise" : SETTLEMENT_STATUS_LABELS[r.status]}
              </Badge>
            </div>
          </Link>
        ))}
      </div>
    </Card>
  );
}
