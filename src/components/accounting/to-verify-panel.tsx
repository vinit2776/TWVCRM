"use client";

import { useCallback, useEffect, useState } from "react";
import { ChevronRight, Loader2 } from "lucide-react";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { QUERIES_CHANGED_EVENT } from "@/hooks/use-sidebar-badges";
import { QueryThreadPanel } from "@/components/queries/query-thread-panel";
import { formatCurrency, formatDate } from "@/lib/utils";
import { STATEMENT_PAYMENT_MODE_LABELS } from "@/lib/constants";
import { lastCheckedChip, type LastCheckedTone } from "@/lib/queries/payment-reports";
import type { QueryListItem } from "@/lib/queries/types";

/**
 * Tally Inbox → "To verify": payment reports accounts haven't settled yet.
 *
 * A read-only window over the same threads that live on /queries
 * (kind = payment_reported, status = open). Nothing here owns state — the
 * drawer embeds the ordinary QueryThreadPanel, whose PaymentReportCard already
 * does the allocate → record → verify chain through the one Record Payment
 * dialog. Duplicating that here would be a second way for money to enter the
 * ledger, which is exactly what the report flow was built to avoid.
 *
 * A report drops off this list the moment it is verified or rejected. "Not
 * found yet" deliberately leaves it here: the claim is still unresolved.
 */

interface Props {
  /** Fires after any outcome so the tab count and sidebar badge can refresh. */
  onChanged?: () => void;
  /** The inbox search box. /api/queries has no text search, so this filters the loaded rows. */
  search?: string;
}

function daysWaiting(createdAt: string): number {
  return Math.max(0, Math.floor((Date.now() - new Date(createdAt).getTime()) / 86_400_000));
}

function waitingLabel(days: number): string {
  return days === 0 ? "today" : days === 1 ? "1 day" : `${days} days`;
}

const CHECKED_CHIP_CLASS: Record<LastCheckedTone, string> = {
  never: "border-dashed text-muted-foreground",
  fresh: "bg-green-50 border-green-200 text-green-800",
  stale: "bg-muted text-muted-foreground",
};

