"use client";

/**
 * Rentals tab: Unbilled (the rent queue — src/lib/unbilled-queue.ts) plus
 * Billed (sent rent/combined statements), with the Monthly Rent Proforma card.
 *
 * Usage tab ("Usage invoices"): Billed list only — usage statements. Unbilled
 * usage lives in Usage Charges → Unbilled, grouped by contract and month
 * (src/components/billing/usage-billing-board.tsx).
 *
 * Billed is paginated via GET /api/billing-statements with the
 * { page, limit, total, totalPages } shape used elsewhere on this page.
 */

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { Loader2, ChevronLeft, ChevronRight, ChevronDown, CalendarPlus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import { formatCurrency, formatDate } from "@/lib/utils";
import { ProformaBillingCard } from "@/components/billing/proforma-billing-card";
import { WaiveRentMonthDialog } from "@/components/billing/waive-rent-month-dialog";
import { ReviewSendStatementDialog, type ReviewSendTarget } from "@/components/billing/review-send-statement-dialog";
import { Textarea } from "@/components/ui/textarea";
import { StatementLifecycleBadge } from "@/components/accounting/statement-lifecycle";
import type { UnbilledCategory, UnbilledRow } from "@/lib/unbilled-queue";

/** One rent line the backfill preview would bill. Mirrors CyclePreview in
 *  contract-invoices-section.tsx — same /api/billing/auto-generate shape. */
interface BackfillPreviewLine {
  description: string;
  amount: number;
  qty?: number;
  unit_price?: number;
  note?: string;
}
interface BackfillPreview {
  period_label: string;
  subtotal: number;
  tax_amount: number;
  total_amount: number;
  line_items?: BackfillPreviewLine[];
  note?: string;
}

const CATEGORY_ORDER: UnbilledCategory[] = ["current_cycle", "current_cycle_tally", "current_cycle_sent", "rent_gap", "renewal_drift", "no_renewal"];
const CATEGORY_TITLE: Record<UnbilledCategory, string> = {
  current_cycle: "Current cycle — ready to send",
  current_cycle_tally: "With accounts — Tally Inbox",
  current_cycle_sent: "Already sent this cycle",
  rent_gap: "Rent gap",
  renewal_drift: "Renewal drift",
  no_renewal: "No renewal on file",
};
const CATEGORY_BADGE_CLASS: Record<UnbilledCategory, string> = {
  current_cycle: "bg-blue-50 text-blue-900 border-blue-200",
  current_cycle_tally: "bg-violet-50 text-violet-900 border-violet-200",
  current_cycle_sent: "bg-green-50 text-green-900 border-green-200",
  rent_gap: "bg-amber-50 text-amber-900 border-amber-200",
  renewal_drift: "bg-red-50 text-red-900 border-red-200",
  no_renewal: "bg-slate-100 text-slate-700 border-slate-300",
};

const EMPTY_COUNTS: Record<UnbilledCategory, number> = {
  current_cycle: 0, current_cycle_tally: 0, current_cycle_sent: 0, rent_gap: 0, renewal_drift: 0, no_renewal: 0,
};

/** "29 Sep 2026, 6:42 pm" in IST — when a statement was sent or handed off. */
function sentStamp(iso: string): string {
  return new Date(iso).toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit",
  });
}

function monthLabel(year: number, month: number): string {
  return new Date(Date.UTC(year, month - 1, 1)).toLocaleDateString("en-IN", { timeZone: "UTC", month: "long", year: "numeric" });
}

interface BilledStatement {
  id: string;
  statement_number: string;
  statement_type: string;
  status: string;
  period_start: string;
  total_amount: number;
  contract?: { contract_number: string } | null;
  lead?: { first_name?: string; last_name?: string; company?: string } | null;
}

interface Props {
  type: "rent" | "usage";
  userRole?: string | null;
  onFinalized?: () => void | Promise<void>;
  onViewStatement?: (id: string) => void;
}

const BILLING_ROLES = ["admin", "manager", "accounts"];

