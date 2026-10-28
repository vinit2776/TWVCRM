"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Loader2 } from "lucide-react";
import { useCurrentUser } from "@/providers/current-user-provider";
import { formatCurrency } from "@/lib/utils";
import { isInboxRole, type BookingInboxRow, type InboxRow } from "@/lib/tally-handoff";
import { canReviewPaymentReport } from "@/lib/queries/payment-reports";
import type { QueryListItem } from "@/lib/queries/types";
import {
  QUEUE_TYPES,
  QUEUE_TYPE_ORDER,
  ageDaysUrgency,
  countUrgency,
  dueDateUrgency,
  inboxUrgency,
  sortQueue,
  tdsDueDate,
  tdsUrgency,
  todayIST,
  PETTY_CASH_OVERDUE_DAYS,
  type QueueItem,
  type QueueType,
} from "@/lib/accounts-queue";

/**
 * The accounts desk: one colour-coded queue of everything waiting on accounts,
 * most late first, each row opening the item it is about.
 *
 * It composes endpoints that already exist rather than adding a new one, so the
 * lateness rules stay the inbox's and the queries module's own. Each source
 * fails independently — a failed tile says so and keeps its retry, the rest of
 * the desk still works. A source this role can't use is left out, not failed.
 */

type Source = "inbox" | "queries" | "bills" | "petty" | "tds";
const SOURCE_OF: Record<QueueType, Source> = {
  inv: "inbox",
  pay: "queries",
  qry: "queries",
  ven: "bills",
  pet: "petty",
  tds: "tds",
};

/** Rows shown before "Show all": the queue is a to-do list, not a report. */
const VISIBLE_ROWS = 8;
const BUCKET_LABEL: Record<string, string> = {
  gst_to_issue: "GST invoice to issue",
  payment_to_record: "Payment to record",
  discrepancy: "Discrepancy to resolve",
};
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`${url} ${res.status}`);
  return (await res.json()) as T;
}

interface SourceResult {
  items: Partial<Record<QueueType, QueueItem[]>>;
  /** Types whose first page was full, so the count is "N or more". */
  more?: QueueType[];
  waiting?: number;
}

async function loadInbox(): Promise<SourceResult> {
  const json = await getJson<{ rows: InboxRow[]; booking_rows?: BookingInboxRow[] }>("/api/accounting/inbox");
  const items: QueueItem[] = [];
  for (const r of json.rows) {
    // in_flight is waiting on someone else; held and voided statements are paused or gone.
    if (r.bucket === "in_flight" || r.bucket === "complete" || r.is_voided || r.is_held) continue;
    items.push({
      key: `s:${r.statement_id}`,
      type: "inv",
      title: r.contract?.lead?.company ?? r.contract?.contract_number ?? r.statement_number ?? "Statement",
      subtitle: `${r.statement_number ?? "Statement"} · ${formatCurrency(r.statement_total_amount)} · ${BUCKET_LABEL[r.bucket] ?? "Needs action"}`,
      href: `/accounting/inbox?open=${r.statement_id}`,
      ...inboxUrgency(r.aging_hours),
    });
  }
  for (const b of json.booking_rows ?? []) {
    if (b.bucket === "in_flight" || b.bucket === "complete") continue;
    items.push({
      key: `b:${b.task_id}`,
      type: "inv",
      title: b.customer_name ?? "Booking",
      subtitle: `${b.booking_number ?? "Booking"} · ${formatCurrency(b.statement_total_amount)} · ${BUCKET_LABEL[b.bucket] ?? "Needs action"}`,
      href: `/accounting/inbox?open=${b.task_id}`,
      ...inboxUrgency(b.aging_hours),
    });
  }
  return { items: { inv: items } };
}

