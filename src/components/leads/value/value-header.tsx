"use client";

import { useState } from "react";
import { ArrowDownRight, ArrowRight, ArrowUpRight, Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/shared/loading-skeleton";
import {
  TIER_STYLES,
  TREND_TEXT,
  computedAgo,
  isStale,
  type StoredScoreRow,
} from "@/lib/customer-value/summary-view";

/**
 * Sits above the Value sub-tabs: the tier, which way it is heading, how fresh
 * it is, and a Recompute button. Shown from the stored score, so it costs one
 * small read and never blocks the sub-tabs below it.
 */
export function ValueHeader({
  latest,
  loading,
  error,
  leadId,
  onRecomputed,
}: {
  latest: StoredScoreRow | null;
  loading: boolean;
  error: string | null;
  leadId: string;
  onRecomputed: () => void | Promise<void>;
}) {
  const [recomputing, setRecomputing] = useState(false);

  const recompute = async () => {
    setRecomputing(true);
    try {
      const res = await fetch(`/api/leads/${leadId}/value/recompute`, { method: "POST" });
      const json = (await res.json().catch(() => ({}))) as { error?: string; warnings?: string[] };
      if (!res.ok) {
        toast.error(json.error ?? "Couldn't recompute the score");
        return;
      }
      toast.success("Score recomputed");
      if (json.warnings?.length) toast.warning(json.warnings[0]);
      await onRecomputed();
    } catch {
      toast.error("Couldn't recompute the score");
    } finally {
      setRecomputing(false);
    }
  };

  const now = new Date();
  const TrendIcon = latest?.trend_vs_90d === "up" ? ArrowUpRight : latest?.trend_vs_90d === "down" ? ArrowDownRight : ArrowRight;
  const previous = latest?.method?.previous_overall ?? null;

  return (
    <div className="flex flex-wrap items-center gap-4 rounded-lg border bg-card px-4 py-3">
      {loading ? (
        <Skeleton className="h-14 w-64" />
      ) : (
        <>
          <div
            className={`flex h-14 w-14 flex-col items-center justify-center rounded-lg ${
              latest?.tier ? TIER_STYLES[latest.tier] : "bg-muted text-muted-foreground"
            }`}
            aria-label={latest?.tier ? `Tier ${latest.tier}` : "No tier yet"}
          >
            <span className="text-2xl font-semibold leading-none">{latest?.tier ?? "—"}</span>
            <span className="text-[10px]">tier</span>
          </div>

          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium">
                {latest?.overall !== null && latest?.overall !== undefined ? `Overall ${Math.round(latest.overall)} out of 100` : "Not graded yet"}
              </span>
              <Badge variant="outline" className="text-[10px]">Beta</Badge>
            </div>
            {latest?.trend_vs_90d && latest.overall !== null ? (
              <p className="flex items-center gap-1 text-xs text-muted-foreground">
                <TrendIcon className="h-3.5 w-3.5" aria-hidden="true" />
                {TREND_TEXT[latest.trend_vs_90d]} over 90 days
                {previous !== null ? `, was ${Math.round(previous)}` : ""}
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">{latest?.reason ?? error ?? "The score is computed each night."}</p>
            )}
            {latest?.method?.tier_cap && (
              <p className="text-xs text-amber-700">
                Tier held at {latest.method.tier_cap.maxTier} because {latest.method.tier_cap.pillar} is weak.
              </p>
            )}
          </div>

          <div className="flex flex-col items-end gap-1">
            {latest && (
              <span className={`text-xs ${isStale(latest.computed_at, now) ? "text-amber-700" : "text-muted-foreground"}`}>
                {computedAgo(latest.computed_at, now)}
                {isStale(latest.computed_at, now) ? " (a nightly run was missed)" : ""}
              </span>
            )}
            <Button variant="outline" size="sm" onClick={recompute} disabled={recomputing}>
              {recomputing ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-1 h-3.5 w-3.5" />}
              Recompute
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
