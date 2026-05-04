"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { Gauge, Loader2, Inbox } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCurrency } from "@/lib/utils";

interface OveruseItem {
  id: string;
  contract_number: string;
  customer: string;
  service_name: string;
  unit_label: string;
  overage_quantity: number;
  amount: number;
  total_with_gst: number;
}

interface OveruseData {
  total_unbilled_value: number;
  total_records: number;
  total_contracts: number;
  items: OveruseItem[];
}

export function QuotaOveruseWidget() {
  const [data, setData] = useState<OveruseData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/dashboard/quota-overuse")
      .then((r) => r.json())
      .then((j) => setData(j.data ?? null))
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, []);

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            <Gauge className="h-4 w-4 text-muted-foreground" />
            Quota Overuse (this month)
          </CardTitle>
          <Link href="/billing" className="text-xs text-primary hover:underline">
            Bill →
          </Link>
        </div>
      </CardHeader>
      <CardContent className="pt-0">
        {loading ? (
          <div className="flex items-center justify-center py-6">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : !data || data.items.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-6 text-center">
            <Inbox className="h-8 w-8 mb-2 text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">No unbilled overage</p>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3">
              <p className="text-[11px] text-emerald-700 uppercase tracking-wide">
                Unbilled Overage Value
              </p>
              <p className="text-2xl font-bold text-emerald-700 mt-1">
                {formatCurrency(data.total_unbilled_value)}
              </p>
              <p className="text-xs text-emerald-700 mt-0.5">
                {data.total_records} records · {data.total_contracts} contracts
              </p>
            </div>

            <div className="space-y-1 pt-1">
              {data.items.map((it) => (
                <div
                  key={it.id}
                  className="flex items-center justify-between rounded-md px-2 py-1.5 hover:bg-muted/40"
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium truncate">{it.customer}</p>
                    <p className="text-xs text-muted-foreground truncate">
                      {it.service_name} · {it.overage_quantity} {it.unit_label}
                    </p>
                  </div>
                  <span className="text-sm font-semibold text-emerald-700 shrink-0 ml-2 tabular-nums">
                    {formatCurrency(it.total_with_gst)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
