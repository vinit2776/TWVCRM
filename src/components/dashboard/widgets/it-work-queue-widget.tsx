"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Loader2 } from "lucide-react";
import { useCurrentUser } from "@/providers/current-user-provider";
import { todayIST } from "@/lib/accounts-queue";
import type { NextStepItem } from "@/app/api/dashboard/next-steps/route";
import type { FacilityIssue, VoucherInventoryGroup } from "@/types";
import {
  IT_QUEUE_TYPES,
  IT_TILE_ORDER,
  countItUrgency,
  issueUrgency,
  onboardingUrgency,
  rowsForTile,
  sortItQueue,
  teamLoad,
  tileCounts,
  type ItQueueItem,
  type ItQueueType,
  type ItTileType,
} from "@/lib/it-queue";

/**
 * The IT desk: one colour-coded queue of everything waiting on IT, most late
 * first, each row opening the item it is about.
 *
 * It composes endpoints that already exist, so the journey's idea of "WiFi
 * issued" / "door access enrolled" and the facility module's SLA stay the
 * single source of truth. Each source fails independently — a failed tile says
 * so and keeps its retry. The administrator sees the whole team's IT tickets and
 * a load panel; support sees their own.
 */

type Source = "journey" | "issues" | "stock";
const SOURCE_OF: Record<ItTileType, Source> = { onb: "journey", vch: "journey", crd: "journey", tkt: "issues", tsk: "issues" };

const STEP_TYPE: Record<string, ItQueueType> = { wifi_vouchers: "vch", door_access: "crd" };
const STEP_ACTION: Record<string, string> = { wifi_vouchers: "Issue", door_access: "Enrol" };

/** Rows shown before "Show all": the queue is a to-do list, not a report. */
const VISIBLE_ROWS = 8;

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`${url} ${res.status}`);
  return (await res.json()) as T;
}

async function loadJourney(today: string): Promise<ItQueueItem[]> {
  const json = await getJson<{ data: NextStepItem[] }>("/api/dashboard/next-steps");
  const items: ItQueueItem[] = [];
  for (const s of json.data) {
    const type = STEP_TYPE[s.stepKey];
    if (!type) continue;
    // IT's work starts when the contract goes live. A customer still at proposal
    // or draft stage is sales' and accounts' to move, so it never reaches this queue.
    if (!s.contractId || !s.activatedAt) continue;
    const customerKey = s.leadId;
    items.push({
      key: `j:${s.leadId}:${s.stepKey}`,
      type,
      title: s.customer,
      subtitle: `${s.ref} · ${s.label}${s.detail ? ` · ${s.detail}` : ""}`,
      href: s.href ?? "/contracts",
      customerKey,
      action: STEP_ACTION[s.stepKey],
      ...onboardingUrgency(s.activatedAt, today),
      // A step the person can't do yet says why and links to where it gets unblocked.
      ...(s.actionable ? {} : { blockedBy: s.hint ?? "Waiting on an earlier step", action: "Open contract" }),
    });
  }
  return items;
}

interface IssuesResult {
  items: ItQueueItem[];
  load: { assigneeName: string | null; overdue: boolean }[];
}

async function loadIssues(isManager: boolean, now: Date, today: string): Promise<IssuesResult> {
  const mine = getJson<{ data: FacilityIssue[] }>("/api/facility/issues?assigned_to=me&only_open=true&limit=200");
  const team = isManager
    ? getJson<{ data: FacilityIssue[] }>("/api/facility/issues?scope=it&only_open=true&limit=200")
    : Promise.resolve({ data: [] as FacilityIssue[] });
  const [m, t] = await Promise.all([mine, team]);

  // A delegated task can sit outside the IT scope, so "mine" is fetched without one.
  const byId = new Map<string, FacilityIssue>();
  for (const i of [...m.data, ...t.data]) byId.set(i.id, i);

  const items: ItQueueItem[] = [];
  for (const i of byId.values()) {
    const u = issueUrgency(i.sla_target_at, i.sla_breached, now, today);
    if (!u) continue;
    const assignee = i.assignee?.full_name ?? null;
    const where = i.location?.name ?? "";
    const who = isManager
      ? assignee ?? "Not assigned"
      : i.task_type === "delegated_task"
        ? "Delegated task"
        : `Reported by ${i.reporter?.full_name ?? i.reporter_name ?? "a user"}`;
    items.push({
      key: `i:${i.id}`,
      type: i.task_type === "delegated_task" ? "tsk" : "tkt",
      title: `${i.issue_number} · ${i.title}`,
      subtitle: [who, where].filter(Boolean).join(" · "),
      href: `/facility/issues/${i.id}`,
      assigneeName: assignee,
      action: !assignee ? "Assign" : undefined,
      ...u,
    });
  }

  const load = t.data.map((i) => ({
    assigneeName: i.assignee?.full_name ?? null,
    overdue: i.sla_breached || (!!i.sla_target_at && new Date(i.sla_target_at).getTime() < now.getTime()),
  }));
  return { items, load };
}

