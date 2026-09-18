"use client";

/**
 * Usage Charges → Unbilled. One invoice per contract-month either way; the
 * "Group by" toggle only changes the nesting — month → contract (the default,
 * for month-end closing) or contract → month (for a customer's whole picture).
 * The choice is remembered per browser. Data and rules come from
 * GET /api/usage-billing/unbilled
 * (src/lib/usage-billing.ts); per-charge actions reuse the page's existing
 * waive / reduce / hold / release / "Bill anyway" dialogs via callbacks, and
 * Review & send opens UsageSendDialog.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  AlertCircle, Ban, CheckCircle, ChevronDown, ChevronRight, Eye, Loader2, MinusCircle,
  MoreHorizontal, PauseCircle, Pencil, PlayCircle, Search, Send, X,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { formatCurrency, formatDate } from "@/lib/utils";
import type { UsageContractGroup, UsageMonthGroup } from "@/lib/usage-billing";
import { UsageSendDialog, type UsageInvoiceToSend } from "@/components/billing/usage-send-dialog";

export type BoardCharge = UsageMonthGroup["charges"][number];

export interface OldUsageDraft {
  id: string;
  statement_number: string;
  contract_number: string | null;
  period_start: string;
  total_amount: number;
}

interface Props {
  refreshKey: number;
  canSend: boolean;
  canWaive: boolean;
  onChanged: () => void;
  onWaive: (c: BoardCharge, g: UsageContractGroup) => void;
  onReduce: (c: BoardCharge, g: UsageContractGroup) => void;
  onHold: (c: BoardCharge, g: UsageContractGroup) => void;
  onRelease: (c: BoardCharge, g: UsageContractGroup) => void;
  onReview: (c: BoardCharge, g: UsageContractGroup) => void;
  onEdit: (c: BoardCharge) => void;
  onAddCharge: (contractId: string) => void;
}

const SOURCE_LABEL: Record<BoardCharge["source"], string> = { manual: "Manual", print: "Print", facility: "Facility" };

function routeBadge(mode: UsageContractGroup["billingMode"]) {
  return mode === "gst_direct"
    ? <Badge variant="outline" className="bg-green-50 text-green-800 border-green-200 text-[11px]">GST direct</Badge>
    : <Badge variant="outline" className="bg-blue-50 text-blue-800 border-blue-200 text-[11px]">Proforma first</Badge>;
}

export function toInvoice(g: UsageContractGroup, m: UsageMonthGroup): UsageInvoiceToSend {
  return {
    contractId: g.contractId, contractNumber: g.contractNumber, customerName: g.customerName,
    billingMode: g.billingMode, year: m.year, month: m.month, label: m.label,
    chargeKeys: m.billableKeys, subtotal: m.subtotal, total: m.total,
    lines: m.charges.filter((c) => c.status === "billable").map((c) => ({ key: c.key, description: c.description, amount: c.amount })),
  };
}

type ViewMode = "month" | "contract";
const VIEW_KEY = "twv.usageBoard.groupBy";

/** One charge line, identical in both groupings. */
function ChargeRow({ c, g, canWaive, actions }: { c: BoardCharge; g: UsageContractGroup; canWaive: boolean; actions: Props }) {
  return (
    <li className={`grid grid-cols-[minmax(0,1fr)_auto] sm:grid-cols-[minmax(0,1fr)_auto_auto] items-start gap-x-4 gap-y-1 px-4 py-2.5 pl-8 ${c.status === "held" ? "bg-amber-50/60" : ""}`}>
      <div className="min-w-0">
        <p className={`text-sm truncate ${c.status === "within_quota" ? "text-muted-foreground" : ""}`} title={c.description}>{c.description}</p>
        <p className="text-xs text-muted-foreground flex flex-wrap gap-x-1.5">
          <span>{SOURCE_LABEL[c.source]}</span>
          {c.bookingNumber && <span>· {c.bookingNumber}</span>}
          <span>· {formatDate(c.date)}</span>
          {c.status === "held" && <span className="text-amber-700 font-medium">· On hold{c.holdReason ? `: ${c.holdReason}` : ""}</span>}
          {c.status === "needs_review" && <span className="text-red-600 font-medium">· Over 60 days — needs review, not in total</span>}
          {c.status === "within_quota" && <span>· Within quota, not billed</span>}
        </p>
      </div>
      <span className={`text-sm tabular-nums text-right ${c.status === "billable" ? "font-medium" : "text-muted-foreground line-through decoration-muted-foreground/40"}`}>
        {formatCurrency(c.amount)}
      </span>
      <div className="col-span-2 sm:col-span-1 flex items-center justify-end gap-1.5 flex-wrap">
        {c.status === "within_quota" ? null : c.status === "held" ? (
          <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => actions.onRelease(c, g)}>
            <PlayCircle className="mr-1 h-3.5 w-3.5" />Release
          </Button>
        ) : (
          <>
            {c.status === "needs_review" && (
              <Button size="sm" className="h-7 text-xs bg-teal-700 hover:bg-teal-800" onClick={() => actions.onReview(c, g)}>
                <CheckCircle className="mr-1 h-3.5 w-3.5" />Bill anyway
              </Button>
            )}
            {canWaive && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="sm" variant="outline" className="h-7 text-xs">Waive<ChevronDown className="ml-1 h-3 w-3" /></Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={() => actions.onWaive(c, g)}><Ban className="mr-2 h-4 w-4" />Waive fully</DropdownMenuItem>
                  <DropdownMenuItem onClick={() => actions.onReduce(c, g)}><MinusCircle className="mr-2 h-4 w-4" />Waive partly (reduce)</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => actions.onHold(c, g)}>
              <PauseCircle className="mr-1 h-3.5 w-3.5" />Hold
            </Button>
          </>
        )}
        {c.source === "manual" && c.status !== "within_quota" && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" className="h-7 w-7 p-0" aria-label="More actions"><MoreHorizontal className="h-4 w-4" /></Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => actions.onEdit(c)}><Pencil className="mr-2 h-4 w-4" />Edit</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
    </li>
  );
}

