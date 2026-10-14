"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { LifeBuoy, AlertCircle, CheckCircle2, Clock, Loader2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { dashboardFetch } from "@/lib/dashboard-fetch";

interface SupportSummary {
  open: number;
  in_progress: number;
  build_approved: number;
}

export function SupportSummaryWidget() {
  const [data, setData] = useState<SupportSummary | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    dashboardFetch("/api/dashboard/support")
      .then((r) => r.json())
      .then((json) => setData(json.data ?? null))
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, []);

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            <LifeBuoy className="h-4 w-4 text-muted-foreground" />
            Support Tickets
          </CardTitle>
          <Link
            href="/support"
            className="text-xs text-primary hover:underline underline-offset-2"
          >
            View all →
          </Link>
        </div>
      </CardHeader>
      <CardContent className="pt-0">
        {loading ? (
          <div className="flex items-center justify-center py-6">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="grid grid-cols-3 gap-3">
            <Link
              href="/support?status=open"
              className="flex flex-col items-center justify-center rounded-lg border p-3 hover:bg-yellow-50 transition-colors group"
            >
              <AlertCircle className="h-5 w-5 text-yellow-500 mb-1" />
              <span className="text-2xl font-bold text-yellow-600">{data?.open ?? 0}</span>
              <span className="text-[11px] text-muted-foreground mt-0.5">Open</span>
            </Link>

            <Link
              href="/support?status=in_progress"
              className="flex flex-col items-center justify-center rounded-lg border p-3 hover:bg-blue-50 transition-colors group"
            >
              <Clock className="h-5 w-5 text-blue-500 mb-1" />
              <span className="text-2xl font-bold text-blue-600">{data?.in_progress ?? 0}</span>
              <span className="text-[11px] text-muted-foreground mt-0.5">In Progress</span>
            </Link>

            <Link
              href="/support?status=build_approved"
              className="flex flex-col items-center justify-center rounded-lg border p-3 hover:bg-emerald-50 transition-colors group"
            >
              <CheckCircle2 className="h-5 w-5 text-emerald-500 mb-1" />
              <span className="text-2xl font-bold text-emerald-600">{data?.build_approved ?? 0}</span>
              <span className="text-[11px] text-muted-foreground mt-0.5">Build Approved</span>
            </Link>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
