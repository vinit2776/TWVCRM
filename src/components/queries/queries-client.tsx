"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { BadgeCheck, CheckCircle2, ChevronDown, ChevronUp, Loader2, MessageCircleQuestion, Send } from "lucide-react";
import { formatCurrency } from "@/lib/utils";
import { USER_ROLE_LABELS } from "@/lib/constants";
import { QueryThreadPanel } from "@/components/queries/query-thread-panel";
import { queryEntityDef } from "@/lib/queries/registry";
import {
  QUERY_MODULE_LABELS,
  type QueryKind,
  type QueryListItem,
  type QueryModule,
  type QueryStats,
} from "@/lib/queries/types";

/**
 * /queries — every clarification thread in one place, whatever it hangs off.
 * Module chips filter; the entity type is a label, not a separate page.
 */

type Tab = "awaiting_me" | "mine" | "open" | "overdue" | "resolved";

const TABS: { key: Tab; label: string }[] = [
  { key: "awaiting_me", label: "Awaiting you" },
  { key: "mine", label: "Raised by me" },
  { key: "open", label: "All open" },
  { key: "overdue", label: "Overdue" },
  { key: "resolved", label: "Resolved" },
];

const MODULES = Object.keys(QUERY_MODULE_LABELS) as QueryModule[];

