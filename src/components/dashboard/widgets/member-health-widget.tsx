"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { HeartPulse, Loader2, Inbox, Star } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface AtRiskMember {
  lead_id: string;
  name: string;
  avg_overall: number;
  avg_renewal: number;
  ratings: number;
}

interface MemberHealthData {
  total_members_rated: number;
  total_ratings: number;
  avg_renewal_likelihood: number;
  avg_overall_rating: number;
  promoters: number;
  detractors: number;
  at_risk: AtRiskMember[];
}

export function MemberHealthWidget() {
  const [data, setData] = useState<MemberHealthData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/dashboard/member-health")
      .then((r) => r.json())
      .then((j) => setData(j.data ?? null))
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, []);

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <HeartPulse className="h-4 w-4 text-muted-foreground" />
          Member Health (90d)
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        {loading ? (
          <div className="flex items-center justify-center py-6">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : !data || data.total_members_rated === 0 ? (
          <div className="flex flex-col items-center justify-center py-6 text-center">
            <Inbox className="h-8 w-8 mb-2 text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">No feedback in last 90 days</p>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-2">
              <div className="rounded-lg bg-muted/40 p-3">
                <p className="text-[11px] text-muted-foreground uppercase tracking-wide">
                  Avg Renewal Likelihood
                </p>
                <p className="text-2xl font-bold mt-1 flex items-center gap-1">
                  {data.avg_renewal_likelihood.toFixed(1)}
                  <Star className="h-4 w-4 text-amber-500 fill-amber-400" />
                </p>
              </div>
              <div className="rounded-lg bg-muted/40 p-3">
                <p className="text-[11px] text-muted-foreground uppercase tracking-wide">
                  Avg Overall
                </p>
                <p className="text-2xl font-bold mt-1 flex items-center gap-1">
                  {data.avg_overall_rating.toFixed(1)}
                  <Star className="h-4 w-4 text-amber-500 fill-amber-400" />
                </p>
              </div>
            </div>

            <div className="grid grid-cols-3 gap-2">
              <div className="rounded-md border border-emerald-200 bg-emerald-50 px-2 py-1.5 text-center">
                <p className="text-[10px] text-emerald-700 uppercase">Promoters</p>
                <p className="text-base font-semibold text-emerald-700">{data.promoters}</p>
              </div>
              <div className="rounded-md border bg-muted/30 px-2 py-1.5 text-center">
                <p className="text-[10px] text-muted-foreground uppercase">Rated</p>
                <p className="text-base font-semibold">{data.total_members_rated}</p>
              </div>
              <div className="rounded-md border border-red-200 bg-red-50 px-2 py-1.5 text-center">
                <p className="text-[10px] text-red-700 uppercase">Detractors</p>
                <p className="text-base font-semibold text-red-700">{data.detractors}</p>
              </div>
            </div>

            {data.at_risk.length > 0 && (
              <div className="border-t pt-2">
                <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide mb-1">
                  At-risk members
                </p>
                <div className="space-y-1">
                  {data.at_risk.map((m) => (
                    <Link
                      key={m.lead_id}
                      href={`/leads/${m.lead_id}`}
                      className="flex items-center justify-between rounded-md px-2 py-1.5 hover:bg-muted/40 transition-colors"
                    >
                      <p className="text-sm truncate flex-1 mr-2">{m.name}</p>
                      <div className="flex items-center gap-2 text-xs shrink-0">
                        <span className="text-muted-foreground">{m.ratings}x</span>
                        <span className="font-semibold text-red-600">
                          {m.avg_renewal.toFixed(1)} ★
                        </span>
                      </div>
                    </Link>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