export function ToVerifyPanel({ onChanged, search = "" }: Props) {
  const [items, setItems] = useState<QueryListItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A snapshot, not an id looked up in `items`: settling a report removes it
  // from the list, and the drawer should stay put showing the outcome rather
  // than losing the thread it is rendering.
  const [opened, setOpened] = useState<QueryListItem | null>(null);

  const url = useCallback((cursor?: string | null) => {
    const params = new URLSearchParams({ tab: "open", kind: "payment_reported" });
    if (cursor) params.set("cursor", cursor);
    return `/api/queries?${params.toString()}`;
  }, []);

  const loadFirstPage = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(url(), { cache: "no-store" });
      if (!res.ok) throw new Error();
      const json = (await res.json()) as { items: QueryListItem[]; next_cursor: string | null };
      // The list is ordered by recency; the oldest claim is the one most at
      // risk of going cold, so surface it first.
      setItems([...json.items].sort((a, b) => a.created_at.localeCompare(b.created_at)));
      setNextCursor(json.next_cursor);
    } catch {
      setError("Could not load reported payments.");
    } finally {
      setLoading(false);
    }
  }, [url]);

  useEffect(() => {
    void loadFirstPage();
  }, [loadFirstPage]);

  const loadMore = useCallback(async () => {
    if (!nextCursor) return;
    setLoadingMore(true);
    try {
      const res = await fetch(url(nextCursor), { cache: "no-store" });
      if (!res.ok) throw new Error();
      const json = (await res.json()) as { items: QueryListItem[]; next_cursor: string | null };
      setItems((prev) => [...prev, ...json.items]);
      setNextCursor(json.next_cursor);
    } catch {
      // The button stays so it can be retried.
    } finally {
      setLoadingMore(false);
    }
  }, [url, nextCursor]);

  const handleChanged = useCallback(() => {
    void loadFirstPage();
    onChanged?.();
    window.dispatchEvent(new Event(QUERIES_CHANGED_EVENT));
  }, [loadFirstPage, onChanged]);

  const today = new Date().toISOString().slice(0, 10);

  const needle = search.trim().toLowerCase();
  const visibleItems = needle
    ? items.filter((item) =>
        [
          item.entity?.title,
          item.entity?.reference,
          item.entity?.subtitle,
          item.created_by.full_name,
          item.reported_payment?.payment_reference,
          item.reported_amount != null ? String(item.reported_amount) : null,
        ].some((v) => v?.toLowerCase().includes(needle)),
      )
    : items;

  if (loading && items.length === 0) {
    return (
      <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
        Loading reported payments…
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-900">{error}</div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
        Nothing to verify. Reported payments waiting on a bank check will show up here.
      </div>
    );
  }

  if (visibleItems.length === 0) {
    return (
      <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
        No reported payments match “{search.trim()}”.
      </div>
    );
  }

  return (
    <>
      <div className="rounded-lg border divide-y">
        <div className="hidden md:grid grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)_minmax(0,1fr)_24px] gap-3 px-3 py-2 text-[11px] text-muted-foreground">
          <span>Customer / reference</span>
          <span>Reported payment</span>
          <span>Reported by</span>
          <span />
        </div>
        {visibleItems.map((item) => {
          const days = daysWaiting(item.created_at);
          const overdue = !!item.needed_by && item.needed_by < today;
          const checked = lastCheckedChip(item.last_checked_at, Date.now());
          const modeLabel = item.reported_payment
            ? (STATEMENT_PAYMENT_MODE_LABELS[item.reported_payment.payment_mode] ??
              item.reported_payment.payment_mode)
            : null;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => setOpened(item)}
              className="w-full text-left grid grid-cols-1 md:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)_minmax(0,1fr)_24px] gap-1 md:gap-3 items-center px-3 py-2.5 text-sm hover:bg-muted/50 transition-colors"
            >
              <span className="min-w-0">
                <span className="block truncate font-medium">{item.entity?.title ?? "Transaction no longer available"}</span>
                <span className="block truncate text-xs text-muted-foreground">
                  {[item.entity?.reference, item.entity?.subtitle].filter(Boolean).join(" · ")}
                </span>
              </span>
              <span className="min-w-0">
                <span className="block tabular-nums">
                  {item.reported_amount != null ? formatCurrency(item.reported_amount) : "—"}
                  {modeLabel && <span className="text-muted-foreground"> · {modeLabel}</span>}
                </span>
                <span className="block truncate text-xs text-muted-foreground">
                  {item.reported_payment?.payment_reference
                    ? `Ref ${item.reported_payment.payment_reference}`
                    : "No reference given"}
                  {item.reported_payment && ` · paid ${formatDate(item.reported_payment.paid_on)}`}
                </span>
              </span>
              <span className="min-w-0">
                <span className="block truncate">{item.created_by.full_name}</span>
                <span className="flex flex-wrap gap-1 mt-0.5">
                  <span
                    className={`text-[11px] px-2 py-0.5 rounded-full border ${
                      overdue
                        ? "bg-red-50 border-red-200 text-red-800"
                        : "bg-amber-50 border-amber-200 text-amber-800"
                    }`}
                  >
                    waiting {waitingLabel(days)}
                  </span>
                  <span className={`text-[11px] px-2 py-0.5 rounded-full border ${CHECKED_CHIP_CLASS[checked.tone]}`}>
                    {checked.label}
                  </span>
                </span>
              </span>
              <ChevronRight className="hidden md:block h-4 w-4 text-muted-foreground" aria-hidden />
            </button>
          );
        })}
      </div>

      {nextCursor && (
        <div className="flex justify-center">
          <button
            type="button"
            onClick={() => void loadMore()}
            disabled={loadingMore}
            className="text-xs rounded-md border px-3 py-1.5 hover:bg-muted transition-colors disabled:opacity-50 inline-flex items-center gap-1.5"
          >
            {loadingMore && <Loader2 className="h-3 w-3 animate-spin" />}
            Load more
          </button>
        </div>
      )}

      <Sheet open={!!opened} onOpenChange={(o) => { if (!o) setOpened(null); }}>
        <SheetContent side="right" className="w-full sm:max-w-md overflow-y-auto p-4">
          <SheetHeader className="mb-3">
            <SheetTitle className="text-base">{opened?.entity?.title ?? "Reported payment"}</SheetTitle>
            <p className="text-xs text-muted-foreground">
              Check the bank statement, then verify and record, or tell the reporter it isn&apos;t there yet.
            </p>
          </SheetHeader>
          {opened && (
            <QueryThreadPanel
              // Remount per report so a stale thread never flashes while the next loads.
              key={opened.id}
              entityType={opened.entity_type}
              entityId={opened.entity_id}
              initialQueryId={opened.id}
              onChanged={handleChanged}
            />
          )}
        </SheetContent>
      </Sheet>
    </>
  );
}