async function loadQueries(role: string, today: string): Promise<SourceResult> {
  // One awaiting_me page holds both payment reports to verify and ordinary
  // queries; the reason on each thread splits them.
  const [mine, waitingOn] = await Promise.all([
    getJson<{ items: QueryListItem[]; next_cursor: string | null }>("/api/queries?tab=awaiting_me"),
    getJson<{ items: QueryListItem[]; next_cursor: string | null }>("/api/queries?tab=mine"),
  ]);
  const pay: QueueItem[] = [];
  const qry: QueueItem[] = [];
  for (const q of mine.items) {
    if (!q.awaiting_viewer) continue;
    const base = {
      key: q.id,
      title: q.entity?.title ?? "Transaction no longer available",
      href: `/queries?open=${q.id}`,
      ...dueDateUrgency(q.needed_by, today),
    };
    if (q.awaiting_reason === "verify_payment") {
      if (!canReviewPaymentReport(role)) continue;
      pay.push({
        ...base,
        type: "pay",
        subtitle: `${q.reported_amount != null ? formatCurrency(q.reported_amount) : "Payment"} · check against bank`,
      });
    } else {
      qry.push({
        ...base,
        type: "qry",
        subtitle: q.awaiting_reason === "awaiting_close" ? "Answered · close it" : "Needs your reply",
      });
    }
  }
  return {
    items: { pay, qry },
    more: mine.next_cursor ? ["pay", "qry"] : [],
    waiting: waitingOn.items.filter((q) => !q.awaiting_viewer).length,
  };
}

interface BillRow {
  id: string;
  bill_number: string;
  total_amount: number;
  due_date: string | null;
  payment_batch_date: string | null;
  procurement_vendors: { name: string } | null;
}

async function loadBills(today: string): Promise<SourceResult> {
  // The filter is a single equality, so unpaid and part-paid are two calls.
  const [unpaid, partial] = await Promise.all(
    ["unpaid", "partially_paid"].map((s) =>
      getJson<{ data: BillRow[] }>(`/api/procurement/bills?approval_status=approved&payment_status=${s}&limit=100`),
    ),
  );
  const items: QueueItem[] = [];
  for (const b of [...unpaid.data, ...partial.data]) {
    // Earliest of due date and the payment run it was batched into. A bill with
    // neither is approved and simply waiting for accounts to pay it.
    const dates = [b.due_date, b.payment_batch_date].filter((d): d is string => !!d);
    const when = dates.length > 0 ? dates.sort()[0] : null;
    if (when && when > today) continue;
    items.push({
      key: b.id,
      type: "ven",
      title: b.procurement_vendors?.name ?? "Vendor",
      subtitle: `${b.bill_number} · ${formatCurrency(b.total_amount)}`,
      href: `/accounting/vendor-payments/${b.id}`,
      ...dueDateUrgency(when, today),
    });
  }
  return { items: { ven: items } };
}

async function loadPetty(today: string): Promise<SourceResult> {
  const json = await getJson<{
    data: { id: string; entry_number: string; amount: number; description: string; created_at: string }[];
  }>("/api/petty-cash/entries?status=pending_admin&limit=50");
  return {
    items: {
      pet: json.data.map((e) => ({
        key: e.id,
        type: "pet" as const,
        title: e.description,
        subtitle: `${e.entry_number} · ${formatCurrency(e.amount)} · needs second approval`,
        href: "/petty-cash",
        ...ageDaysUrgency(e.created_at, today, PETTY_CASH_OVERDUE_DAYS),
      })),
    },
  };
}

async function loadTds(today: string): Promise<SourceResult> {
  const json = await getJson<{ data: { period_month: number; period_year: number; tds_amount: number }[] }>(
    "/api/tds/payable?status=pending",
  );
  const months = new Map<string, { month: number; year: number; total: number }>();
  for (const r of json.data) {
    const key = `${r.period_year}-${r.period_month}`;
    const m = months.get(key) ?? { month: r.period_month, year: r.period_year, total: 0 };
    m.total += r.tds_amount ?? 0;
    months.set(key, m);
  }
  const items: QueueItem[] = [];
  for (const m of months.values()) {
    const u = tdsUrgency(m.month, m.year, today);
    if (!u) continue;
    const due = tdsDueDate(m.month, m.year);
    items.push({
      key: `tds:${m.year}-${m.month}`,
      type: "tds",
      title: `TDS for ${MONTHS[m.month - 1]} ${m.year}`,
      subtitle: `Due ${Number(due.slice(8))} ${MONTHS[Number(due.slice(5, 7)) - 1]} · ${formatCurrency(m.total)}`,
      href: "/accounting/tds",
      urgency: u.urgency,
      daysLate: u.daysLate,
      chip: u.urgency === "today" ? (u.daysLeft === 0 ? "due today" : `${u.daysLeft}d left`) : undefined,
    });
  }
  return { items: { tds: items } };
}

