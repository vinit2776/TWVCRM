"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { ExternalLink, Loader2 } from "lucide-react";
import { formatCurrency, formatDate } from "@/lib/utils";
import { CONTRACT_PAYMENT_MODE_LABELS, CONTRACT_PAYMENT_STATUS_COLORS, CONTRACT_PAYMENT_STATUS_LABELS } from "@/lib/constants";

interface ContractBillingSectionProps {
  contractId: string;
}

interface BillingSummary {
  facilities: Array<{
    id: string;
    name: string;
    unit: string;
    cost_per_unit: number;
    free_quota: number;
  }>;
  recent_payments: Array<{
    id: string;
    payment_number: string;
    amount: number;
    payment_mode: string;
    payment_date: string;
    status: string;
    gst_invoice_number?: string;
    gst_invoice_status?: string;
    cash_handover_status?: string;
    creator?: { full_name: string };
  }>;
  lifetime: {
    total_recurring: number;
    total_facility_usage: number;
    total_ad_hoc: number;
    total_billed: number;
    total_paid: number;
    total_outstanding: number;
    months_elapsed: number;
  };
  current_month: {
    year: number;
    month: number;
    charges: number;
    paid: number;
    outstanding: number;
  };
}

export function ContractBillingSection({ contractId }: ContractBillingSectionProps) {
  const [data, setData] = useState<BillingSummary | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`/api/accounting/contract-summary?contract_id=${contractId}`)
      .then((r) => r.json())
      .then((d) => setData(d.data || null))
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, [contractId]);

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Billing</CardTitle>
        </CardHeader>
        <CardContent className="flex items-center justify-center py-8">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  if (!data) return null;

  const monthNames = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-base">Billing</CardTitle>
        <Link href="/billing?tab=statements">
          <Button variant="ghost" size="sm">
            <ExternalLink className="h-3.5 w-3.5 mr-1" />
            View Billing
          </Button>
        </Link>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Lifetime summary */}
        <div className="grid grid-cols-3 gap-4 text-center">
          <div className="rounded-md bg-muted/50 p-3">
            <p className="text-xs text-muted-foreground">Total Billed</p>
            <p className="text-lg font-bold">{formatCurrency(data.lifetime.total_billed)}</p>
            <p className="text-[10px] text-muted-foreground">{data.lifetime.months_elapsed} months</p>
          </div>
          <div className="rounded-md bg-green-50 p-3">
            <p className="text-xs text-muted-foreground">Total Paid</p>
            <p className="text-lg font-bold text-green-700">{formatCurrency(data.lifetime.total_paid)}</p>
          </div>
          <div className="rounded-md bg-red-50 p-3">
            <p className="text-xs text-muted-foreground">Outstanding</p>
            <p className={`text-lg font-bold ${data.lifetime.total_outstanding > 0 ? "text-red-700" : "text-foreground"}`}>
              {formatCurrency(data.lifetime.total_outstanding)}
            </p>
          </div>
        </div>

        {/* Current month */}
        <div>
          <h4 className="text-xs font-semibold text-muted-foreground uppercase mb-2">
            {monthNames[data.current_month.month - 1]} {data.current_month.year}
          </h4>
          <div className="flex items-center justify-between text-sm">
            <span>Charges: {formatCurrency(data.current_month.charges)}</span>
            <span className="text-green-600">Paid: {formatCurrency(data.current_month.paid)}</span>
            {data.current_month.outstanding > 0 && (
              <span className="text-red-600">Due: {formatCurrency(data.current_month.outstanding)}</span>
            )}
          </div>
        </div>

        <Separator />

        {/* Facilities */}
        {data.facilities.length > 0 && (
          <div>
            <h4 className="text-xs font-semibold text-muted-foreground uppercase mb-2">Facilities</h4>
            <div className="space-y-1">
              {data.facilities.map((f) => (
                <div key={f.id} className="flex items-center justify-between text-sm">
                  <span>
                    {f.name} <span className="text-muted-foreground">({f.unit})</span>
                  </span>
                  <span className="text-muted-foreground">
                    {formatCurrency(f.cost_per_unit)}/{f.unit}
                    {f.free_quota > 0 && ` (${f.free_quota} free)`}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Recent payments */}
        {data.recent_payments.length > 0 && (
          <div>
            <h4 className="text-xs font-semibold text-muted-foreground uppercase mb-2">Recent Payments</h4>
            <div className="space-y-2">
              {data.recent_payments.slice(0, 5).map((p) => (
                <div key={p.id} className="flex items-center justify-between text-sm">
                  <div className="flex items-center gap-2">
                    <span className="text-muted-foreground">{p.payment_number}</span>
                    <Badge variant="outline" className="text-[10px] h-4">
                      {CONTRACT_PAYMENT_MODE_LABELS[p.payment_mode] || p.payment_mode}
                    </Badge>
                    <Badge className={`text-[10px] h-4 ${CONTRACT_PAYMENT_STATUS_COLORS[p.status] || ""}`} variant="outline">
                      {CONTRACT_PAYMENT_STATUS_LABELS[p.status] || p.status}
                    </Badge>
                  </div>
                  <div className="text-right">
                    <span className="font-medium">{formatCurrency(p.amount)}</span>
                    <span className="text-xs text-muted-foreground ml-2">{formatDate(p.payment_date)}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
