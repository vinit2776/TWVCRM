"use client";

import { useCallback, useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { MessageCircle, TrendingUp, ThumbsUp, Users, RefreshCw } from "lucide-react";
import { PageBreadcrumb } from "@/components/page-breadcrumb";
import { DailyTrendChart } from "@/components/help/assistant-analytics-charts";
import { USER_ROLE_LABELS } from "@/lib/constants";
import type { HelpChatAnalyticsSummary } from "@/lib/help/help-chat-analytics";

const DAY_OPTIONS = [7, 14, 30, 90];

function HBarList({
  rows,
  labelFor,
  emptyText,
  barClassName = "bg-primary",
}: {
  rows: { key: string; count: number }[];
  labelFor: (key: string) => string;
  emptyText: string;
  barClassName?: string;
}) {
  if (rows.length === 0) {
    return <p className="px-4 pb-4 text-xs text-muted-foreground">{emptyText}</p>;
  }
  const max = Math.max(...rows.map((r) => r.count));
  return (
    <div className="divide-y">
      {rows.map((row) => (
        <div key={row.key} className="flex items-center gap-2.5 px-4 py-2">
          <div className="w-32 shrink-0 truncate text-xs">{labelFor(row.key)}</div>
          <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
            <div
              className={`h-full rounded-full ${barClassName}`}
              style={{ width: `${max > 0 ? Math.max(4, (row.count / max) * 100) : 0}%` }}
            />
          </div>
          <div className="w-8 shrink-0 text-right text-xs font-semibold">{row.count}</div>
        </div>
      ))}
    </div>
  );
}

export default function AssistantAnalyticsPage() {
  const [days, setDays] = useState(30);
  const [loading, setLoading] = useState(false);
  const [summary, setSummary] = useState<HelpChatAnalyticsSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/help-chat/analytics?days=${days}`);
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Couldn't load analytics");
        setSummary(null);
        return;
      }
      setSummary(data);
    } catch {
      setError("Couldn't load analytics");
      setSummary(null);
    } finally {
      setLoading(false);
    }
  }, [days]);

  useEffect(() => {
    load();
  }, [load]);

  const ratedTotal = summary ? summary.feedback.helpful + summary.feedback.notHelpful : 0;

  return (
    <div className="space-y-6 p-6">
      <PageBreadcrumb resetTo={{ label: "Assistant Analytics" }} />

      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
        <div>
          <h1 className="text-xl font-semibold">Assistant Analytics</h1>
          <p className="text-sm text-muted-foreground">
            How staff use the WorkVilla Assistant — where, who, and whether they&apos;re getting a useful
            answer. Question and answer text is never stored, only structured signals.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex gap-1">
            {DAY_OPTIONS.map((d) => (
              <Button
                key={d}
                size="sm"
                variant={days === d ? "default" : "outline"}
                className="h-8 px-2.5 text-xs"
                onClick={() => setDays(d)}
              >
                {d}d
              </Button>
            ))}
          </div>
          <Button size="sm" variant="outline" className="h-8" onClick={load} disabled={loading}>
            <RefreshCw size={13} className={loading ? "animate-spin" : ""} />
          </Button>
        </div>
      </div>

      {error && (
        <Card>
          <CardContent className="p-4 text-sm text-destructive">{error}</CardContent>
        </Card>
      )}

      {summary && (
        <>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Card>
              <CardContent className="p-4">
                <div className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
                  <MessageCircle size={13} /> Questions Asked
                </div>
                <p className="text-2xl font-bold">{summary.totalQuestions}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">last {days}d</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <div className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
                  <TrendingUp size={13} /> Content Match Rate
                </div>
                <p className="text-2xl font-bold">{summary.matchRate}%</p>
                <p className="mt-0.5 text-xs text-muted-foreground">had a matching guide section</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <div className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
                  <ThumbsUp size={13} /> Helpful Rate
                </div>
                <p className="text-2xl font-bold">{summary.helpfulRate}%</p>
                <p className="mt-0.5 text-xs text-muted-foreground">of {ratedTotal} rated answers</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <div className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
                  <Users size={13} /> Active Staff
                </div>
                <p className="text-2xl font-bold">{summary.activeUsers}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">used the assistant</p>
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm">Daily Usage</CardTitle>
            </CardHeader>
            <CardContent>
              {summary.dailyTrend.every((d) => d.count === 0) ? (
                <p className="text-xs text-muted-foreground">No questions in this period.</p>
              ) : (
                <DailyTrendChart trend={summary.dailyTrend} />
              )}
            </CardContent>
          </Card>

          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm">Who&apos;s Asking</CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <HBarList
                  rows={summary.byRole.map((r) => ({ key: r.role, count: r.count }))}
                  labelFor={(role) => USER_ROLE_LABELS[role] ?? role}
                  emptyText="No activity in this period."
                />
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm">Where It&apos;s Used</CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <HBarList
                  rows={summary.byPage.map((p) => ({ key: p.path, count: p.count }))}
                  labelFor={(path) => path}
                  emptyText="No activity in this period."
                  barClassName="bg-accent"
                />
              </CardContent>
            </Card>
          </div>

          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm">Top Topics</CardTitle>
                <p className="text-xs text-muted-foreground">Matched knowledge sections</p>
              </CardHeader>
              <CardContent className="p-0">
                <HBarList
                  rows={summary.bySection.map((s) => ({ key: s.sectionId, count: s.count }))}
                  labelFor={(id) => summary.bySection.find((s) => s.sectionId === id)?.title ?? id}
                  emptyText="No matched content in this period."
                />
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm">Feedback</CardTitle>
                <p className="text-xs text-muted-foreground">of {ratedTotal} rated answers</p>
              </CardHeader>
              <CardContent>
                {ratedTotal === 0 ? (
                  <p className="text-xs text-muted-foreground">No feedback given yet in this period.</p>
                ) : (
                  <>
                    <div className="flex h-6 overflow-hidden rounded-md border">
                      <div
                        className="flex items-center justify-center bg-accent text-[11px] font-semibold text-white"
                        style={{ width: `${(summary.feedback.helpful / ratedTotal) * 100}%` }}
                      >
                        {summary.feedback.helpful > 0 && `${summary.feedback.helpful} helpful`}
                      </div>
                      <div
                        className="flex items-center justify-center bg-destructive text-[11px] font-semibold text-white"
                        style={{ width: `${(summary.feedback.notHelpful / ratedTotal) * 100}%` }}
                      >
                        {summary.feedback.notHelpful > 0 && `${summary.feedback.notHelpful} not helpful`}
                      </div>
                    </div>
                    <p className="mt-2 text-xs text-muted-foreground">
                      {summary.feedback.unrated} of {summary.totalQuestions} answers weren&apos;t rated.
                    </p>
                  </>
                )}
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm">Content Gaps</CardTitle>
              <p className="text-xs text-muted-foreground">
                No-match rate by page — where the assistant most often has nothing to offer
              </p>
            </CardHeader>
            <CardContent className="p-0">
              {summary.noMatchRateByPage.length === 0 ? (
                <p className="px-4 pb-4 text-xs text-muted-foreground">
                  Not enough volume yet on any single page to show a reliable gap.
                </p>
              ) : (
                <div className="divide-y">
                  {summary.noMatchRateByPage.map((g) => (
                    <div key={g.path} className="flex items-center justify-between gap-2 px-4 py-2.5">
                      <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{g.path}</code>
                      <span
                        className={`text-xs font-semibold ${
                          g.noMatchRate >= 30
                            ? "text-destructive"
                            : g.noMatchRate >= 15
                              ? "text-amber-600"
                              : "text-muted-foreground"
                        }`}
                      >
                        {g.noMatchRate}% no match · {g.total} question{g.total === 1 ? "" : "s"}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
