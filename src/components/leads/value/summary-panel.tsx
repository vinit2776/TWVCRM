"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/shared/empty-state";
import { Skeleton } from "@/components/shared/loading-skeleton";
import { LineChart } from "lucide-react";
import { ScoreChart } from "@/components/leads/value/score-chart";
import { formatCurrency, formatDate } from "@/lib/utils";
import {
  PILLAR_HELP,
  PILLAR_LABELS,
  SUMMARY_PILLARS,
  confidenceChip,
  pillarHeadline,
  type SeriesPoint,
  type StoredScoreRow,
} from "@/lib/customer-value/summary-view";

export interface SummaryData {
  latest: StoredScoreRow | null;
  series: SeriesPoint[];
  evidence: Record<string, { reference: string; total: number | null; due_date: string | null }>;
}

const TONE: Record<"good" | "warn" | "bad", string> = {
  good: "bg-green-100 text-green-800",
  warn: "bg-amber-100 text-amber-800",
  bad: "bg-gray-100 text-gray-700",
};

function barColor(score: number | null): string {
  if (score === null) return "bg-gray-300";
  if (score >= 75) return "bg-green-500";
  if (score >= 60) return "bg-blue-500";
  if (score >= 40) return "bg-amber-500";
  return "bg-red-500";
}

export function SummaryPanel({
  data,
  loading,
  error,
  onRetry,
  onOpenMoney,
}: {
  data: SummaryData | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  onOpenMoney: () => void;
}) {
  if (loading) {
    return (
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-28" />
          ))}
        </div>
        <Skeleton className="h-24" />
        <Skeleton className="h-44" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <Card>
        <CardContent className="flex items-center justify-between gap-4 py-6">
          <p className="text-sm text-muted-foreground">{error ?? "Could not load the summary"}</p>
          <Button variant="outline" size="sm" onClick={onRetry}>Retry</Button>
        </CardContent>
      </Card>
    );
  }

  const { latest, series, evidence } = data;

  if (!latest) {
    return (
      <Card>
        <CardContent>
          <EmptyState
            icon={LineChart}
            title="No score yet"
            description="Scores are computed each night. Use Recompute above to work this customer out now."
          />
        </CardContent>
      </Card>
    );
  }

  const pillars = latest.method?.pillars ?? {};
  const sentences = latest.story?.sentences ?? [];
  // Each invoice once, tagged with why it is listed. Being overdue outranks any other reason.
  const REASON: Record<string, string> = { open_problems: "Overdue", payment: "Recent invoice" };
  const evidenceRows: Array<{ id: string; reason: string }> = [];
  for (const s of sentences) {
    for (const id of s.evidence) {
      if (!evidence[id]) continue;
      const reason = REASON[s.metric] ?? "Related";
      const existing = evidenceRows.find((r) => r.id === id);
      if (!existing) evidenceRows.push({ id, reason });
      else if (reason === "Overdue") existing.reason = reason;
    }
  }
  evidenceRows.sort((a, b) => Number(b.reason === "Overdue") - Number(a.reason === "Overdue"));

  return (
    <div className="space-y-4">
      {latest.status !== "graded" && (
        <p className="rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground">
          No tier yet: {latest.reason ?? "not enough history"}. The measures below are shown for information.
        </p>
      )}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {SUMMARY_PILLARS.map((key) => {
          const score = latest[key];
          const chip = confidenceChip(key, score, latest.confidence?.[key]);
          return (
            <Card key={key}>
              <CardContent className="space-y-2 p-4">
                <div className="flex items-start justify-between gap-2">
                  <p className="text-xs text-muted-foreground" title={PILLAR_HELP[key]}>{PILLAR_LABELS[key]}</p>
                  <Badge variant="secondary" className={`${TONE[chip.tone]} px-1.5 text-[10px]`}>{chip.label}</Badge>
                </div>
                <p className="text-2xl font-semibold leading-none">{score === null ? "—" : Math.round(score)}</p>
                <div className="h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden="true">
                  <div className={`h-full ${barColor(score)}`} style={{ width: `${score ?? 0}%` }} />
                </div>
                <p className="text-xs text-muted-foreground">{pillarHeadline(pillars[key], score)}</p>
              </CardContent>
            </Card>
          );
        })}
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">The story</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {sentences.length > 0 ? (
            <ul className="space-y-1 text-sm">
              {sentences.map((s) => (
                <li key={s.metric}>{s.text}</li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">Nothing notable to report.</p>
          )}
          {latest.story?.action && (
            <p className="text-sm text-muted-foreground">
              <span className="font-medium text-foreground">Suggested: </span>
              {latest.story.action.text}
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Overall score, last 12 months</CardTitle>
        </CardHeader>
        <CardContent>
          {series.length > 0 ? (
            <ScoreChart points={series} />
          ) : (
            <p className="text-sm text-muted-foreground">There is no graded history to chart yet.</p>
          )}
        </CardContent>
      </Card>

      {evidenceRows.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">What is behind it</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="divide-y text-sm">
              {evidenceRows.map(({ id, reason }) => {
                const e = evidence[id];
                return (
                  <li key={id} className="flex items-center justify-between gap-3 py-2">
                    <span>
                      <span className="font-medium">{e.reference}</span>
                      <Badge variant="secondary" className={`ml-2 px-1.5 text-[10px] ${reason === "Overdue" ? "bg-red-100 text-red-800" : "bg-gray-100 text-gray-700"}`}>
                        {reason}
                      </Badge>
                      <span className="text-muted-foreground">
                        {e.total !== null ? ` · ${formatCurrency(e.total)}` : ""}
                        {e.due_date ? ` · due ${formatDate(e.due_date)}` : ""}
                      </span>
                    </span>
                    <Button variant="ghost" size="sm" onClick={onOpenMoney}>View in Money</Button>
                  </li>
                );
              })}
            </ul>
          </CardContent>
        </Card>
      )}

      <p className="text-xs text-muted-foreground">
        Scores are a guide, not a verdict, and are in beta. Revenue health uses revenue-side measures only until cost data is added.
      </p>
    </div>
  );
}
