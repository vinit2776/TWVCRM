"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import {
  ArrowDownLeft,
  ArrowUpRight,
  Inbox,
  Loader2,
  MessageCircle,
} from "lucide-react";
import { Card } from "@/components/ui/card";
import { formatCurrency } from "@/lib/utils";
import { timeAgo } from "@/lib/facility-ui";
import type { BookingInboxRow, InboxRow, InboxStats } from "@/lib/tally-handoff";
import type { QueryListItem, QueryStats } from "@/lib/queries/types";

/**
 * The accounts dashboard, in four cards.
 *
 * Accounts is a queue-driven role, not a reporting one — the day is "what is
 * waiting on me" (queries, Tally handoffs) and "where does the money stand"
 * (outstanding, payables). Everything here is one of those two questions;
 * MTD/ROI reporting deliberately lives elsewhere.
 *
 * "New" everywhere means arrived in the last 24 hours. It is a rolling clock,
 * not a read receipt: the badge clears because the item aged past a day, not
 * because anyone looked at it.
 */

interface Bucket {
  count: number;
  total: number;
}

interface AgingSide {
  total: number;
  count: number;
  current: Bucket;
  d_0_30: Bucket;
  d_31_60: Bucket;
  d_60_plus: Bucket;
  new_24h?: Bucket;
}

interface CashAging {
  receivables: AgingSide;
  payables: AgingSide;
}

function NewBadge({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <span className="rounded-md bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-900 border border-amber-200">
      {count} new
    </span>
  );
}

function CardShell({
  icon,
  title,
  badge,
  href,
  linkLabel,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  badge?: React.ReactNode;
  href: string;
  linkLabel: string;
  children: React.ReactNode;
}) {
  return (
    <Card className="flex flex-col p-4">
      <div className="mb-3 flex items-center gap-2">
        {icon}
        <span className="text-base font-semibold">{title}</span>
        <span className="ml-auto">{badge}</span>
      </div>
      <div className="flex-1">{children}</div>
      <Link
        href={href}
        className="mt-3 text-xs font-medium text-primary hover:underline underline-offset-2"
      >
        {linkLabel} →
      </Link>
    </Card>
  );
}

/** Label/value line. `tone` colours the value when it represents a problem. */
function StatRow({
  label,
  value,
  tone,
  badge,
}: {
  label: string;
  value: string | number;
  tone?: "danger" | "muted";
  badge?: React.ReactNode;
}) {
  const valueColor =
    tone === "danger"
      ? "text-red-600"
      : tone === "muted"
        ? "text-muted-foreground"
        : "";
  return (
    <div className="flex items-center justify-between py-1 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="flex items-center gap-1.5">
        {badge}
        <span className={`font-medium ${valueColor}`}>{value}</span>
      </span>
    </div>
  );
}

/** Current vs aged split, as a single bar. Renders nothing at zero total. */
function AgingBar({ current, aged }: { current: number; aged: number }) {
  const total = current + aged;
  if (total <= 0) return null;
  const currentPct = (current / total) * 100;
  return (
    <div className="mb-3 flex h-2 overflow-hidden rounded-full bg-muted">
      <div className="bg-emerald-400" style={{ width: `${currentPct}%` }} />
      <div className="bg-amber-500" style={{ width: `${100 - currentPct}%` }} />
    </div>
  );
}

function BucketGrid({ side }: { side: AgingSide }) {
  const buckets: { label: string; bucket: Bucket }[] = [
    { label: "Current", bucket: side.current },
    { label: "0–30d", bucket: side.d_0_30 },
    { label: "31–60d", bucket: side.d_31_60 },
    { label: "60+ days", bucket: side.d_60_plus },
  ];
  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-1 border-t pt-2">
      {buckets.map(({ label, bucket }) => (
        <StatRow
          key={label}
          label={label}
          value={formatCurrency(bucket.total)}
          tone={bucket.total === 0 ? "muted" : undefined}
        />
      ))}
    </div>
  );
}

/**
 * The three most recently touched items in a queue, newest first. Counts say
 * how much is waiting; this says whether anything actually moved — a card
 * reading "12 open, last update 6d ago" is a very different morning from
 * "12 open, last update 4m ago".
 */
