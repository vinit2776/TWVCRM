"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { ShoppingCart, FileText, ReceiptText, Loader2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCurrency } from "@/lib/utils";

interface ProcurementSummary {
  pending_prs: number;
  pending_po_approvals: number;
  unpaid_bills: number;
  unpaid_bills_total: number;
}

export function ProcurementSummaryWidget() {
  const [data, setData] = useState<ProcurementSummary | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/dashboard/procurement")
      .then((r) => r.json())
      .then((json) => setData(json.data ?? null))
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, []);

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <ShoppingCart className="h-4 w-4 text-muted-foreground" />
          Procurement Overview
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        {loading ? (
          <div className="flex items-center justify-center py-6">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="space-y-3">
            <Link
              href="/procurement/requests?status=submitted"
              className="flex items-center justify-between rounded-lg border px-4 py-3 hover:bg-muted/50 transition-colors group"
            >
              <div className="flex items-center gap-3">
                <FileText className="h-4 w-4 text-amber-500" />
                <span className="text-sm font-medium">Pending PRs</span>
              </div>
              <span className="text-lg font-bold text-amber-600 group-hover:underline">
                {data?.pending_prs ?? 0}
              </span>
            </Link>

            <Link
              href="/procurement/orders?status=pending"
              className="flex items-center justify-between rounded-lg border px-4 py-3 hover:bg-muted/50 transition-colors group"
            >
              <div className="flex items-center gap-3">
                <ShoppingCart className="h-4 w-4 text-blue-500" />
                <span className="text-sm font-medium">POs Awaiting Order</span>
              </div>
              <span className="text-lg font-bold text-blue-600 group-hover:underline">
                {data?.pending_po_approvals ?? 0}
              </span>
            </Link>

            <Link
              href="/procurement/bills?payment_status=unpaid"
              className="flex items-center justify-between rounded-lg border px-4 py-3 hover:bg-muted/50 transition-colors group"
            >
              <div className="flex items-center gap-3">
                <ReceiptText className="h-4 w-4 text-red-500" />
                <span className="text-sm font-medium">Unpaid Bills</span>
              </div>
              <div className="text-right">
                <div className="text-lg font-bold text-red-600 group-hover:underline">
                  {data?.unpaid_bills ?? 0}
                </div>
                {(data?.unpaid_bills_total ?? 0) > 0 && (
                  <div className="text-xs text-muted-foreground">
                    {formatCurrency(data!.unpaid_bills_total)} due
                  </div>
                )}
              </div>
            </Link>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