function Chip({ item }: { item: QueueItem }) {
  const cls =
    item.urgency === "overdue" && !item.chip
      ? item.daysLate >= 3
        ? "bg-red-100 text-red-800"
        : "bg-amber-100 text-amber-900"
      : item.urgency === "overdue"
        ? "bg-red-100 text-red-800"
        : "bg-muted text-muted-foreground";
  const label = item.chip ?? (item.urgency === "overdue" ? `${item.daysLate}d late` : "today");
  return <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] ${cls}`}>{label}</span>;
}

export function AccountsWorkQueueWidget() {
  const { user } = useCurrentUser();
  const role = user?.role ?? "";
  const [data, setData] = useState<Partial<Record<QueueType, QueueItem[]>>>({});
  const [failed, setFailed] = useState<Set<Source>>(new Set());
  const [more, setMore] = useState<Set<QueueType>>(new Set());
  const [waiting, setWaiting] = useState<number | null>(null);
  const [pending, setPending] = useState(true);
  const [selected, setSelected] = useState<QueueType | null>(null);
  const [showAll, setShowAll] = useState(false);

  const loadSource = useCallback(
    async (source: Source) => {
      const today = todayIST();
      try {
        const result =
          source === "inbox"
            ? isInboxRole(role) ? await loadInbox() : { items: {} }
            : source === "queries"
              ? await loadQueries(role, today)
              : source === "bills"
                ? await loadBills(today)
                : source === "petty"
                  ? await loadPetty(today)
                  : await loadTds(today);
        setData((prev) => ({ ...prev, ...result.items }));
        if (result.more) setMore((prev) => new Set([...prev, ...result.more!]));
        if (result.waiting != null) setWaiting(result.waiting);
        setFailed((prev) => {
          const next = new Set(prev);
          next.delete(source);
          return next;
        });
      } catch {
        setFailed((prev) => new Set(prev).add(source));
      }
    },
    [role],
  );

  useEffect(() => {
    if (!role) return;
    const sources: Source[] = ["inbox", "queries", "bills", "petty", "tds"];
    setPending(true);
    void Promise.all(sources.map(loadSource)).finally(() => setPending(false));
  }, [role, loadSource]);

  const all = useMemo(
    () => sortQueue(QUEUE_TYPE_ORDER.flatMap((t) => data[t] ?? [])),
    [data],
  );
  const totals = countUrgency(all);
  const rows = selected ? all.filter((i) => i.type === selected) : all;
  const shown = showAll || selected ? rows : rows.slice(0, VISIBLE_ROWS);
  const firstName = user?.full_name?.split(" ")[0];

  if (pending && all.length === 0) {
    return (
      <div className="flex min-h-[220px] items-center justify-center rounded-xl border bg-card">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">{firstName ? `Hello, ${firstName}` : "Accounts desk"}</h2>
        <p className="text-xs text-muted-foreground">
          Everything waiting on accounts, most late first. Each row opens the item.
        </p>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <div className={`rounded-xl border p-3 ${totals.overdue > 0 ? "border-red-300" : ""}`}>
          <p className="text-xs text-muted-foreground">Overdue</p>
          <p className={`text-2xl font-semibold ${totals.overdue > 0 ? "text-red-600" : ""}`}>{totals.overdue}</p>
        </div>
        <div className="rounded-xl border p-3">
          <p className="text-xs text-muted-foreground">Due today</p>
          <p className="text-2xl font-semibold">{totals.today}</p>
        </div>
        <div className="rounded-xl border p-3">
          <p className="text-xs text-muted-foreground">Waiting on others</p>
          <p className="text-2xl font-semibold">{waiting ?? "–"}</p>
          <p className="text-xs text-muted-foreground">queries you asked</p>
        </div>
      </div>

      <div>
        <p className="mb-1.5 text-xs text-muted-foreground">
          Colour is the type of work; the red or amber chip is how late. Select a type to filter.
        </p>
        <div className="grid grid-cols-2 gap-2 md:grid-cols-3 lg:grid-cols-6">
          {QUEUE_TYPE_ORDER.map((t) => {
            const meta = QUEUE_TYPES[t];
            const source = SOURCE_OF[t];
            const items = data[t] ?? [];
            const { overdue } = countUrgency(items);
            const isFailed = failed.has(source);
            return (
              <button
                key={t}
                type="button"
                aria-pressed={selected === t}
                onClick={() => {
                  setSelected(selected === t ? null : t);
                  setShowAll(false);
                }}
                className="rounded-r-lg border px-3 py-2 text-left"
                style={{
                  borderLeft: `4px solid ${meta.color}`,
                  background: `color-mix(in srgb, ${meta.color} 12%, transparent)`,
                  outline: selected === t ? `2px solid ${meta.color}` : undefined,
                  outlineOffset: 1,
                }}
              >
                <span className="text-xs">{meta.label}</span>
                {isFailed ? (
                  <>
                    <span className="block text-2xl font-semibold text-muted-foreground">–</span>
                    <span
                      role="button"
                      tabIndex={0}
                      className="block text-xs text-red-600 underline"
                      onClick={(e) => {
                        e.stopPropagation();
                        void loadSource(source);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.stopPropagation();
                          void loadSource(source);
                        }
                      }}
                    >
                      Could not load. Retry
                    </span>
                  </>
                ) : (
                  <>
                    <span className="block text-2xl font-semibold">
                      {items.length}
                      {more.has(t) ? "+" : ""}
                    </span>
                    <span className={`block text-xs ${overdue ? "text-red-600" : "text-muted-foreground"}`}>
                      {overdue ? `${overdue} overdue` : "none overdue"}
                    </span>
                  </>
                )}
              </button>
            );
          })}
        </div>
      </div>

      <div className="rounded-xl border p-4">
        <div className="mb-3 flex items-baseline justify-between">
          <h3 className="text-sm font-medium">
            Queue · {selected ? QUEUE_TYPES[selected].label : "all types"} · most late first
          </h3>
          {selected && (
            <button type="button" className="text-xs text-primary hover:underline" onClick={() => setSelected(null)}>
              Show all
            </button>
          )}
        </div>

        {selected && failed.has(SOURCE_OF[selected]) && (
          <p className="py-3 text-sm text-muted-foreground">
            This list could not load. The other types are unaffected.
          </p>
        )}

        {shown.length === 0 && !(selected && failed.has(SOURCE_OF[selected])) ? (
          <p className="py-3 text-sm text-muted-foreground">
            {all.length === 0 && failed.size === 0 ? "All clear. Nothing is waiting on accounts." : "Nothing here."}
          </p>
        ) : (
          <ul className="space-y-1.5">
            {shown.map((item) => {
              const meta = QUEUE_TYPES[item.type];
              return (
                <li key={item.key}>
                  <Link
                    href={item.href}
                    className="flex items-center gap-3 rounded-r-lg px-3 py-2 text-sm hover:brightness-95"
                    style={{
                      borderLeft: `4px solid ${meta.color}`,
                      background: `color-mix(in srgb, ${meta.color} 9%, transparent)`,
                    }}
                  >
                    <span
                      className="w-28 shrink-0 rounded-full px-2 py-0.5 text-center text-[11px]"
                      style={{ background: `color-mix(in srgb, ${meta.color} 28%, transparent)` }}
                    >
                      {meta.label}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{item.title}</span>
                      <span className="block truncate text-xs text-muted-foreground">{item.subtitle}</span>
                    </span>
                    <Chip item={item} />
                    <span className="shrink-0 text-xs text-primary">{meta.action} →</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}

        {!selected && !showAll && rows.length > VISIBLE_ROWS && (
          <button type="button" className="mt-2 text-xs text-primary hover:underline" onClick={() => setShowAll(true)}>
            Show all {rows.length}
          </button>
        )}
      </div>
    </div>
  );
}
