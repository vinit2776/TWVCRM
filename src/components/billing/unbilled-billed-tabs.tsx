"use client";

/**
 * Unbilled / Billed for one statement type — rendered once by the Rentals
 * tab (type="rent") and once by the Usage tab (type="usage"), each with its
 * own batch-run card and its own Unbilled/Billed lists. The two tabs used to
 * share one mixed "Statements" view where a usage row had no discovery path
 * of its own (no card to generate a draft, current_cycle only ever showed
 * what already had a statement) — splitting by type gives usage the same
 * Preview → Generate Drafts flow rent already had.
 *
 * Unbilled is a single, persistent, cross-month list (see
 * src/lib/unbilled-queue.ts for the detection logic): this cycle's
 * ready-to-send statement of this type, plus — rent only — past rent gaps,
 * drifting renewals, and expired contracts with no renewal on file. Nothing
 * here is scoped to whichever month the page-level MonthPicker happens to
 * show — that picker still drives the other tabs on this page, just not
 * this one.
 *
 * Billed is the historical statements list for this type, paginated via the
 * same GET /api/billing-statements endpoint and
 * { page, limit, total, totalPages } shape already used elsewhere on this
 * page. Rentals' Billed also includes "combined" statements (the legacy
 * rent+usage-in-one-document type) since those are rent-bearing too.
 */

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { Loader2, ChevronLeft, ChevronRight, CalendarPlus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import { formatCurrency, formatDate } from "@/lib/utils";
import { ProformaBillingCard } from "@/components/billing/proforma-billing-card";
import { StatementLifecycleBadge } from "@/components/accounting/statement-lifecycle";
import { UsageCurrentCycleCard } from "@/components/billing/usage-current-cycle-card";
import { FinanceGuideCard, GuideReopenButton } from "@/components/finance/finance-guide-card";
import type { UnbilledCategory, UnbilledRow, UnbilledType } from "@/lib/unbilled-queue";

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

const CATEGORY_ORDER: UnbilledCategory[] = ["current_cycle", "supplemental", "rent_gap", "renewal_drift", "no_renewal", "usage_gap"];
const CATEGORY_TITLE: Record<UnbilledCategory, string> = {
  current_cycle: "Current cycle — ready to send",
  rent_gap: "Rent gap",
  renewal_drift: "Renewal drift",
  no_renewal: "No renewal on file",
  usage_gap: "Usage gap — captured but never billed",
  supplemental: "Supplemental — already billed, new charges found",
};
const CATEGORY_BADGE_CLASS: Record<UnbilledCategory, string> = {
  current_cycle: "bg-blue-50 text-blue-900 border-blue-200",
  rent_gap: "bg-amber-50 text-amber-900 border-amber-200",
  renewal_drift: "bg-red-50 text-red-900 border-red-200",
  no_renewal: "bg-slate-100 text-slate-700 border-slate-300",
  usage_gap: "bg-amber-50 text-amber-900 border-amber-200",
  supplemental: "bg-purple-50 text-purple-900 border-purple-200",
};

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
  type: UnbilledType;
  userRole?: string | null;
  onFinalized?: () => void | Promise<void>;
  onViewStatement?: (id: string) => void;
}

const BILLING_ROLES = ["admin", "manager", "accounts"];

