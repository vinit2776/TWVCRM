"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { Home, Loader2, TrendingUp, AlertCircle } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCurrency } from "@/lib/utils";

interface LocationRentRevenue {
  location_id: string;
  location_name: string;
  rent_paid: number;
  revenue_billed: number;
  rent_ratio: number | null; // percentage of revenue going to rent
}

export function RentRevenueWidget() {
  const [data, setData] = useState<LocationRentRevenue[] | null>(null);
  const [paymentMonth, setPaymentMonth] = useState<string>("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/dashboard/rent-revenue")
      .then((r) => r.json())
      .then((json) => {
        setData(json.data ?? []);
        setPaymentMonth(json.paymentMonth ?? "");
      })
      .catch(() => setData([]))
      .finally(() => setLoading(false));
  }, []);

  const HIGH_RATIO_THRESHOLD = 40; // warn if rent > 40% of revenue

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center justify-between">
          <span className="flex items-center gap-2">
            <Home className="h-4 w-4 text-muted-foreground" />
            Rent vs Revenue
          </span>
          {paymentMonth && (
            <span className="text-xs font-normal text-muted-foreground">{paymentMonth}</span>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        {loading ? (
          <div className="flex items-center justify-center py-6">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : !data || data.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4 text-center">
            No rent or revenue data for this month
          </p>
        ) : (
          <div className="space-y-2">
            {data.map((row) => {
              const isHigh = row.rent_ratio !== null && row.rent_ratio > HIGH_RATIO_THRESHOLD;
              return (
                <div key={row.location_id} className="rounded-lg border px-3 py-2.5 space-y-1.5">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium truncate">{row.location_name}</span>
                    {isHigh && (
                      <span className="flex items-center gap-1 text-xs text-red-600">
                        <AlertCircle className="h-3 w-3" />
                        {row.rent_ratio}% of revenue
                      </span>
                    )}
                    {!isHigh && row.rent_ratio !== null && (
                      <span className="flex items-center gap-1 text-xs text-muted-foreground">
                        <TrendingUp className="h-3 w-3" />
                        {row.rent_ratio}%
                      </span>
                    )}
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-xs">
                    <div>
                      <p className="text-muted-foreground">Rent paid</p>
                      <p className="font-semibold text-orange-700">
                        {row.rent_paid > 0 ? formatCurrency(row.rent_paid) : "—"}
                      </p>
                    </div>
                    <div>
                      <p className="text-muted-foreground">Revenue billed</p>
                      <p className="font-semibold text-green-700">
                        {row.revenue_billed > 0 ? formatCurrency(row.revenue_billed) : "—"}
                      </p>
                    </div>
                  </div>
                  {/* Ratio bar */}
                  {row.revenue_billed > 0 && row.rent_paid > 0 && (
                    <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full transition-all ${isHigh ? "bg-red-500" : "bg-orange-400"}`}
                        style={{ width: `${Math.min(row.rent_ratio ?? 0, 100)}%` }}
                      />
                    </div>
                  )}
                </div>
              );
            })}

            <Link
              href="/accounting?tab=rent"
              className="block text-center text-xs text-primary hover:underline pt-1"
            >
              View rent payable →
            </Link>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