function RecentList({ items }: { items: { key: string; label: string; at: string }[] }) {
  if (items.length === 0) return null;
  return (
    <div className="mt-2 border-t pt-2">
      <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        Last updated
      </p>
      {items.map((item) => (
        <div key={item.key} className="flex items-center justify-between gap-2 py-0.5 text-xs">
          <span className="truncate text-muted-foreground">{item.label}</span>
          <span className="shrink-0 tabular-nums text-muted-foreground">{timeAgo(item.at)}</span>
        </div>
      ))}
    </div>
  );
}

function LoadingCard() {
  return (
    <Card className="flex items-center justify-center p-4 min-h-[180px]">
      <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
    </Card>
  );
}

const RECENT_LIMIT = 3;

/** Statement and booking handoffs share one recency list, newest state change first. */
function inboxRecent(rows: InboxRow[], bookingRows: BookingInboxRow[]) {
  const statements = rows.map((r) => ({
    key: `s:${r.statement_id}`,
    label:
      r.statement_number ??
      r.contract?.lead?.company ??
      r.contract?.contract_number ??
      "Statement",
    at: r.state_changed_at,
  }));
  const bookings = bookingRows
    .filter((b) => b.handoff_state !== "complete")
    .map((b) => ({
      key: `b:${b.task_id}`,
      label: b.customer_name ?? "Booking",
      at: b.state_changed_at,
    }));
  return [...statements, ...bookings]
    .filter((x) => !!x.at)
    .sort((a, b) => (a.at < b.at ? 1 : -1))
    .slice(0, RECENT_LIMIT);
}