export function UnbilledBilledTabs({ type, userRole, onFinalized, onViewStatement }: Props) {
  const [tab, setTab] = useState<"unbilled" | "billed">("unbilled");
  const canBill = !!userRole && BILLING_ROLES.includes(userRole);
  // Matches waive-zero's own server-side gate (same as the statement-level
  // waive-charge route) — narrower than canBill, which also allows accounts.
  const canWaive = !!userRole && ["admin", "manager"].includes(userRole);

  // ── Unbilled ─────────────────────────────────────────────────────────────
  const [unbilledRows, setUnbilledRows] = useState<UnbilledRow[]>([]);
  const [unbilledLoading, setUnbilledLoading] = useState(true);
  const [counts, setCounts] = useState<Record<UnbilledCategory, number>>({
    current_cycle: 0, rent_gap: 0, renewal_drift: 0, no_renewal: 0, usage_gap: 0, supplemental: 0,
  });

  const loadUnbilled = useCallback(async () => {
    setUnbilledLoading(true);
    try {
      const res = await fetch(`/api/billing/unbilled?type=${type}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to load");
      setUnbilledRows(json.data || []);
      setCounts(json.counts || { current_cycle: 0, rent_gap: 0, renewal_drift: 0, no_renewal: 0, usage_gap: 0, supplemental: 0 });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to load unbilled queue");
    } finally {
      setUnbilledLoading(false);
    }
  }, [type]);

  useEffect(() => { loadUnbilled(); }, [loadUnbilled]);

  // ── Generate supplemental (usage only) ──────────────────────────────────
  // Usage drafts never auto-dispatch to a client (unlike rent's Run & Send),
  // so this runs directly on click — no separate preview/confirm dialog,
  // consistent with the low-stakes-until-Finalize nature of every usage draft.
  const [generatingSupplementKey, setGeneratingSupplementKey] = useState<string | null>(null);
  const generateSupplemental = async (row: UnbilledRow) => {
    if (!row.supplementTarget) return;
    setGeneratingSupplementKey(row.id);
    try {
      const res = await fetch("/api/billing/auto-generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dry_run: false, mode: "usage", contract_id: row.contractId, ...row.supplementTarget }),
      });
      const json = await res.json();
      if (!res.ok) { toast.error(json.error || "Failed to generate supplemental statement"); return; }
      const generated = json.usage_statements?.generated ?? 0;
      if (generated > 0) {
        toast.success(`Supplemental statement created — supplements ${row.supplementsStatementNumber}`);
      } else {
        toast.info("Nothing to generate — it may already exist");
      }
      await loadUnbilled();
      if (onFinalized) await onFinalized();
    } catch {
      toast.error("Failed to generate supplemental statement");
    } finally {
      setGeneratingSupplementKey(null);
    }
  };

  // ── Waive a zero-amount usage gap (usage only) ──────────────────────────
  // Same low-stakes reasoning as generateSupplemental above — nothing is
  // being billed here, so no confirm dialog: it just flips the underlying
  // complimentary charge(s) from pending to waived.
  const [waivingKey, setWaivingKey] = useState<string | null>(null);
  const waiveZeroCharge = async (row: UnbilledRow) => {
    if (!row.waiveTarget) return;
    setWaivingKey(row.id);
    try {
      const res = await fetch("/api/usage-charges/waive-zero", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contract_id: row.contractId, ...row.waiveTarget }),
      });
      const json = await res.json();
      if (!res.ok) { toast.error(json.error || "Failed to waive"); return; }
      toast.success(json.waived === 1 ? "Charge waived" : `${json.waived} charges waived`);
      await loadUnbilled();
      if (onFinalized) await onFinalized();
    } catch {
      toast.error("Failed to waive");
    } finally {
      setWaivingKey(null);
    }
  };

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
  // Usage bills in arrears instead: the last FULLY-CLOSED month, matching
  // generateUsageStatements' own default and getCurrentCycleReady()'s window
  // in unbilled-queue.ts, so a freshly-generated draft immediately shows up
  // under "Current cycle — ready to send" instead of falling outside the
  // window it's being checked against.
  const nowIst = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  const opsMonth = nowIst.getUTCMonth() + 1;
  const opsYear = nowIst.getUTCFullYear();
  const nextMonth = opsMonth === 12 ? 1 : opsMonth + 1;
  const nextYear = opsMonth === 12 ? opsYear + 1 : opsYear;
  const closedMonth = opsMonth === 1 ? 12 : opsMonth - 1;
  const closedYear = opsMonth === 1 ? opsYear - 1 : opsYear;

  const totalUnbilled = Object.values(counts).reduce((s, n) => s + n, 0);

  const rowsByCategory = (cat: UnbilledCategory) => unbilledRows.filter((r) => r.category === cat);

  return (
    <div className="space-y-4">
      {type === "rent" ? (
        <ProformaBillingCard
          mode="rent"
          periodLabel={monthLabel(nextYear, nextMonth)}
          month={opsMonth}
          year={opsYear}
          onSuccess={async () => { await Promise.all([loadUnbilled(), loadBilled()]); if (onFinalized) await onFinalized(); }}
        />
      ) : (
        <ProformaBillingCard
          mode="usage"
          periodLabel={`${monthLabel(closedYear, closedMonth)} (closed)`}
          month={closedMonth}
          year={closedYear}
          pendingDraftsCount={counts.current_cycle}
          onSuccess={async () => { await Promise.all([loadUnbilled(), loadBilled()]); if (onFinalized) await onFinalized(); }}
        />
      )}

      {type === "usage" && (
        <FinanceGuideCard
          guideKey="usage-review-worklist"
          accentColor="blue"
          title="Reviewing a usage draft — how this works"
          subtitle="Each row under Current cycle is one contract's usage statement for the closed month, ready for you to review before it goes out."
          steps={[
            { number: 1, title: "Expand a row", description: "See every charge for that contract — print, facility, ad-hoc, all mixed together." },
            { number: 2, title: "Waive or add a charge", description: "Waive anything that shouldn't be billed, or + Add Charge for anything missing. The total updates live." },
            { number: 3, title: "Preview invoice & email", description: "Before you commit, see exactly what the customer will get — same PDF, same email." },
            { number: 4, title: "Confirm & Send", description: "This is real. It emails the customer a payment link and can't be undone from here." },
          ]}
          tip="Only ad-hoc/print charges can be waived — facility and booking usage are locked in once the draft is generated."
        />
      )}

      <div className="flex items-center justify-between gap-2 border-b pb-3">
        <div className="flex items-center gap-2">
          <button
            onClick={() => setTab("unbilled")}
            className={`px-4 py-2 rounded-lg text-sm font-semibold border transition-all ${tab === "unbilled" ? "bg-teal-700 text-white border-teal-700 shadow-sm" : "bg-white text-gray-700 border-gray-300 hover:border-teal-500"}`}
          >
            Unbilled <span className="ml-1 opacity-80">({totalUnbilled})</span>
          </button>
          <button
            onClick={() => setTab("billed")}
            className={`px-4 py-2 rounded-lg text-sm font-semibold border transition-all ${tab === "billed" ? "bg-teal-700 text-white border-teal-700 shadow-sm" : "bg-white text-gray-700 border-gray-300 hover:border-teal-500"}`}
          >
            Billed
          </button>
        </div>
        {type === "usage" && <GuideReopenButton guideKey="usage-review-worklist" label="How this works" />}
      </div>

      {tab === "unbilled" && (
        <div className="space-y-5">
          {unbilledLoading ? (
            <div className="flex justify-center py-10"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
          ) : totalUnbilled === 0 ? (
            <p className="text-sm text-muted-foreground py-6 text-center">Nothing outstanding — every contract is current.</p>
          ) : (
            CATEGORY_ORDER.map((cat) => {
              const rows = rowsByCategory(cat);
              if (rows.length === 0) return null;
              return (
                <div key={cat} className="space-y-2">
                  <div className="flex items-center gap-2">
                    <Badge className={`${CATEGORY_BADGE_CLASS[cat]} text-[11px]`}>{CATEGORY_TITLE[cat]}</Badge>
                    <span className="text-xs text-muted-foreground">{rows.length}</span>
                  </div>
                  <div className={cat === "current_cycle" && type === "usage" ? "rounded-md border" : "rounded-md border divide-y"}>
                    {cat === "current_cycle" && type === "usage" ? (
                      rows.map((row) => (
                        <UsageCurrentCycleCard
                          key={row.id}
                          row={row}
                          canBill={canBill}
                          onSent={async () => { await loadUnbilled(); if (onFinalized) await onFinalized(); }}
                        />
                      ))
                    ) : (
                      rows.map((row) => (
                        <div key={row.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                          <div className="min-w-0">
                            <p className="text-sm font-medium truncate">
                              <span className="font-mono text-xs text-teal-700">{row.contractNumber}</span>
                              {" → "}{row.customerName}
                            </p>
                            <p className="text-xs text-muted-foreground mt-0.5">
                              {row.periodLabel}
                              {row.detail ? <span className="ml-1.5">· {row.detail}</span> : null}
                            </p>
                          </div>
                          <div className="flex items-center gap-3 shrink-0">
                            <span className="text-sm font-mono">
                              {row.amount != null ? formatCurrency(row.amount) : <span className="text-xs italic text-muted-foreground">unknown</span>}
                            </span>
                            <Link href={`/contracts/${row.contractId}`} className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-2">
                              Open contract
                            </Link>
                            {row.supplementTarget && (
                              <button
                                onClick={() => generateSupplemental(row)}
                                disabled={generatingSupplementKey === row.id}
                                className="inline-flex items-center gap-1 rounded-md bg-purple-700 px-2.5 py-1 text-xs font-semibold text-white hover:bg-purple-800 disabled:opacity-60"
                              >
                                {generatingSupplementKey === row.id && <Loader2 className="h-3 w-3 animate-spin" />}
                                Generate supplemental
                              </button>
                            )}
                            {row.backfillTarget && canBill && (
                              <button
                                onClick={() => openBackfillDialog(row)}
                                className="text-xs font-semibold text-teal-700 hover:text-teal-900 underline underline-offset-2"
                              >
                                Send invoice
                              </button>
                            )}
                            {row.waiveTarget && canWaive && (
                              <button
                                onClick={() => waiveZeroCharge(row)}
                                disabled={waivingKey === row.id}
                                className="inline-flex items-center gap-1 rounded-md bg-slate-700 px-2.5 py-1 text-xs font-semibold text-white hover:bg-slate-800 disabled:opacity-60"
                              >
                                {waivingKey === row.id && <Loader2 className="h-3 w-3 animate-spin" />}
                                Waive
                              </button>
                            )}
                            {row.statementId && onViewStatement && (
                              <button
                                onClick={() => onViewStatement(row.statementId!)}
                                className="text-xs font-semibold text-teal-700 hover:text-teal-900 underline underline-offset-2"
                              >
                                Open statement
                              </button>
                            )}
                          </div>
                        </div>
                      ))
                    )}
                  </div>
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
                  <span className="font-mono text-xs text-teal-700">{backfillRow.contractNumber}</span> → {backfillRow.customerName}: this contract&rsquo;s renewal hasn&rsquo;t been activated yet, and {backfillRow.periodLabel.split(" · ")[0]} never got a rent statement. Raises that missed month&rsquo;s rent proforma at the renewal&rsquo;s terms. Sending it creates the payment link and emails the client.
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
    </div>
  );
}