export function UnbilledBilledTabs({ type, userRole, onFinalized, onViewStatement }: Props) {
  const [tab, setTab] = useState<"unbilled" | "billed">(type === "usage" ? "billed" : "unbilled");
  const canBill = !!userRole && BILLING_ROLES.includes(userRole);
  // Waiving a gap is admin-only (enforced again by the API).
  const canWaive = userRole === "admin";
  const [waiveRow, setWaiveRow] = useState<UnbilledRow | null>(null);
  const [reviewTarget, setReviewTarget] = useState<ReviewSendTarget | null>(null);
  const [showSent, setShowSent] = useState(false);
  // Rent-gap month groups the user has opened/closed; the newest month starts open.
  const [openGapGroups, setOpenGapGroups] = useState<Record<string, boolean>>({});
  const [bulkWaiveOpen, setBulkWaiveOpen] = useState(false);
  const [bulkReason, setBulkReason] = useState("");
  const [bulkError, setBulkError] = useState<string | null>(null);
  const [bulkSaving, setBulkSaving] = useState(false);

  // ── Unbilled ─────────────────────────────────────────────────────────────
  const [unbilledRows, setUnbilledRows] = useState<UnbilledRow[]>([]);
  const [unbilledLoading, setUnbilledLoading] = useState(true);
  const [counts, setCounts] = useState<Record<UnbilledCategory, number>>({
    current_cycle: 0, current_cycle_tally: 0, current_cycle_sent: 0, rent_gap: 0, renewal_drift: 0, no_renewal: 0,
  });

  const loadUnbilled = useCallback(async () => {
    if (type === "usage") { setUnbilledLoading(false); return; }
    setUnbilledLoading(true);
    try {
      const res = await fetch("/api/billing/unbilled?type=rent");
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to load");
      setUnbilledRows(json.data || []);
      setCounts({ ...EMPTY_COUNTS, ...(json.counts || {}) });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to load unbilled queue");
    } finally {
      setUnbilledLoading(false);
    }
  }, [type]);

  useEffect(() => { loadUnbilled(); }, [loadUnbilled]);

  // ── Rent-gap backfill (rent_gap rows with a backfillTarget only) ─────────
  // Same preview-then-confirm flow as "Bill a missed month" on the contract
  // page (contract-invoices-section.tsx) — kept as its own copy here rather
  // than a shared component so this addition can't regress that already-
  // working flow.
  const [backfillRow, setBackfillRow] = useState<UnbilledRow | null>(null);
  const [backfillPreviewing, setBackfillPreviewing] = useState(false);
  const [backfillPreview, setBackfillPreview] = useState<BackfillPreview | null>(null);
  const [backfillBlockedReason, setBackfillBlockedReason] = useState<string | null>(null);
  const [backfillSending, setBackfillSending] = useState(false);

  const openBackfillDialog = async (row: UnbilledRow) => {
    if (!row.backfillTarget) return;
    setBackfillRow(row);
    setBackfillPreview(null);
    setBackfillBlockedReason(null);
    setBackfillPreviewing(true);
    try {
      const res = await fetch("/api/billing/auto-generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dry_run: true, mode: "rent", contract_id: row.contractId, ...row.backfillTarget }),
      });
      const json = await res.json();
      if (!res.ok) {
        setBackfillBlockedReason(json.error || "Preview failed");
        return;
      }
      const rent = json.rent_proformas ?? {};
      const item = (rent.preview ?? [])[0] as BackfillPreview | undefined;
      if (item) {
        setBackfillPreview(item);
      } else if ((rent.already_sent ?? []).length > 0) {
        setBackfillBlockedReason("This month's rent proforma has already been sent to the client.");
      } else {
        setBackfillBlockedReason("Nothing to bill for this month.");
      }
    } catch {
      setBackfillBlockedReason("Preview failed");
    } finally {
      setBackfillPreviewing(false);
    }
  };

  const confirmBackfill = async () => {
    if (!backfillRow?.backfillTarget) return;
    setBackfillSending(true);
    try {
      const res = await fetch("/api/billing/auto-generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dry_run: false, mode: "rent", contract_id: backfillRow.contractId, ...backfillRow.backfillTarget }),
      });
      const json = await res.json();
      if (!res.ok) {
        toast.error(json.error || "Failed to generate the proforma");
        return;
      }
      const noContact: string[] = json.rent_proformas?.no_contact ?? [];
      const notDelivered: string[] = json.rent_proformas?.not_delivered ?? [];
      const errors: string[] = json.errors ?? [];
      if (errors.length > 0) {
        toast.error(errors[0]);
      } else if (noContact.length > 0) {
        toast.error("Proforma raised but not sent — no email or phone on file for this client.");
      } else if (notDelivered.length > 0) {
        toast.error("Proforma raised but the send failed — resend it from the statement.", { duration: 10000 });
      } else if ((json.rent_proformas?.generated ?? 0) > 0) {
        toast.success("Proforma raised and sent to the client");
      } else {
        toast.info("Nothing was generated for this month");
      }
      setBackfillRow(null);
      await loadUnbilled();
      if (onFinalized) await onFinalized();
    } catch {
      toast.error("Failed to generate the proforma");
    } finally {
      setBackfillSending(false);
    }
  };

  // ── Billed (paginated) ───────────────────────────────────────────────────
  const [billedRows, setBilledRows] = useState<BilledStatement[]>([]);
  const [billedLoading, setBilledLoading] = useState(true);
  const [billedPage, setBilledPage] = useState(1);
  const [billedPagination, setBilledPagination] = useState({ page: 1, limit: 25, total: 0, totalPages: 0 });

  // Rentals' Billed list includes "combined" statements too — the legacy
  // rent+usage-in-one-document type is rent-bearing, so it belongs here.
  const billedStatementTypes = type === "rent" ? "rent,combined" : "usage";

  const loadBilled = useCallback(async () => {
    setBilledLoading(true);
    try {
      const res = await fetch(`/api/billing-statements?statement_type=${billedStatementTypes}&page=${billedPage}&limit=25`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to load");
      setBilledRows(json.data || []);
      setBilledPagination(json.pagination || { page: 1, limit: 25, total: 0, totalPages: 0 });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to load billed statements");
    } finally {
      setBilledLoading(false);
    }
  }, [billedPage, billedStatementTypes]);

  useEffect(() => { if (tab === "billed") loadBilled(); }, [tab, loadBilled]);

  // Rent bills a month in advance (this ops month -> next month's proforma).
  const nowIst = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  const opsMonth = nowIst.getUTCMonth() + 1;
  const opsYear = nowIst.getUTCFullYear();
  const nextMonth = opsMonth === 12 ? 1 : opsMonth + 1;
  const nextYear = opsMonth === 12 ? opsYear + 1 : opsYear;

  // "Already sent" rows are shown for visibility only — they aren't unbilled.
  const totalUnbilled = (Object.entries(counts) as [UnbilledCategory, number][])
    .filter(([cat]) => cat !== "current_cycle_sent")
    .reduce((s, [, n]) => s + n, 0);
  const hasAnyRows = unbilledRows.length > 0;

  const rowsByCategory = (cat: UnbilledCategory) => unbilledRows.filter((r) => r.category === cat);

  const renderRow = (row: UnbilledRow) => (
    <div key={row.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
      <div className="min-w-0">
        <p className="text-sm font-medium truncate">
          <span className="font-mono text-xs text-teal-700">{row.contractNumber}</span>
          {" → "}{row.customerName}
        </p>
        <p className="text-xs text-muted-foreground mt-0.5">
          {row.category === "current_cycle_sent" || row.category === "current_cycle_tally" ? (
            <>
              {row.detail}
              {row.sentAt ? ` ${row.category === "current_cycle_tally" ? "since" : ""} ${sentStamp(row.sentAt)}` : ""}
            </>
          ) : (
            <>
              {row.periodLabel}
              {row.detail ? <span className="ml-1.5">· {row.detail}</span> : null}
            </>
          )}
        </p>
      </div>
      <div className="flex items-center gap-3 shrink-0">
        <span className="text-sm font-mono">
          {row.amount != null ? formatCurrency(row.amount) : <span className="text-xs italic text-muted-foreground">unknown</span>}
        </span>
        {row.category === "current_cycle_tally" ? (
          <Link href="/accounting/inbox" className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-2">
            Open Tally Inbox
          </Link>
        ) : row.category.startsWith("current_cycle") ? null : (
          <Link href={`/contracts/${row.contractId}`} className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-2">
            Open contract
          </Link>
        )}
        {row.backfillTarget && canBill && (
          <button
            onClick={() => openBackfillDialog(row)}
            className="text-xs font-semibold text-teal-700 hover:text-teal-900 underline underline-offset-2"
          >
            Send invoice
          </button>
        )}
        {row.category === "rent_gap" && row.gapMonth && canWaive && (
          <button
            onClick={() => setWaiveRow(row)}
            className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-2"
          >
            Waive
          </button>
        )}
        {row.statementId && onViewStatement && (
          <button
            onClick={() => onViewStatement(row.statementId!)}
            className={row.category === "current_cycle"
              ? "text-xs text-muted-foreground hover:text-foreground underline underline-offset-2"
              : "text-xs font-semibold text-teal-700 hover:text-teal-900 underline underline-offset-2"}
          >
            Open statement
          </button>
        )}
        {row.category === "current_cycle" && row.statementId && canBill && (
          <button
            onClick={() => setReviewTarget({
              statementId: row.statementId!,
              status: row.statementStatus ?? "draft",
              contractNumber: row.contractNumber,
              customerName: row.customerName,
              periodLabel: row.periodLabel.split(" · ")[0],
              amount: row.amount,
            })}
            className="text-xs font-semibold text-teal-700 hover:text-teal-900 underline underline-offset-2"
          >
            Review &amp; send
          </button>
        )}
      </div>
    </div>
  );

  // Rent gaps grouped by month, newest first. Months before CRM billing began
  // fold into one bucket (with "Waive all…"); the newest month starts open.
  const renderGapGroups = (rows: UnbilledRow[]) => {
    const groups = new Map<string, { label: string; rows: UnbilledRow[]; before: boolean }>();
    for (const row of rows) {
      const key = row.beforeCrmBilling ? "before" : (row.gapMonth ?? "unknown");
      if (!groups.has(key)) {
        groups.set(key, {
          label: row.beforeCrmBilling ? "" : row.periodLabel.split(" · ")[0],
          rows: [],
          before: !!row.beforeCrmBilling,
        });
      }
      groups.get(key)!.rows.push(row);
    }
    const before = groups.get("before");
    if (before) {
      const months = [...new Set(before.rows.map((r) => r.gapMonth).filter(Boolean) as string[])].sort();
      const short = (ym: string) => new Date(ym + "T00:00:00Z").toLocaleDateString("en-IN", { timeZone: "UTC", month: "short", year: "numeric" });
      before.label = `Before CRM billing (${months.length > 1 ? `${short(months[0])} – ${short(months[months.length - 1])}` : short(months[0] ?? "")})`;
    }
    const ordered = [...groups.entries()]
      .filter(([k]) => k !== "before")
      .sort(([a], [b]) => b.localeCompare(a));
    if (before) ordered.push(["before", before]);
    const newestKey = ordered[0]?.[0];

    return (
      <div className="rounded-md border divide-y">
        {ordered.map(([key, g]) => {
          const isOpen = openGapGroups[key] ?? key === newestKey;
          const canSend = g.rows.filter((r) => r.backfillTarget).length;
          return (
            <div key={key}>
              <div className={`flex items-center justify-between gap-2 px-4 py-2.5 ${isOpen ? "bg-background" : "bg-muted/30"}`}>
                <button
                  onClick={() => setOpenGapGroups((prev) => ({ ...prev, [key]: !isOpen }))}
                  className="flex items-center gap-1.5 text-sm font-medium text-left"
                >
                  <ChevronDown className={`h-3.5 w-3.5 transition-transform ${isOpen ? "" : "-rotate-90"}`} />
                  {g.label}
                </button>
                <div className="flex items-center gap-1.5">
                  <Badge variant="outline" className="text-[11px] font-normal">{g.rows.length} gap{g.rows.length === 1 ? "" : "s"}</Badge>
                  {canSend > 0 && canBill && (
                    <Badge variant="outline" className="text-[11px] font-normal text-teal-800 border-teal-200">{canSend} can send</Badge>
                  )}
                  {g.before && canWaive && (
                    <button
                      onClick={() => { setBulkReason(""); setBulkError(null); setBulkWaiveOpen(true); }}
                      className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-2 ml-1"
                    >
                      Waive all…
                    </button>
                  )}
                </div>
              </div>
              {isOpen && <div className="divide-y border-t pl-4">{g.rows.map(renderRow)}</div>}
            </div>
          );
        })}
      </div>
    );
  };

  const beforeCrmRows = unbilledRows.filter((r) => r.category === "rent_gap" && r.beforeCrmBilling && r.gapMonth);
  const bulkContractCount = new Set(beforeCrmRows.map((r) => r.contractId)).size;

  const confirmBulkWaive = async () => {
    if (bulkReason.trim().length < 5) {
      setBulkError("Give a short reason (at least 5 characters)");
      return;
    }
    setBulkSaving(true);
    try {
      const res = await fetch("/api/billing/rent-waivers/bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          reason: bulkReason.trim(),
          items: beforeCrmRows.map((r) => ({ contract_id: r.contractId, waived_month: r.gapMonth })),
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setBulkError(json.error || "Couldn't waive these months");
        return;
      }
      const skipped = (json.skipped ?? []).length;
      toast.success(`${json.waived} month${json.waived === 1 ? "" : "s"} waived${skipped ? ` · ${skipped} skipped` : ""}`);
      setBulkWaiveOpen(false);
      await loadUnbilled();
    } catch {
      setBulkError("Couldn't waive these months");
    } finally {
      setBulkSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      {type === "rent" && (
        <ProformaBillingCard
          mode="rent"
          periodLabel={monthLabel(nextYear, nextMonth)}
          month={opsMonth}
          year={opsYear}
          onSuccess={async () => { await Promise.all([loadUnbilled(), loadBilled()]); if (onFinalized) await onFinalized(); }}
        />
      )}

      <div className="flex items-center justify-between gap-2 border-b pb-3">
        <div className="flex items-center gap-2">
          {type === "rent" && <button
            onClick={() => setTab("unbilled")}
            className={`px-4 py-2 rounded-lg text-sm font-semibold border transition-all ${tab === "unbilled" ? "bg-teal-700 text-white border-teal-700 shadow-sm" : "bg-white text-gray-700 border-gray-300 hover:border-teal-500"}`}
          >
            Unbilled <span className="ml-1 opacity-80">({totalUnbilled})</span>
          </button>}
          <button
            onClick={() => setTab("billed")}
            className={`px-4 py-2 rounded-lg text-sm font-semibold border transition-all ${tab === "billed" ? "bg-teal-700 text-white border-teal-700 shadow-sm" : "bg-white text-gray-700 border-gray-300 hover:border-teal-500"}`}
          >
            {type === "usage" ? "Usage invoices" : "Billed"}
          </button>
        </div>
        {type === "usage" && <p className="text-xs text-muted-foreground">Unbilled usage is in Usage Charges → Unbilled.</p>}
      </div>

      {tab === "unbilled" && (
        <div className="space-y-5">
          {unbilledLoading ? (
            <div className="flex justify-center py-10"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
          ) : !hasAnyRows ? (
            <p className="text-sm text-muted-foreground py-6 text-center">Nothing outstanding — every contract is current.</p>
          ) : (
            CATEGORY_ORDER.map((cat) => {
              const rows = rowsByCategory(cat);
              if (rows.length === 0) return null;
              const collapsible = cat === "current_cycle_sent";
              const open = !collapsible || showSent;
              return (
                <div key={cat} className="space-y-2">
                  <div className="flex items-center gap-2">
                    <Badge className={`${CATEGORY_BADGE_CLASS[cat]} text-[11px]`}>{CATEGORY_TITLE[cat]}</Badge>
                    <span className="text-xs text-muted-foreground">{rows.length}</span>
                    {cat === "rent_gap" && <span className="text-xs text-muted-foreground">· grouped by month, newest first</span>}
                    {collapsible && (
                      <button onClick={() => setShowSent((v) => !v)} className="ml-auto text-xs text-muted-foreground hover:text-foreground underline underline-offset-2">
                        {showSent ? "Hide" : "Show"}
                      </button>
                    )}
                  </div>
                  {open && (cat === "rent_gap" ? renderGapGroups(rows) : (
                    <div className="rounded-md border divide-y">{rows.map(renderRow)}</div>
                  ))}
                </div>
              );
            })
          )}
        </div>
      )}

      {tab === "billed" && (
        <div className="space-y-3">
          <div className="rounded-md border overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/30 text-xs text-muted-foreground">
                  <th className="text-left px-4 py-2 font-medium">Statement</th>
                  <th className="text-left px-4 py-2 font-medium">Contract</th>
                  <th className="text-left px-4 py-2 font-medium">Customer</th>
                  <th className="text-left px-4 py-2 font-medium">Period</th>
                  <th className="text-right px-4 py-2 font-medium">Amount</th>
                  <th className="text-left px-4 py-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {billedLoading ? (
                  <tr><td colSpan={6} className="text-center py-8"><Loader2 className="h-4 w-4 animate-spin inline-block text-muted-foreground" /></td></tr>
                ) : billedRows.length === 0 ? (
                  <tr><td colSpan={6} className="text-center py-8 text-muted-foreground">No statements yet</td></tr>
                ) : (
                  billedRows.map((s) => (
                    <tr key={s.id} className="hover:bg-muted/20">
                      <td className="px-4 py-2.5">
                        {onViewStatement ? (
                          <button onClick={() => onViewStatement(s.id)} className="font-mono text-xs text-teal-700 hover:underline">{s.statement_number}</button>
                        ) : (
                          <span className="font-mono text-xs">{s.statement_number}</span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 font-mono text-xs">{s.contract?.contract_number ?? "—"}</td>
                      <td className="px-4 py-2.5">{s.lead?.company || `${s.lead?.first_name ?? ""} ${s.lead?.last_name ?? ""}`.trim() || "—"}</td>
                      <td className="px-4 py-2.5 text-xs text-muted-foreground">{formatDate(s.period_start)}</td>
                      <td className="px-4 py-2.5 text-right font-mono">{formatCurrency(s.total_amount)}</td>
                      <td className="px-4 py-2.5"><StatementLifecycleBadge statementId={s.id} compact fallbackStatus={s.status} /></td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          {billedPagination.totalPages > 1 && (
            <div className="flex items-center justify-between">
              <p className="text-sm text-muted-foreground">
                Page {billedPagination.page} of {billedPagination.totalPages} ({billedPagination.total} total)
              </p>
              <div className="flex gap-2">
                <button
                  onClick={() => setBilledPage((p) => p - 1)}
                  disabled={billedPage <= 1}
                  className="p-1.5 rounded border disabled:opacity-40 disabled:cursor-not-allowed hover:bg-muted/40"
                >
                  <ChevronLeft className="h-4 w-4" />
                </button>
                <button
                  onClick={() => setBilledPage((p) => p + 1)}
                  disabled={billedPage >= billedPagination.totalPages}
                  className="p-1.5 rounded border disabled:opacity-40 disabled:cursor-not-allowed hover:bg-muted/40"
                >
                  <ChevronRight className="h-4 w-4" />
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      <Dialog open={!!backfillRow} onOpenChange={(open) => { if (!open) setBackfillRow(null); }}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <CalendarPlus className="h-4 w-4 shrink-0" />
              Bill a missed month
            </DialogTitle>
            <DialogDescription>
              {backfillRow && (
                <>
                  <span className="font-mono text-xs text-teal-700">{backfillRow.contractNumber}</span> → {backfillRow.customerName}: {backfillRow.periodLabel.split(" · ")[0]} never got a rent statement. Raises that missed month&rsquo;s rent proforma, priced exactly as shown below. Sending it creates the payment link and emails the client.
                </>
              )}
            </DialogDescription>
          </DialogHeader>

          {backfillPreviewing ? (
            <div className="flex items-center gap-2 py-8 justify-center text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Working out what&apos;s due…
            </div>
          ) : backfillBlockedReason ? (
            <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
              {backfillBlockedReason}
            </div>
          ) : backfillPreview ? (
            <div className="space-y-3">
              <div className="flex items-baseline justify-between">
                <span className="text-sm text-muted-foreground">Period</span>
                <span className="text-sm font-medium">{backfillPreview.period_label}</span>
              </div>
              <div className="border rounded-md max-h-64 overflow-y-auto">
                <table className="w-full text-sm">
                  <thead className="bg-muted/40 text-xs text-muted-foreground sticky top-0">
                    <tr>
                      <th className="text-left font-medium py-2 px-3">Description</th>
                      <th className="text-right font-medium py-2 px-3">Qty</th>
                      <th className="text-right font-medium py-2 px-3">Rate</th>
                      <th className="text-right font-medium py-2 px-3">Amount</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {(backfillPreview.line_items ?? []).map((li, i) => (
                      <tr key={i}>
                        <td className="py-2 px-3">
                          {li.description}
                          {li.note && <span className="block text-xs text-muted-foreground">{li.note}</span>}
                        </td>
                        <td className="py-2 px-3 text-right tabular-nums">{li.qty ?? "—"}</td>
                        <td className="py-2 px-3 text-right tabular-nums">
                          {li.unit_price != null ? formatCurrency(li.unit_price) : "—"}
                        </td>
                        <td className="py-2 px-3 text-right tabular-nums">{formatCurrency(li.amount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="space-y-1 text-sm">
                <div className="flex justify-between text-muted-foreground">
                  <span>Subtotal</span>
                  <span className="tabular-nums">{formatCurrency(backfillPreview.subtotal)}</span>
                </div>
                <div className="flex justify-between text-muted-foreground">
                  <span>GST</span>
                  <span className="tabular-nums">{formatCurrency(backfillPreview.tax_amount)}</span>
                </div>
                <div className="flex justify-between font-medium">
                  <span>Total</span>
                  <span className="tabular-nums">{formatCurrency(backfillPreview.total_amount)}</span>
                </div>
              </div>
              {backfillPreview.note && (
                <p className="text-xs text-muted-foreground">{backfillPreview.note}</p>
              )}
            </div>
          ) : null}

          <DialogFooter>
            <Button variant="outline" onClick={() => setBackfillRow(null)} disabled={backfillSending}>
              Cancel
            </Button>
            <Button onClick={confirmBackfill} disabled={!backfillPreview || backfillSending}>
              {backfillSending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Raise &amp; send
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ReviewSendStatementDialog
        target={reviewTarget}
        onClose={() => setReviewTarget(null)}
        onSent={async () => { await loadUnbilled(); if (onFinalized) await onFinalized(); }}
      />

      <Dialog open={bulkWaiveOpen} onOpenChange={(o) => { if (!o && !bulkSaving) setBulkWaiveOpen(false); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Waive {beforeCrmRows.length} months before CRM billing</DialogTitle>
            <DialogDescription>
              Every gap in this bucket (across {bulkContractCount} contract{bulkContractCount === 1 ? "" : "s"}) is marked as
              not billed through the CRM, with the reason below. Nothing is sent to any customer. An admin can undo any
              month from its contract page.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Textarea
              value={bulkReason}
              onChange={(e) => { setBulkReason(e.target.value); setBulkError(null); }}
              placeholder="Billed outside the CRM before rent billing moved in (June 2026)"
              rows={3}
            />
            {bulkError && <p className="text-xs text-destructive">{bulkError}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBulkWaiveOpen(false)} disabled={bulkSaving}>Cancel</Button>
            <Button onClick={confirmBulkWaive} disabled={bulkSaving}>
              {bulkSaving && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />}
              Waive {beforeCrmRows.length} months
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <WaiveRentMonthDialog
        target={waiveRow?.gapMonth ? {
          contractId: waiveRow.contractId,
          contractNumber: waiveRow.contractNumber,
          month: waiveRow.gapMonth,
          monthLabel: monthLabel(Number(waiveRow.gapMonth.slice(0, 4)), Number(waiveRow.gapMonth.slice(5, 7))),
        } : null}
        onClose={() => setWaiveRow(null)}
        onWaived={loadUnbilled}
      />
    </div>
  );
}