export function AccountsOverviewWidget() {
  const [queries, setQueries] = useState<QueryStats | null>(null);
  const [recentQueries, setRecentQueries] = useState<QueryListItem[]>([]);
  const [inbox, setInbox] = useState<InboxStats | null>(null);
  const [recentInbox, setRecentInbox] = useState<{ key: string; label: string; at: string }[]>([]);
  const [aging, setAging] = useState<CashAging | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Each card fails independently — a 403 on one endpoint should not blank
    // the other three.
    const get = async <T,>(url: string, pick: (json: unknown) => T | null) => {
      try {
        const res = await fetch(url);
        if (!res.ok) return null;
        return pick(await res.json());
      } catch {
        return null;
      }
    };

    Promise.all([
      get<QueryStats>("/api/queries?stats=true", (j) => (j as { stats?: QueryStats }).stats ?? null),
      // Open threads come back already sorted updated_at desc, so the head of
      // the page is the recent-activity list — no extra sort needed.
      get<QueryListItem[]>("/api/queries?tab=open", (j) => (j as { items?: QueryListItem[] }).items ?? null),
      get<{ stats: InboxStats; rows: InboxRow[]; booking_rows: BookingInboxRow[] }>(
        "/api/accounting/inbox",
        (j) => j as { stats: InboxStats; rows: InboxRow[]; booking_rows: BookingInboxRow[] },
      ),
      get<CashAging>("/api/dashboard/cash-aging", (j) => (j as { data?: CashAging }).data ?? null),
    ])
      .then(([q, qItems, i, a]) => {
        setQueries(q);
        setRecentQueries((qItems ?? []).slice(0, RECENT_LIMIT));
        setInbox(i?.stats ?? null);
        setRecentInbox(inboxRecent(i?.rows ?? [], i?.booking_rows ?? []));
        setAging(a);
      })
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="grid gap-4 md:grid-cols-2">
        {[0, 1, 2, 3].map((i) => (
          <LoadingCard key={i} />
        ))}
      </div>
    );
  }

  const receivables = aging?.receivables;
  const payables = aging?.payables;
  const agedReceivable = receivables
    ? receivables.total - receivables.current.total
    : 0;

  return (
    <div className="grid gap-4 md:grid-cols-2">
      {/* 1 — Queries */}
      <CardShell
        icon={<MessageCircle className="h-4 w-4 text-blue-600" />}
        title="Queries"
        badge={<NewBadge count={queries?.new_24h ?? 0} />}
        href="/queries"
        linkLabel="Open queries"
      >
        <div className="mb-3 flex items-baseline gap-2">
          <span className="text-2xl font-bold">{queries?.open ?? 0}</span>
          <span className="text-xs text-muted-foreground">open threads</span>
        </div>
        <div className="border-t pt-2">
          <StatRow label="Awaiting your reply" value={queries?.awaiting_you ?? 0} />
          <StatRow
            label="Past needed-by date"
            value={queries?.overdue ?? 0}
            tone={(queries?.overdue ?? 0) > 0 ? "danger" : "muted"}
          />
          <StatRow
            label="Resolved this week"
            value={queries?.resolved_this_week ?? 0}
            tone="muted"
          />
        </div>
        <RecentList
          items={recentQueries.map((q) => ({
            key: q.id,
            label: q.entity?.title ?? "Thread",
            at: q.updated_at,
          }))}
        />
      </CardShell>

      {/* 2 — Tally inbox */}
      <CardShell
        icon={<Inbox className="h-4 w-4 text-violet-600" />}
        title="Tally inbox"
        badge={<NewBadge count={inbox?.new_24h ?? 0} />}
        href="/accounting/inbox"
        linkLabel="Open inbox"
      >
        <div className="mb-3 flex items-baseline gap-2">
          <span className="text-2xl font-bold">{inbox?.total_open ?? 0}</span>
          <span className="text-xs text-muted-foreground">open handoffs</span>
        </div>
        <div className="border-t pt-2">
          <StatRow label="GST to issue" value={inbox?.gst_to_issue ?? 0} />
          <StatRow label="Payments to record" value={inbox?.payments_to_record ?? 0} />
          <StatRow
            label="Discrepancies"
            value={inbox?.discrepancies ?? 0}
            tone={(inbox?.discrepancies ?? 0) > 0 ? "danger" : "muted"}
          />
          <StatRow
            label="Aging over 48h"
            value={inbox?.aging_over_48h ?? 0}
            tone={(inbox?.aging_over_48h ?? 0) > 0 ? "danger" : "muted"}
          />
        </div>
        <RecentList items={recentInbox} />
      </CardShell>

      {/* 3 — Total outstanding */}
      <CardShell
        icon={<ArrowDownLeft className="h-4 w-4 text-emerald-600" />}
        title="Total outstanding"
        badge={
          <span className="text-xs text-muted-foreground">
            {receivables?.count ?? 0} statements
          </span>
        }
        href="/accounting/receivables"
        linkLabel="Open receivables"
      >
        <div className="mb-1 text-2xl font-bold text-emerald-700">
          {formatCurrency(receivables?.total ?? 0)}
        </div>
        <p className="mb-3 text-xs">
          <span className={agedReceivable > 0 ? "text-red-600" : "text-muted-foreground"}>
            {formatCurrency(agedReceivable)} aged
          </span>
          <span className="text-muted-foreground">
            {" "}
            · {formatCurrency(receivables?.current.total ?? 0)} current
          </span>
        </p>
        {receivables && (
          <>
            <AgingBar current={receivables.current.total} aged={agedReceivable} />
            <BucketGrid side={receivables} />
          </>
        )}
      </CardShell>

      {/* 4 — Payables */}
      <CardShell
        icon={<ArrowUpRight className="h-4 w-4 text-orange-600" />}
        title="Payables"
        badge={<NewBadge count={payables?.new_24h?.count ?? 0} />}
        href="/accounting"
        linkLabel="Open acc payables"
      >
        <div className="mb-1 text-2xl font-bold text-orange-700">
          {formatCurrency(payables?.total ?? 0)}
        </div>
        <p className="mb-3 text-xs text-muted-foreground">
          {payables?.count ?? 0} bills awaiting payment
          {(payables?.new_24h?.count ?? 0) > 0 && (
            <> · {formatCurrency(payables!.new_24h!.total)} new</>
          )}
        </p>
        {payables && (
          <>
            <AgingBar
              current={payables.current.total}
              aged={payables.total - payables.current.total}
            />
            <BucketGrid side={payables} />
          </>
        )}
      </CardShell>
    </div>
  );
}
