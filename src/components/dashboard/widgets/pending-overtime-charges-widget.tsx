"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { AlarmClock, Loader2, Inbox } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCurrency } from "@/lib/utils";

interface OvertimeItem {
  id: string;
  contract_number: string;
  customer: string;
  booking_number: string;
  booking_id: string | null;
  amount: number;
}

interface OvertimeData {
  total_pending_value: number;
  total_records: number;
  items: OvertimeItem[];
}

export function PendingOvertimeChargesWidget() {
  const [data, setData] = useState<OvertimeData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/dashboard/pending-overtime-charges")
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
            <AlarmClock className="h-4 w-4 text-muted-foreground" />
            Pending Usage Charges
          </CardTitle>
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
            <p className="text-sm text-muted-foreground">No pending usage charges</p>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-3">
              <p className="text-[11px] text-amber-700 uppercase tracking-wide">
                Pending Usage Charge Value
              </p>
              <p className="text-2xl font-bold text-amber-700 mt-1">
                {formatCurrency(data.total_pending_value)}
              </p>
              <p className="text-xs text-amber-700 mt-0.5">
                {data.total_records} record{data.total_records !== 1 ? "s" : ""} awaiting review
              </p>
            </div>

            <div className="space-y-1 pt-1">
              {data.items.map((it) => (
                <Link
                  key={it.id}
                  href={it.booking_id ? `/bookings/${it.booking_id}` : "#"}
                  className="flex items-center justify-between rounded-md px-2 py-1.5 hover:bg-muted/40"
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium truncate">{it.customer}</p>
                    <p className="text-xs text-muted-foreground truncate">
                      {it.contract_number} · {it.booking_number}
                    </p>
                  </div>
                  <span className="text-sm font-semibold text-amber-700 shrink-0 ml-2 tabular-nums">
                    {formatCurrency(it.amount)}
                  </span>
                </Link>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
