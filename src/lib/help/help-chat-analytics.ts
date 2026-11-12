import type { HelpSection } from "@/lib/help-content";

export interface HelpChatInteractionRow {
  user_id: string;
  role: string;
  page_path: string;
  had_match: boolean;
  section_ids: string[];
  feedback: "helpful" | "not_helpful" | null;
  created_at: string;
}

export interface HelpChatAnalyticsSummary {
  totalQuestions: number;
  activeUsers: number;
  matchRate: number;
  helpfulRate: number;
  byRole: { role: string; count: number }[];
  byPage: { path: string; count: number }[];
  bySection: { sectionId: string; title: string; count: number }[];
  feedback: { helpful: number; notHelpful: number; unrated: number };
  noMatchRateByPage: { path: string; total: number; noMatchRate: number }[];
  dailyTrend: { date: string; count: number }[];
}

const IST_DATE_FORMATTER = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" });

function toIstDateKey(iso: string): string {
  // en-CA formats as YYYY-MM-DD, which is what we want as a sortable bucket key.
  return IST_DATE_FORMATTER.format(new Date(iso));
}

function sortedCounts<T extends string>(counts: Map<T, number>, limit?: number) {
  const entries = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  return limit ? entries.slice(0, limit) : entries;
}

/**
 * Pure aggregation over raw interaction rows — no DB/network access, so
 * the actual grouping logic (page normalization already applied upstream,
 * section-id-to-title lookup, gap detection) is unit-testable without a
 * live Supabase project. The API route is a thin wrapper: fetch rows for
 * the window, call this, return the result.
 */
export function summarizeHelpChatInteractions(
  rows: HelpChatInteractionRow[],
  sections: HelpSection[],
  opts: { days: number; topN?: number; minSampleForGaps?: number; now?: Date }
): HelpChatAnalyticsSummary {
  const topN = opts.topN ?? 8;
  const minSampleForGaps = opts.minSampleForGaps ?? 5;
  const sectionTitleById = new Map(sections.map((s) => [s.id, s.title]));

  const byRole = new Map<string, number>();
  const byPage = new Map<string, number>();
  const bySection = new Map<string, number>();
  const pageTotals = new Map<string, number>();
  const pageNoMatch = new Map<string, number>();
  const dailyCounts = new Map<string, number>();
  const activeUserIds = new Set<string>();

  let matchedCount = 0;
  let helpfulCount = 0;
  let notHelpfulCount = 0;

  for (const row of rows) {
    activeUserIds.add(row.user_id);
    byRole.set(row.role, (byRole.get(row.role) ?? 0) + 1);
    byPage.set(row.page_path, (byPage.get(row.page_path) ?? 0) + 1);
    pageTotals.set(row.page_path, (pageTotals.get(row.page_path) ?? 0) + 1);

    if (row.had_match) {
      matchedCount++;
      for (const sectionId of row.section_ids) {
        bySection.set(sectionId, (bySection.get(sectionId) ?? 0) + 1);
      }
    } else {
      pageNoMatch.set(row.page_path, (pageNoMatch.get(row.page_path) ?? 0) + 1);
    }

    if (row.feedback === "helpful") helpfulCount++;
    else if (row.feedback === "not_helpful") notHelpfulCount++;

    const dateKey = toIstDateKey(row.created_at);
    dailyCounts.set(dateKey, (dailyCounts.get(dateKey) ?? 0) + 1);
  }

  const total = rows.length;
  const ratedCount = helpfulCount + notHelpfulCount;

  const noMatchRateByPage = [...pageTotals.entries()]
    .filter(([, pageTotal]) => pageTotal >= minSampleForGaps)
    .map(([path, pageTotal]) => ({
      path,
      total: pageTotal,
      noMatchRate: Math.round(((pageNoMatch.get(path) ?? 0) / pageTotal) * 100),
    }))
    .sort((a, b) => b.noMatchRate - a.noMatchRate)
    .slice(0, topN);

  // Fill every day in the window, even ones with zero questions, so the
  // trend chart doesn't silently skip gaps.
  const dailyTrend: { date: string; count: number }[] = [];
  const today = opts.now ?? new Date();
  for (let i = opts.days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const key = toIstDateKey(d.toISOString());
    dailyTrend.push({ date: key, count: dailyCounts.get(key) ?? 0 });
  }

  return {
    totalQuestions: total,
    activeUsers: activeUserIds.size,
    matchRate: total > 0 ? Math.round((matchedCount / total) * 100) : 0,
    helpfulRate: ratedCount > 0 ? Math.round((helpfulCount / ratedCount) * 100) : 0,
    byRole: sortedCounts(byRole).map(([role, count]) => ({ role, count })),
    byPage: sortedCounts(byPage, topN).map(([path, count]) => ({ path, count })),
    bySection: sortedCounts(bySection, topN).map(([sectionId, count]) => ({
      sectionId,
      title: sectionTitleById.get(sectionId) ?? sectionId,
      count,
    })),
    feedback: { helpful: helpfulCount, notHelpful: notHelpfulCount, unrated: total - ratedCount },
    noMatchRateByPage,
    dailyTrend,
  };
}