function timeAgo(iso: string): string {
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function daysOverdue(neededBy: string): number {
  const due = new Date(`${neededBy}T00:00:00`).getTime();
  return Math.floor((Date.now() - due) / 86_400_000);
}

/**
 * The accent border used to say only "this is awaiting you" — one color for
 * every reason, which told you nothing about how much work it actually is.
 * Recolor by why: red for "someone needs you to actually say something",
 * amber for a payment claim that needs a bank-statement check (same tone as
 * the "Payment reported" pill), blue for "you already have your answer, this
 * is a click, not a thought".
 *
 * Set via inline style, not a `border-l-{color}` utility class: this file
 * already pairs the per-side width/color with the all-sides `border`
 * utility, and Tailwind's own cascade layer ordering — not class order in
 * the attribute — decides which of two same-specificity border-color rules
 * wins. `border`'s shorthand color can end up after the per-side utility in
 * the generated stylesheet and silently overrides it. An inline style has no
 * such ordering to lose to.
 */
function reasonBorderColor(reason: QueryListItem["awaiting_reason"]): string | undefined {
  switch (reason) {
    case "needs_answer":
      return "#ef4444"; // red-500
    case "verify_payment":
      return "#f59e0b"; // amber-500
    case "awaiting_close":
      return "#3b82f6"; // blue-500
    default:
      return undefined;
  }
}

export function QueriesClient({ openQueryId }: { openQueryId?: string }) {
  // Arriving from a notification (?open=<id>) means "you were called about
  // this one". "Awaiting you" is the wrong landing tab for that — the linked
  // thread is very often not in it (you were told about a reply, or it was
  // just resolved), so the page would say "Nothing waiting on you right now"
  // while the thread you were sent to look at sat one tab over.
  const [tab, setTab] = useState<Tab>(openQueryId ? "open" : "awaiting_me");
  const [moduleFilter, setModuleFilter] = useState<QueryModule | null>(null);
  // Orthogonal to moduleFilter: "Payments reported" is a kind, not a module.
  // Selecting it clears the module chip, since a report's module is always
  // Contracts and the two filters would just fight each other.
  const [kindFilter, setKindFilter] = useState<QueryKind | null>(null);
  const [stats, setStats] = useState<QueryStats | null>(null);
  const [items, setItems] = useState<QueryListItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(openQueryId ?? null);

  const loadStats = useCallback(async () => {
    try {
      const res = await fetch("/api/queries?stats=true", { cache: "no-store" });
      if (!res.ok) return;
      setStats(((await res.json()) as { stats: QueryStats }).stats);
    } catch {
      // Stat cards just stay blank.
    }
  }, []);

  const buildUrl = useCallback(
    (activeTab: Tab, cursor?: string) => {
      const params = new URLSearchParams({ tab: activeTab });
      if (moduleFilter) params.set("module", moduleFilter);
      if (kindFilter) params.set("kind", kindFilter);
      if (cursor) params.set("cursor", cursor);
      return `/api/queries?${params.toString()}`;
    },
    [moduleFilter, kindFilter],
  );

  const loadFirstPage = useCallback(
    async (activeTab: Tab) => {
      setLoading(true);
      try {
        const res = await fetch(buildUrl(activeTab), { cache: "no-store" });
        if (!res.ok) throw new Error();
        const json = (await res.json()) as { items: QueryListItem[]; next_cursor: string | null };
        setItems(json.items);
        setNextCursor(json.next_cursor);
      } catch {
        setItems([]);
        setNextCursor(null);
      } finally {
        setLoading(false);
      }
    },
    [buildUrl],
  );

  const loadMore = useCallback(async () => {
    if (!nextCursor) return;
    setLoadingMore(true);
    try {
      const res = await fetch(buildUrl(tab, nextCursor), { cache: "no-store" });
      if (!res.ok) throw new Error();
      const json = (await res.json()) as { items: QueryListItem[]; next_cursor: string | null };
      setItems((prev) => [...prev, ...json.items]);
      setNextCursor(json.next_cursor);
    } catch {
      // Button stays visible to retry.
    } finally {
      setLoadingMore(false);
    }
  }, [buildUrl, tab, nextCursor]);

  useEffect(() => {
    void loadStats();
  }, [loadStats]);

  // A deep-linked thread that isn't open is a resolved one — fall through to
  // the Resolved tab rather than showing an empty list. Runs at most once, and
  // only before the reader has touched the tabs themselves, so it can never
  // yank the tab out from under someone browsing.
  const deepLinkFallbackDone = useRef(false);
  useEffect(() => {
    if (!openQueryId || deepLinkFallbackDone.current || loading) return;
    if (tab !== "open") return;
    if (items.some((i) => i.id === openQueryId)) {
      deepLinkFallbackDone.current = true;
      return;
    }
    deepLinkFallbackDone.current = true;
    setTab("resolved");
  }, [openQueryId, loading, items, tab]);

  useEffect(() => {
    void loadFirstPage(tab);
  }, [tab, loadFirstPage]);

  const refetch = useCallback(() => {
    void loadStats();
    void loadFirstPage(tab);
  }, [loadStats, loadFirstPage, tab]);

  return (
    <div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <StatCard label="Awaiting you" value={stats?.awaiting_you} tone="danger" />
        <StatCard label="Overdue" value={stats?.overdue} tone="warning" />
        <StatCard label="All open" value={stats?.open} />
        <StatCard label="Resolved this week" value={stats?.resolved_this_week} />
      </div>

      <div className="flex gap-1 border-b mb-3 overflow-x-auto">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => {
              setExpandedId(null);
              setTab(t.key);
            }}
            className={`px-3 py-2 text-sm border-b-2 -mb-px transition-colors whitespace-nowrap ${
              tab === t.key
                ? "border-foreground font-medium text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap gap-1.5 mb-4">
        <ModuleChip
          active={moduleFilter === null && kindFilter === null}
          onClick={() => { setModuleFilter(null); setKindFilter(null); }}
          label="All modules"
        />
        {MODULES.map((m) => (
          <ModuleChip
            key={m}
            active={moduleFilter === m}
            onClick={() => {
              setKindFilter(null);
              setModuleFilter(moduleFilter === m ? null : m);
            }}
            label={QUERY_MODULE_LABELS[m]}
          />
        ))}
        <ModuleChip
          active={kindFilter === "payment_reported"}
          onClick={() => {
            const next = kindFilter === "payment_reported" ? null : "payment_reported";
            setModuleFilter(null);
            setKindFilter(next);
            // "Awaiting you" excludes threads you spoke in last, which is
            // every report at the moment you file it — so filtering to
            // payment reports on that tab reliably showed nothing. Asking for
            // a kind means "show me these", not "these among what I owe".
            if (next) setTab("open");
          }}
          label="Payments reported"
        />
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
          {items.map((item) => (
            <QueryCard
              key={item.id}
              item={item}
              expanded={expandedId === item.id}
              onToggle={() => setExpandedId(expandedId === item.id ? null : item.id)}
              onChanged={refetch}
            />
          ))}

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

function QueryCard({
  item,
  expanded,
  onToggle,
  onChanged,
}: {
  item: QueryListItem;
  expanded: boolean;
  onToggle: () => void;
  onChanged: () => void;
}) {
  const def = queryEntityDef(item.entity_type);
  const isResolved = item.status === "resolved";
  const overdue = !isResolved && item.needed_by ? daysOverdue(item.needed_by) : 0;
  const borderColor = isResolved ? undefined : reasonBorderColor(item.awaiting_reason);

  // Bumped every time "Reply" is clicked, whether or not the panel was
  // already open — QueryThreadPanel watches this to focus its reply box, the
  // one action here that genuinely can't be done in a single click.
  const [replyFocusToken, setReplyFocusToken] = useState(0);
  const [resolving, setResolving] = useState(false);

  function jumpToReply() {
    if (!expanded) onToggle();
    setReplyFocusToken((t) => t + 1);
  }

  function jumpToVerify() {
    if (!expanded) onToggle();
  }

  // The one action of the three that IS a single click: "Reply & resolve"
  // already accepts an empty body, so closing a thread you already have your
  // answer on doesn't need the panel open at all.
  async function resolveDirectly() {
    setResolving(true);
    try {
      const res = await fetch(`/api/queries/${item.id}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resolve: true }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Could not resolve this query");
      toast.success("Resolved");
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not resolve this query");
    } finally {
      setResolving(false);
    }
  }

  const audienceText =
    item.audience === "users"
      ? item.awaiting_viewer
        ? "You"
        : `${item.audience_user_ids.length} person${item.audience_user_ids.length === 1 ? "" : "s"}`
      : item.audience === "roles"
        ? item.audience_roles.map((r) => USER_ROLE_LABELS[r] ?? r).join(", ")
        : "Anyone";

  return (
    <div
      className={`border rounded-lg p-3.5 ${isResolved ? "opacity-60" : ""}`}
      style={borderColor ? { borderLeftWidth: 3, borderLeftColor: borderColor } : undefined}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            {isResolved && item.kind === "payment_reported" ? (
              // "Resolved" alone would hide the only thing anyone wants to
              // know about a settled money claim: did the payment turn out to
              // be real? The outcome lives on the report row, so infer it
              // from the last timeline event, which is one of exactly two.
              item.last_message?.event_type === "payment_rejected" ? (
                <Pill tone="danger">No such payment</Pill>
              ) : (
                <Pill tone="good">Payment verified</Pill>
              )
            ) : isResolved ? (
              <Pill tone="good">Resolved</Pill>
            ) : item.kind === "payment_reported" ? (
              <Pill tone="warning">Payment reported</Pill>
            ) : item.kind === "action_needed" ? (
              <Pill tone="danger">Action needed</Pill>
            ) : (
              <Pill>Question</Pill>
            )}
            {overdue > 0 && <Pill tone="warning">Overdue · {overdue}d</Pill>}
            {!isResolved && <Pill tone="muted">→ {audienceText}</Pill>}
            <span className="font-medium text-sm">{item.entity?.title ?? "(transaction unavailable)"}</span>
            {item.kind === "payment_reported" ? (
              // The claim, never the contract value. Showing the entity's
              // amount here would put "₹59,000" on a card about a ₹100
              // payment, which is the number people would remember.
              item.reported_amount != null && (
                <span className="text-sm font-medium text-amber-800 tabular-nums">
                  {formatCurrency(item.reported_amount)} claimed
                </span>
              )
            ) : (
              item.entity?.amount != null && (
                <span className="text-sm text-muted-foreground tabular-nums">
                  {formatCurrency(item.entity.amount)}
                </span>
              )
            )}
          </div>
          <div className="text-xs text-muted-foreground mt-0.5">
            {def?.label}
            {item.entity?.reference ? ` · ${item.entity.reference}` : ""}
            {item.entity?.subtitle ? ` · ${item.entity.subtitle}` : ""} · raised by{" "}
            <span className="font-medium">{item.created_by.full_name}</span> · {timeAgo(item.created_at)}
          </div>
          {!expanded && item.last_message?.body && (
            <p className="text-sm mt-2 line-clamp-2">{item.last_message.body}</p>
          )}
        </div>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          {!isResolved && item.awaiting_reason === "needs_answer" && (
            <button
              type="button"
              onClick={jumpToReply}
              className="inline-flex items-center gap-1 text-xs px-2.5 py-1 rounded border border-red-600 bg-red-500 text-white hover:bg-red-600"
            >
              <Send className="h-3 w-3" />
              Reply
            </button>
          )}
          {!isResolved && item.awaiting_reason === "verify_payment" && (
            <button
              type="button"
              onClick={jumpToVerify}
              className="inline-flex items-center gap-1 text-xs px-2.5 py-1 rounded border border-amber-600 bg-amber-500 text-white hover:bg-amber-600"
            >
              <BadgeCheck className="h-3 w-3" />
              Verify payment
            </button>
          )}
          {!isResolved && item.awaiting_reason === "awaiting_close" && (
            <button
              type="button"
              onClick={resolveDirectly}
              disabled={resolving}
              className="inline-flex items-center gap-1 text-xs px-2.5 py-1 rounded border border-blue-600 bg-blue-500 text-white hover:bg-blue-600 disabled:opacity-50"
            >
              {resolving ? <Loader2 className="h-3 w-3 animate-spin" /> : <CheckCircle2 className="h-3 w-3" />}
              Resolve
            </button>
          )}
          <button
            type="button"
            onClick={onToggle}
            className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded border hover:bg-muted"
          >
            {expanded ? "Close" : "Open thread"}
            {expanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
          </button>
        </div>
      </div>

      {expanded && (
        <div className="mt-3 pt-3 border-t">
          <QueryThreadPanel
            entityType={item.entity_type}
            entityId={item.entity_id}
            initialQueryId={item.id}
            onChanged={onChanged}
            focusReplyToken={replyFocusToken}
          />
        </div>
      )}
    </div>
  );
}