function MonthStateBadges({ m }: { m: UsageMonthGroup }) {
  return (
    <>
      {m.block === "open_month" && <span className="text-xs font-normal text-muted-foreground">month still open — send after it ends</span>}
      {m.block === "accounting_locked" && <Badge variant="outline" className="text-[10px] bg-red-50 text-red-700 border-red-200">Locked in accounting</Badge>}
      {m.alreadyInvoiced && <Badge variant="outline" className="text-[10px] bg-amber-50 text-amber-800 border-amber-200">{m.label.split(" ")[0]} already invoiced ({m.alreadyInvoiced}) — this is extra</Badge>}
    </>
  );
}

function SendMonthButton({ m, onSend }: { m: UsageMonthGroup; onSend: () => void }) {
  return (
    <Button
      size="sm"
      variant={m.canSend ? "default" : "outline"}
      className={m.canSend ? "h-8 bg-teal-700 hover:bg-teal-800" : "h-8"}
      disabled={!m.canSend}
      title={
        m.block === "open_month" ? "Can be sent after the month ends"
          : m.block === "accounting_locked" ? "This month is locked in accounting"
          : m.subtotal <= 0 ? "Nothing billable in this month" : undefined
      }
      onClick={onSend}
    >
      Review &amp; send
    </Button>
  );
}

