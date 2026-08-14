"use client";

import { useCallback, useEffect, useState } from "react";
import { ChevronDown, ChevronUp, Loader2, MessageCircleQuestion } from "lucide-react";
import { formatCurrency } from "@/lib/utils";
import { QueryThreadPanel } from "@/components/billing/query-thread-panel";
import type { BillingQueryListItem } from "@/lib/billing-queries";

type Tab = "awaiting_me" | "open" | "resolved";

const TABS: { key: Tab; label: string }[] = [
  { key: "awaiting_me", label: "Awaiting you" },
  { key: "open", label: "All open" },
  { key: "resolved", label: "Resolved" },
];

interface Stats {
  open: number;
  awaiting_you: number;
  resolved_this_week: number;
}

function timeAgo(iso: string): string {
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

export function BillingQueriesClient({ currentUserRole }: { currentUserRole: string }) {
  void currentUserRole; // reserved for role-specific affordances later
  const [tab, setTab] = useState<Tab>("awaiting_me");
  const [stats, setStats] = useState<Stats | null>(null);
  const [items, setItems] = useState<BillingQueryListItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const loadStats = useCallback(async () => {
    try {
      const res = await fetch("/api/billing-queries?stats=true", { cache: "no-store" });
      if (!res.ok) return;
      const json = (await res.json()) as { stats: Stats };
      setStats(json.stats);
    } catch {
      // Non-critical — stat cards just stay blank.
    }
  }, []);

  const loadFirstPage = useCallback(async (activeTab: Tab) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/billing-queries?tab=${activeTab}`, { cache: "no-store" });
      if (!res.ok) throw new Error();
      const json = (await res.json()) as { items: BillingQueryListItem[]; next_cursor: string | null };
      setItems(json.items);
      setNextCursor(json.next_cursor);
    } catch {
      setItems([]);
      setNextCursor(null);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadMore = useCallback(async () => {
    if (!nextCursor) return;
    setLoadingMore(true);
    try {
      const res = await fetch(`/api/billing-queries?tab=${tab}&cursor=${encodeURIComponent(nextCursor)}`, { cache: "no-store" });
      if (!res.ok) throw new Error();
      const json = (await res.json()) as { items: BillingQueryListItem[]; next_cursor: string | null };
      setItems((prev) => [...prev, ...json.items]);
      setNextCursor(json.next_cursor);
    } catch {
      // Leave the existing page in place — the button just stays visible to retry.
    } finally {
      setLoadingMore(false);
    }
  }, [tab, nextCursor]);

  useEffect(() => {
    void loadStats();
  }, [loadStats]);

  useEffect(() => {
    setExpandedId(null);
    void loadFirstPage(tab);
  }, [tab, loadFirstPage]);

  const refetchCurrent = useCallback(() => {
    void loadStats();
    void loadFirstPage(tab);
  }, [loadStats, loadFirstPage, tab]);

  return (
    <div>
      <div className="grid grid-cols-3 gap-3 mb-6">
        <StatCard label="Open" value={stats?.open} variant="danger" />
        <StatCard label="Awaiting you" value={stats?.awaiting_you} variant="warning" />
        <StatCard label="Resolved this week" value={stats?.resolved_this_week} />
      </div>

      <div className="flex gap-1 border-b mb-4">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={`px-3 py-2 text-sm border-b-2 -mb-px transition-colors ${
              tab === t.key ? "border-foreground font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground py-8 justify-center">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </div>
      ) : items.length === 0 ? (
        <div className="text-sm text-muted-foreground py-8 text-center border rounded-lg bg-muted/30">
          <MessageCircleQuestion className="h-5 w-5 mx-auto mb-2 opacity-50" />
          {tab === "awaiting_me" ? "Nothing waiting on you right now." : "No queries here."}
        </div>
      ) : (
        <div className="space-y-3">
          {items.map((item) => {
            const isOpen = expandedId === item.id;
            const isResolved = item.status === "resolved";
            return (
              <div key={item.id} className={`border rounded-lg p-3.5 ${isResolved ? "opacity-60" : ""}`}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span
                        className={`text-[11px] px-2 py-0.5 rounded-full border ${
                          isResolved ? "bg-green-50 border-green-200 text-green-700" : "bg-red-50 border-red-200 text-red-700"
                        }`}
                      >
                        {isResolved ? "Resolved" : "Open"}
                      </span>
                      <span className="font-medium text-sm">{item.statement.party_name}</span>
                      <span className="text-sm text-muted-foreground tabular-nums">{formatCurrency(item.statement.total_amount)}</span>
                    </div>
                    <div className="text-xs text-muted-foreground mt-0.5">
                      {item.statement.statement_number} · {item.statement.context_label} · asked by{" "}
                      <span className="font-medium">{item.created_by.full_name}</span> · {timeAgo(item.created_at)}
                    </div>
                    {!isOpen && item.last_message?.body && (
                      <p className="text-sm mt-2 line-clamp-2">{item.last_message.body}</p>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => setExpandedId(isOpen ? null : item.id)}
                    className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded border hover:bg-muted flex-shrink-0"
                  >
                    {isOpen ? "Close" : "Open thread"}
                    {isOpen ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                  </button>
                </div>

                {isOpen && (
                  <div className="mt-3 pt-3 border-t">
                    <QueryThreadPanel statementId={item.statement.id} initialQueryId={item.id} onChanged={refetchCurrent} />
                  </div>
                )}
              </div>
            );
          })}

          {nextCursor && (
            <div className="flex justify-center pt-2">
              <button
                type="button"
                onClick={loadMore}
                disabled={loadingMore}
                className="inline-flex items-center gap-1.5 text-sm px-4 py-2 rounded border hover:bg-muted disabled:opacity-50"
              >
                {loadingMore && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                Load more
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function StatCard({ label, value, variant }: { label: string; value: number | undefined; variant?: "danger" | "warning" }) {
  const valueClass = variant === "danger" ? "text-red-700" : variant === "warning" ? "text-amber-700" : "text-foreground";
  return (
    <div className="rounded-lg bg-muted/40 border p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={`text-2xl font-semibold mt-1 ${valueClass}`}>{value ?? "–"}</div>
    </div>
  );
}