function Pill({
  children,
  tone,
}: {
  children: React.ReactNode;
  tone?: "good" | "danger" | "warning" | "muted";
}) {
  const cls =
    tone === "good"
      ? "bg-green-50 border-green-200 text-green-700"
      : tone === "danger"
        ? "bg-red-50 border-red-200 text-red-700"
        : tone === "warning"
          ? "bg-amber-50 border-amber-200 text-amber-800"
          : tone === "muted"
            ? "bg-muted border-transparent text-muted-foreground"
            : "bg-muted/60 border-transparent text-muted-foreground";
  return <span className={`text-[11px] px-2 py-0.5 rounded-full border ${cls}`}>{children}</span>;
}

function ModuleChip({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`text-xs px-2.5 py-1 rounded-md border transition-colors ${
        active ? "bg-foreground text-background border-foreground" : "text-muted-foreground hover:bg-muted"
      }`}
    >
      {label}
    </button>
  );
}

function StatCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: number | undefined;
  tone?: "danger" | "warning";
}) {
  const valueClass =
    tone === "danger" ? "text-red-700" : tone === "warning" ? "text-amber-700" : "text-foreground";
  return (
    <div className="rounded-lg bg-muted/40 border p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={`text-2xl font-semibold mt-1 ${valueClass}`}>{value ?? "–"}</div>
    </div>
  );
}
