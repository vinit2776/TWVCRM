"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { ReceiptText, ScrollText, Wallet, Loader2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCurrency } from "@/lib/utils";

interface FinancialSummary {
  unpaid_vendor_bills: number;
  unpaid_vendor_bills_total: number;
  overdue_contracts: number;
}

export function FinancialSummaryWidget() {
  const [data, setData] = useState<FinancialSummary | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/dashboard/financial")
      .then((r) => r.json())
      .then((json) => setData(json.data ?? null))
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, []);

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Wallet className="h-4 w-4 text-muted-foreground" />
          Financial Overview
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        {loading ? (
          <div className="flex items-center justify-center py-6">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="space-y-3">
            {/* Unpaid Vendor Bills */}
            <Link
              href="/procurement/bills"
              className="flex items-center justify-between rounded-lg border px-4 py-3 hover:bg-muted/50 transition-colors group"
            >
              <div className="flex items-center gap-3">
                <ReceiptText className="h-4 w-4 text-red-500" />
                <div>
                  <p className="text-sm font-medium">Unpaid Vendor Bills</p>
                  {(data?.unpaid_vendor_bills_total ?? 0) > 0 && (
                    <p className="text-xs text-muted-foreground">
                      {formatCurrency(data!.unpaid_vendor_bills_total)} outstanding
                    </p>
                  )}
                </div>
              </div>
              <span className="text-lg font-bold text-red-600 group-hover:underline">
                {data?.unpaid_vendor_bills ?? 0}
              </span>
            </Link>

            {/* Overdue Contracts */}
            <Link
              href="/contracts"
              className="flex items-center justify-between rounded-lg border px-4 py-3 hover:bg-muted/50 transition-colors group"
            >
              <div className="flex items-center gap-3">
                <ScrollText className="h-4 w-4 text-amber-500" />
                <p className="text-sm font-medium">Overdue Contracts</p>
              </div>
              <span className="text-lg font-bold text-amber-600 group-hover:underline">
                {data?.overdue_contracts ?? 0}
              </span>
            </Link>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