export function UsageBillingBoard(props: Props) {
  const { refreshKey, canSend, canWaive, onChanged } = props;
  const [groups, setGroups] = useState<UsageContractGroup[]>([]);
  const [oldDrafts, setOldDrafts] = useState<OldUsageDraft[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [quotaOpen, setQuotaOpen] = useState<Set<string>>(new Set());
  const [sending, setSending] = useState<UsageInvoiceToSend[] | null>(null);
  // Month-first by default: month-end closing is the routine job. The choice
  // is per browser — a personal preference, not shared state.
  const [view, setView] = useState<ViewMode>("month");
  const [collapsedMonths, setCollapsedMonths] = useState<Set<string>>(new Set());
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(VIEW_KEY);
      if (saved === "month" || saved === "contract") setView(saved);
    } catch { /* private window / blocked storage — keep the default */ }
  }, []);
  const changeView = (next: ViewMode) => {
    setView(next);
    try { window.localStorage.setItem(VIEW_KEY, next); } catch { /* ignore */ }
  };
  const [discarding, setDiscarding] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetch("/api/usage-billing/unbilled");
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to load");
      setGroups(json.data ?? []);
      setOldDrafts(json.old_drafts ?? []);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Failed to load unbilled usage");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load, refreshKey]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return groups;
    return groups.filter((g) =>
      g.contractNumber.toLowerCase().includes(q) ||
      g.customerName.toLowerCase().includes(q) ||
      g.months.some((m) => m.charges.some((c) => c.description.toLowerCase().includes(q) || (c.bookingNumber ?? "").toLowerCase().includes(q))),
    );
  }, [groups, search]);

  const summary = useMemo(() => {
    let invoices = 0, total = 0, held = 0, review = 0, locked = 0;
    for (const g of visible) for (const m of g.months) {
      if (m.canSend) { invoices++; total += m.total; }
      else if (m.subtotal > 0 && m.block) locked++;
      for (const c of m.charges) {
        if (c.status === "held") held++;
        if (c.status === "needs_review") review++;
      }
    }
    return { invoices, total, held, review, locked };
  }, [visible]);

  const allSendable = useMemo(
    () => visible.flatMap((g) => g.months.filter((m) => m.canSend).map((m) => toInvoice(g, m))),
    [visible],
  );

  /** The same rows, pivoted: month → the contracts with charges in it. */
  const byMonth = useMemo(() => {
    const map = new Map<string, { key: string; label: string; block: UsageMonthGroup["block"]; rows: Array<{ g: UsageContractGroup; m: UsageMonthGroup }> }>();
    for (const g of visible) for (const m of g.months) {
      const entry = map.get(m.key) ?? { key: m.key, label: m.label, block: m.block, rows: [] };
      entry.rows.push({ g, m });
      map.set(m.key, entry);
    }
    return [...map.values()]
      .sort((a, b) => b.key.localeCompare(a.key))
      .map((month) => {
        const sendable = month.rows.filter((r) => r.m.canSend);
        return {
          ...month,
          rows: month.rows.sort((a, b) => a.g.contractNumber.localeCompare(b.g.contractNumber)),
          charges: month.rows.reduce((n, r) => n + r.m.charges.length, 0),
          total: month.rows.reduce((t, r) => t + r.m.total, 0),
          needsReview: month.rows.reduce((n, r) => n + r.m.charges.filter((c) => c.status === "needs_review").length, 0),
          held: month.rows.reduce((n, r) => n + r.m.charges.filter((c) => c.status === "held").length, 0),
          sendable,
        };
      });
  }, [visible]);

  const discardOldDrafts = async () => {
    setDiscarding(true);
    let failed = 0;
    for (const d of oldDrafts) {
      const res = await fetch(`/api/billing-statements/${d.id}/discard`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ discard_reason: "Old Generate Drafts usage draft — replaced by grouped usage billing" }),
      });
      if (!res.ok) failed++;
    }
    setDiscarding(false);
    if (failed) toast.error(`${failed} draft${failed === 1 ? "" : "s"} couldn't be discarded`);
    else toast.success("Old drafts discarded — their charges are back in the list");
    onChanged();
  };

  const toggle = (set: Set<string>, key: string, setter: (s: Set<string>) => void) => {
    const next = new Set(set);
    if (next.has(key)) next.delete(key); else next.add(key);
    setter(next);
  };

  return (
    <div className="space-y-4">
      {oldDrafts.length > 0 && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 flex flex-wrap items-start justify-between gap-3">
          <div className="flex gap-2 min-w-0">
            <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
            <div>
              <p className="font-medium">{oldDrafts.length} old usage draft{oldDrafts.length === 1 ? " is" : "s are"} holding charges</p>
              <p className="text-xs mt-0.5">
                Made by the old Generate Drafts button and never sent:{" "}
                {oldDrafts.map((d) => `${d.statement_number}${d.contract_number ? ` (${d.contract_number})` : ""}`).join(", ")}.
                Discarding returns their charges to this list.
              </p>
            </div>
          </div>
          {canSend && (
            <Button size="sm" variant="outline" className="bg-white" onClick={discardOldDrafts} disabled={discarding}>
              {discarding && <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />}Discard {oldDrafts.length}
            </Button>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-teal-200 bg-teal-50 px-4 py-3">
        <div className="text-sm text-teal-900">
          <span className="text-xs uppercase tracking-wide font-medium text-teal-800">Ready to bill</span>
          <p className="font-semibold tabular-nums">
            {summary.invoices} invoice{summary.invoices === 1 ? "" : "s"} · {formatCurrency(summary.total)}
            <span className="font-normal text-xs text-teal-800">
              {summary.locked > 0 && ` · ${summary.locked} waiting for month-end`}
              {summary.held > 0 && ` · ${summary.held} on hold`}
              {summary.review > 0 && ` · ${summary.review} need review`}
            </span>
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex rounded-md border border-teal-200 bg-white p-0.5" role="group" aria-label="Group by">
            <span className="px-2 py-1 text-[11px] uppercase tracking-wide text-muted-foreground self-center">Group by</span>
            {(["month", "contract"] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                aria-pressed={view === mode}
                onClick={() => changeView(mode)}
                className={`px-3 py-1 text-xs font-semibold rounded ${view === mode ? "bg-teal-700 text-white" : "text-teal-900 hover:bg-teal-50"}`}
              >
                {mode === "month" ? "Month" : "Contract"}
              </button>
            ))}
          </div>
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
            <Input
              id="usage-board-search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search contract, customer, charge…"
              className="pl-8 pr-8 h-9 w-[240px] text-sm bg-white"
            />
            {search && (
              <button type="button" aria-label="Clear search" onClick={() => setSearch("")} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
          {canSend && (
            <Button className="bg-teal-700 hover:bg-teal-800" disabled={allSendable.length === 0} onClick={() => setSending(allSendable)}>
              <Send className="h-4 w-4 mr-1.5" />Review &amp; send all {allSendable.length || ""}
            </Button>
          )}
        </div>
      </div>

      {loading && groups.length === 0 ? (
        <div className="flex justify-center py-10"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
      ) : loadError ? (
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 flex items-center justify-between gap-3">
          <span>{loadError}</span>
          <Button size="sm" variant="outline" onClick={() => void load()}>Retry</Button>
        </div>
      ) : visible.length === 0 ? (
        <p className="text-sm text-muted-foreground py-8 text-center">
          {search ? `No unbilled usage matches “${search}”.` : "No unbilled usage. Charges you log will appear here, grouped by contract and month."}
        </p>
      ) : view === "month" ? (
        <div className="space-y-3">
          {byMonth.map((month) => {
            const isCollapsed = collapsedMonths.has(month.key);
            return (
              <section key={month.key} className="rounded-md border bg-white">
                <header className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
                  <button
                    type="button"
                    onClick={() => toggle(collapsedMonths, month.key, setCollapsedMonths)}
                    className="flex items-start gap-2 text-left min-w-0"
                    aria-expanded={!isCollapsed}
                  >
                    {isCollapsed ? <ChevronRight className="h-4 w-4 mt-0.5 shrink-0 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 mt-0.5 shrink-0 text-muted-foreground" />}
                    <span className="min-w-0">
                      <span className="block text-sm font-semibold flex flex-wrap items-center gap-2">
                        {month.label}
                        {month.block === "open_month" && <span className="text-xs font-normal text-muted-foreground">still open — send after it ends</span>}
                        {month.block === "accounting_locked" && <Badge variant="outline" className="text-[10px] bg-red-50 text-red-700 border-red-200">Locked in accounting</Badge>}
                        {month.needsReview > 0 && <Badge variant="outline" className="text-[10px] bg-red-50 text-red-700 border-red-200">{month.needsReview} need review</Badge>}
                        {month.held > 0 && <Badge variant="outline" className="text-[10px] bg-amber-50 text-amber-800 border-amber-200">{month.held} on hold</Badge>}
                      </span>
                      <span className="block text-xs text-muted-foreground">
                        {month.sendable.length > 0 ? `${month.sendable.length} invoice${month.sendable.length === 1 ? "" : "s"} ready` : "Nothing ready to send"} · {month.rows.length} contract{month.rows.length === 1 ? "" : "s"} · {month.charges} charge{month.charges === 1 ? "" : "s"}
                      </span>
                    </span>
                  </button>
                  <span className="flex items-center gap-3">
                    <span className="text-sm font-semibold tabular-nums">{formatCurrency(month.total)}</span>
                    {canSend && month.sendable.length > 0 && (
                      <Button
                        size="sm"
                        className="h-8 bg-teal-700 hover:bg-teal-800"
                        onClick={() => setSending(month.sendable.map(({ g, m }) => toInvoice(g, m)))}
                      >
                        <Send className="h-3.5 w-3.5 mr-1.5" />Send all {month.sendable.length}
                      </Button>
                    )}
                  </span>
                </header>

                {!isCollapsed && month.rows.map(({ g, m }) => {
                  const quotaKey = `${month.key}:${g.contractId}`;
                  const showQuota = quotaOpen.has(quotaKey);
                  const quotaCount = m.charges.filter((c) => c.status === "within_quota").length;
                  return (
                    <div key={g.contractId} className="border-t">
                      <div className="flex flex-wrap items-center justify-between gap-2 bg-muted/40 px-4 py-2">
                        <span className="text-sm font-medium flex flex-wrap items-center gap-2 min-w-0">
                          <span className="font-mono text-xs text-teal-700">{g.contractNumber}</span>
                          <span className="truncate">{g.customerName}</span>
                          {g.ended && <Badge variant="outline" className="text-[10px] text-slate-600 border-slate-300">Contract ended</Badge>}
                          {routeBadge(g.billingMode)}
                          {m.alreadyInvoiced && <Badge variant="outline" className="text-[10px] bg-amber-50 text-amber-800 border-amber-200">already invoiced ({m.alreadyInvoiced}) — this is extra</Badge>}
                        </span>
                        <span className="flex items-center gap-3">
                          <span className="text-right">
                            <span className="block text-sm font-semibold tabular-nums">{formatCurrency(m.total)}</span>
                            {m.subtotal > 0 && <span className="block text-[11px] text-muted-foreground tabular-nums">{formatCurrency(m.subtotal)} + GST</span>}
                          </span>
                          {canSend && <SendMonthButton m={m} onSend={() => setSending([toInvoice(g, m)])} />}
                        </span>
                      </div>

                      <ul className="divide-y">
                        {m.charges.filter((c) => c.status !== "within_quota" || showQuota).map((c) => (
                          <ChargeRow key={c.key} c={c} g={g} canWaive={canWaive} actions={props} />
                        ))}
                      </ul>

                      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2 text-xs">
                        <button type="button" className="font-medium text-teal-700 hover:text-teal-900" onClick={() => props.onAddCharge(g.contractId)}>
                          + Add charge to this contract
                        </button>
                        {quotaCount > 0 && (
                          <button type="button" className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1" onClick={() => toggle(quotaOpen, quotaKey, setQuotaOpen)}>
                            <Eye className="h-3 w-3" />{showQuota ? "Hide" : "Show"} within quota, not billed ({quotaCount})
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </section>
            );
          })}
        </div>
      ) : (
        <div className="space-y-3">
          {visible.map((g) => {
            const isCollapsed = collapsed.has(g.contractId);
            const quotaCount = g.months.reduce((n, m) => n + m.charges.filter((c) => c.status === "within_quota").length, 0);
            const showQuota = quotaOpen.has(g.contractId);
            const sendableMonths = g.months.filter((m) => m.canSend).length;
            return (
              <section key={g.contractId} className="rounded-md border bg-white">
                <header className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
                  <button
                    type="button"
                    onClick={() => toggle(collapsed, g.contractId, setCollapsed)}
                    className="flex items-start gap-2 text-left min-w-0"
                    aria-expanded={!isCollapsed}
                  >
                    {isCollapsed ? <ChevronRight className="h-4 w-4 mt-0.5 shrink-0 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 mt-0.5 shrink-0 text-muted-foreground" />}
                    <span className="min-w-0">
                      <span className="block text-sm font-semibold">
                        <span className="font-mono text-xs text-teal-700">{g.contractNumber}</span> · {g.customerName}
                        {g.ended && <Badge variant="outline" className="ml-2 text-[10px] text-slate-600 border-slate-300">Contract ended</Badge>}
                      </span>
                      <span className="block text-xs text-muted-foreground">
                        {sendableMonths > 0 ? `${sendableMonths} invoice${sendableMonths === 1 ? "" : "s"} ready` : "Nothing ready to send"} · {g.months.length} month{g.months.length === 1 ? "" : "s"}
                      </span>
                    </span>
                  </button>
                  <span className="flex items-center gap-3">
                    {routeBadge(g.billingMode)}
                    <span className="text-sm font-semibold tabular-nums">{formatCurrency(g.total)}</span>
                    <Link href={`/contracts/${g.contractId}`} target="_blank" rel="noopener" className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-2">Contract</Link>
                  </span>
                </header>

                {!isCollapsed && g.months.map((m) => (
                  <div key={m.key} className="border-t">
                    <div className="flex flex-wrap items-center justify-between gap-2 bg-muted/40 px-4 py-2">
                      <span className="text-sm font-medium flex flex-wrap items-center gap-2">
                        {m.label}
                        <MonthStateBadges m={m} />
                      </span>
                      <span className="flex items-center gap-3">
                        <span className="text-right">
                          <span className="block text-sm font-semibold tabular-nums">{formatCurrency(m.total)}</span>
                          {m.subtotal > 0 && <span className="block text-[11px] text-muted-foreground tabular-nums">{formatCurrency(m.subtotal)} + GST</span>}
                        </span>
                        {canSend && <SendMonthButton m={m} onSend={() => setSending([toInvoice(g, m)])} />}
                      </span>
                    </div>

                    <ul className="divide-y">
                      {m.charges.filter((c) => c.status !== "within_quota" || showQuota).map((c) => (
                        <ChargeRow key={c.key} c={c} g={g} canWaive={canWaive} actions={props} />
                      ))}
                    </ul>
                  </div>
                ))}

                {!isCollapsed && (
                  <footer className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t px-4 py-2 text-xs">
                    <button type="button" className="font-medium text-teal-700 hover:text-teal-900" onClick={() => props.onAddCharge(g.contractId)}>
                      + Add charge to this contract
                    </button>
                    {quotaCount > 0 && (
                      <button type="button" className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1" onClick={() => toggle(quotaOpen, g.contractId, setQuotaOpen)}>
                        <Eye className="h-3 w-3" />{showQuota ? "Hide" : "Show"} within quota, not billed ({quotaCount})
                      </button>
                    )}
                  </footer>
                )}
              </section>
            );
          })}
        </div>
      )}

      {sending && (
        <UsageSendDialog
          invoices={sending}
          onClose={(changed) => { setSending(null); if (changed) onChanged(); }}
        />
      )}
    </div>
  );
}