function Chip({ item }: { item: ItQueueItem }) {
  if (item.blockedBy) {
    return <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">Waiting</span>;
  }
  const cls =
    item.urgency === "overdue"
      ? item.daysLate >= 3
        ? "bg-red-100 text-red-800"
        : "bg-amber-100 text-amber-900"
      : "bg-muted text-muted-foreground";
  const label = item.chip ?? (item.urgency === "overdue" ? `${item.daysLate}d late` : "today");
  return <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] ${cls}`}>{label}</span>;
}

export function ItWorkQueueWidget() {
  const { user } = useCurrentUser();
  const role = user?.role ?? "";
  const isManager = role === "it_manager" || role === "admin";
  const [journey, setJourney] = useState<ItQueueItem[]>([]);
  const [issues, setIssues] = useState<ItQueueItem[]>([]);
  const [load, setLoad] = useState<IssuesResult["load"]>([]);
  const [lowStock, setLowStock] = useState<VoucherInventoryGroup[] | null>(null);
  const [failed, setFailed] = useState<Set<Source>>(new Set());
  const [pending, setPending] = useState(true);
  const [selected, setSelected] = useState<ItTileType | null>(null);
  const [showAll, setShowAll] = useState(false);

  const loadSource = useCallback(
    async (source: Source) => {
      const now = new Date();
      const today = todayIST(now);
      try {
        if (source === "journey") setJourney(await loadJourney(today));
        else if (source === "issues") {
          const r = await loadIssues(isManager, now, today);
          setIssues(r.items);
          setLoad(r.load);
        } else {
          const json = await getJson<{ low_stock_alerts: VoucherInventoryGroup[] }>("/api/vouchers/inventory");
          setLowStock(json.low_stock_alerts ?? []);
        }
        setFailed((prev) => {
          const next = new Set(prev);
          next.delete(source);
          return next;
        });
      } catch {
        setFailed((prev) => new Set(prev).add(source));
      }
    },
    [isManager],
  );

  useEffect(() => {
    if (!role) return;
    const sources: Source[] = isManager ? ["journey", "issues", "stock"] : ["journey", "issues"];
    setPending(true);
    void Promise.all(sources.map(loadSource)).finally(() => setPending(false));
  }, [role, isManager, loadSource]);

  const all = useMemo(() => sortItQueue([...journey, ...issues]), [journey, issues]);
  const totals = countItUrgency(all);
  const waiting = all.filter((i) => i.blockedBy).length;
  const rows = rowsForTile(all, selected);
  const shown = showAll || selected ? rows : rows.slice(0, VISIBLE_ROWS);
  const firstName = user?.full_name?.split(" ")[0];
  const loadRows = useMemo(() => teamLoad(load), [load]);

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
        <h2 className="text-lg font-semibold">{firstName ? `Hello, ${firstName}` : "IT desk"}</h2>
        <p className="text-xs text-muted-foreground">
          {isManager ? "Everything waiting on IT, across the team" : "Everything waiting on you"}, most late first. Each row opens the item.
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
          <p className="text-2xl font-semibold">{waiting}</p>
          <p className="text-xs text-muted-foreground">onboarding steps blocked</p>
        </div>
      </div>

      <div>
        <p className="mb-1.5 text-xs text-muted-foreground">
          Colour is the type of work; the red or amber chip is how late. Select a type to filter.
        </p>
        <div className="grid grid-cols-2 gap-2 md:grid-cols-3 lg:grid-cols-5">
          {IT_TILE_ORDER.map((t) => {
            const meta = IT_QUEUE_TYPES[t];
            const source = SOURCE_OF[t];
            const { total, overdue } = tileCounts(all, t);
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
                    <span className="block text-2xl font-semibold">{total}</span>
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
            Queue · {selected ? IT_QUEUE_TYPES[selected].label : "all types"} · most late first
          </h3>
          <span className="flex gap-3 text-xs">
            {selected && (
              <button type="button" className="text-primary hover:underline" onClick={() => setSelected(null)}>
                Show all
              </button>
            )}
            <Link href="/facility/issues" className="text-primary hover:underline">
              All work orders
            </Link>
          </span>
        </div>

        {selected && failed.has(SOURCE_OF[selected]) && (
          <p className="py-3 text-sm text-muted-foreground">This list could not load. The other types are unaffected.</p>
        )}

        {shown.length === 0 && !(selected && failed.has(SOURCE_OF[selected])) ? (
          <p className="py-3 text-sm text-muted-foreground">
            {all.length === 0 && failed.size === 0 ? "All clear. Nothing is waiting on IT." : "Nothing here."}
          </p>
        ) : (
          <ul className="space-y-1.5">
            {shown.map((item) => {
              const meta = IT_QUEUE_TYPES[item.type];
              return (
                <li key={item.key}>
                  <Link
                    href={item.href}
                    className={`flex items-center gap-3 rounded-r-lg px-3 py-2 text-sm hover:brightness-95 ${item.blockedBy ? "opacity-70" : ""}`}
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
                      <span className="block truncate text-xs text-muted-foreground">
                        {item.blockedBy ?? item.subtitle}
                      </span>
                    </span>
                    <Chip item={item} />
                    <span className="shrink-0 text-xs text-primary">{item.action ?? meta.action} →</span>
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

      {isManager && (
        <div className="grid gap-3 md:grid-cols-2">
          <div className="rounded-xl border p-4">
            <h3 className="mb-2 text-sm font-medium">Team load</h3>
            {failed.has("issues") ? (
              <p className="text-sm text-muted-foreground">Could not load.</p>
            ) : loadRows.length === 0 ? (
              <p className="text-sm text-muted-foreground">No open IT work orders.</p>
            ) : (
              <ul className="space-y-1.5 text-sm">
                {loadRows.map((r) => (
                  <li key={r.name} className="flex items-center justify-between">
                    <span>{r.name}</span>
                    <span className="text-xs text-muted-foreground">
                      {r.open} open
                      {r.overdue > 0 && <span className="text-red-600"> · {r.overdue} overdue</span>}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="rounded-xl border p-4">
            <h3 className="mb-2 text-sm font-medium">Needs a decision</h3>
            {failed.has("stock") ? (
              <button type="button" className="text-sm text-red-600 underline" onClick={() => void loadSource("stock")}>
                Could not load. Retry
              </button>
            ) : lowStock === null ? (
              <p className="text-sm text-muted-foreground">Loading…</p>
            ) : lowStock.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nothing needs a decision. Voucher stock is healthy.</p>
            ) : (
              <Link
                href="/vouchers"
                className="flex items-center justify-between rounded-r-lg px-3 py-2 text-sm hover:brightness-95"
                style={{
                  borderLeft: `4px solid ${IT_QUEUE_TYPES.vch.color}`,
                  background: `color-mix(in srgb, ${IT_QUEUE_TYPES.vch.color} 9%, transparent)`,
                }}
              >
                <span>
                  {lowStock.length} voucher {lowStock.length === 1 ? "group is" : "groups are"} low or out of stock
                  <span className="block text-xs text-muted-foreground">
                    {lowStock
                      .map((g) => `${g.location_name ? `${g.location_name} ` : ""}${g.label} (${g.available} left)`)
                      .join(", ")}
                  </span>
                </span>
                <span className="shrink-0 text-xs text-primary">Upload →</span>
              </Link>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
