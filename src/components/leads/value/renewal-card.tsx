"use client";

import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/shared/loading-skeleton";
import type { Insight } from "@/lib/customer-value/insights";
import type { RenewalOutlook } from "@/lib/customer-value/renewal-outlook";

interface RenewalData {
  outlook: RenewalOutlook;
  insights: Insight[];
}

const DOT: Record<"good" | "watch" | "risk" | "plain", string> = {
  good: "bg-green-500",
  watch: "bg-amber-500",
  risk: "bg-red-500",
  plain: "bg-gray-300",
};
const TONE_BADGE: Record<Insight["tone"], string> = {
  risk: "bg-red-100 text-red-800",
  watch: "bg-amber-100 text-amber-800",
  good: "bg-green-100 text-green-800",
};
const TONE_LABEL: Record<Insight["tone"], string> = { risk: "Risk", watch: "Watch", good: "Good sign" };

/**
 * The renewal outlook and the cross-pillar insights on the Summary sub-tab. It loads
 * on its own so a slow cost read can never hold up the score, and a failure here
 * only hides these two cards. `refreshKey` changes when the score is recomputed.
 */
export function RenewalCard({ leadId, refreshKey }: { leadId: string; refreshKey?: string }) {
  const [data, setData] = useState<RenewalData | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setFailed(false);
    fetch(`/api/leads/${leadId}/value/renewal`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("failed"))))
      .then((j: RenewalData) => {
        if (!cancelled) setData(j);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [leadId, refreshKey]);

  if (loading) return <Skeleton className="h-32" />;
  if (failed || !data) return null;

  const { outlook, insights } = data;
  const showOutlook = outlook.stage !== "no_live_contract";

  return (
    <>
      {showOutlook && (
        <Card>
          <CardHeader className="pb-2">
            <div className="flex flex-wrap items-center gap-2">
              <CardTitle className="text-base">Renewal outlook</CardTitle>
              {outlook.urgent && <Badge variant="secondary" className="bg-red-100 text-red-800">Needs attention</Badge>}
            </div>
            <p className="text-sm">{outlook.headline}</p>
          </CardHeader>
          <CardContent>
            <ul className="space-y-1.5 text-sm">
              {outlook.lines.map((l) => (
                <li key={l.text} className="flex items-start gap-2">
                  <span className={`mt-1.5 inline-block h-2 w-2 shrink-0 rounded-full ${DOT[l.tone]}`} aria-hidden="true" />
                  <span>{l.text}</span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {insights.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">What the scores say together</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-2 text-sm">
              {insights.map((i) => (
                <li key={i.key} className="flex items-start gap-2" title={`Based on: ${i.basis.join(", ")}`}>
                  <Badge variant="secondary" className={`mt-0.5 shrink-0 whitespace-nowrap px-1.5 text-[10px] ${TONE_BADGE[i.tone]}`}>{TONE_LABEL[i.tone]}</Badge>
                  <span>{i.text}</span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </>
  );
}
