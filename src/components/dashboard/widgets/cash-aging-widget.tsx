"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { Wallet, ArrowDownLeft, ArrowUpRight, Loader2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCurrency } from "@/lib/utils";
import { dashboardFetch } from "@/lib/dashboard-fetch";

interface Bucket {
  count: number;
  total: number;
}

interface AgingSide {
  total: number;
  count: number;
  current: Bucket;
  d_0_30: Bucket;
  d_31_60: Bucket;
  d_60_plus: Bucket;
}

interface CashAging {
  receivables: AgingSide;
  payables: AgingSide;
}

function BucketRow({ label, bucket, tone }: { label: string; bucket: Bucket; tone: "current" | "warn" | "alert" | "danger" }) {
  const colors = {
    current: "text-slate-600 bg-slate-50 border-slate-200",
    warn: "text-amber-700 bg-amber-50 border-amber-200",
    alert: "text-orange-700 bg-orange-50 border-orange-200",
    danger: "text-red-700 bg-red-50 border-red-200",
  };
  return (
    <div className={`flex items-center justify-between rounded-md border px-2.5 py-1.5 ${colors[tone]}`}>
      <span className="text-[11px] font-medium">{label}</span>
      <span className="text-xs font-semibold">
        {bucket.count} · {formatCurrency(bucket.total)}
      </span>
    </div>
  );
}

function Side({
  title,
  side,
  href,
  Icon,
  tone,
}: {
  title: string;
  side: AgingSide;
  href: string;
  Icon: typeof ArrowDownLeft;
  tone: "in" | "out";
}) {
  const totalColor = tone === "in" ? "text-emerald-700" : "text-red-700";
  return (
    <div>
      <Link href={href} className="flex items-center justify-between mb-2 group">
        <div className="flex items-center gap-2">
          <Icon className={`h-4 w-4 ${tone === "in" ? "text-emerald-600" : "text-red-600"}`} />
          <span className="text-sm font-medium group-hover:underline">{title}</span>
        </div>
        <span className={`text-base font-bold ${totalColor}`}>{formatCurrency(side.total)}</span>
      </Link>
      <div className="grid grid-cols-2 gap-1.5">
        <BucketRow label="Current" bucket={side.current} tone="current" />
        <BucketRow label="0–30d" bucket={side.d_0_30} tone="warn" />
        <BucketRow label="31–60d" bucket={side.d_31_60} tone="alert" />
        <BucketRow label="60+ days" bucket={side.d_60_plus} tone="danger" />
      </div>
    </div>
  );
}

export function CashAgingWidget() {
  const [data, setData] = useState<CashAging | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    dashboardFetch("/api/dashboard/cash-aging")
      .then((r) => r.json())
      .then((j) => setData(j.data ?? null))
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, []);

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Wallet className="h-4 w-4 text-muted-foreground" />
          Cash Aging
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        {loading ? (
          <div className="flex items-center justify-center py-6">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : !data ? (
          <p className="text-sm text-muted-foreground">No data</p>
        ) : (
          <div className="space-y-4">
            <Side
              title="Receivables"
              side={data.receivables}
              href="/billing"
              Icon={ArrowDownLeft}
              tone="in"
            />
            <div className="border-t pt-4">
              <Side
                title="Payables"
                side={data.payables}
                href="/procurement/bills?payment_status=unpaid"
                Icon={ArrowUpRight}
                tone="out"
              />
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
