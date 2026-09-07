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
import { Loader2, ChevronLeft, ChevronRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { formatCurrency, formatDate } from "@/lib/utils";
import { ProformaBillingCard } from "@/components/billing/proforma-billing-card";
import { StatementLifecycleBadge } from "@/components/accounting/statement-lifecycle";
import type { UnbilledCategory, UnbilledRow, UnbilledType } from "@/lib/unbilled-queue";

const CATEGORY_ORDER: UnbilledCategory[] = ["current_cycle", "rent_gap", "renewal_drift", "no_renewal"];
const CATEGORY_TITLE: Record<UnbilledCategory, string> = {
  current_cycle: "Current cycle — ready to send",
  rent_gap: "Rent gap",
  renewal_drift: "Renewal drift",
  no_renewal: "No renewal on file",
};
const CATEGORY_BADGE_CLASS: Record<UnbilledCategory, string> = {
  current_cycle: "bg-blue-50 text-blue-900 border-blue-200",
  rent_gap: "bg-amber-50 text-amber-900 border-amber-200",
  renewal_drift: "bg-red-50 text-red-900 border-red-200",
  no_renewal: "bg-slate-100 text-slate-700 border-slate-300",
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

export function UnbilledBilledTabs({ type, onFinalized, onViewStatement }: Props) {
  const [tab, setTab] = useState<"unbilled" | "billed">("unbilled");

  // ── Unbilled ─────────────────────────────────────────────────────────────
  const [unbilledRows, setUnbilledRows] = useState<UnbilledRow[]>([]);
  const [unbilledLoading, setUnbilledLoading] = useState(true);
  const [counts, setCounts] = useState<Record<UnbilledCategory, number>>({
    current_cycle: 0, rent_gap: 0, renewal_drift: 0, no_renewal: 0,
  });

  const loadUnbilled = useCallback(async () => {
    setUnbilledLoading(true);
    try {
      const res = await fetch(`/api/billing/unbilled?type=${type}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to load");
      setUnbilledRows(json.data || []);
      setCounts(json.counts || { current_cycle: 0, rent_gap: 0, renewal_drift: 0, no_renewal: 0 });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to load unbilled queue");
    } finally {
      setUnbilledLoading(false);
    }
  }, [type]);

  useEffect(() => { loadUnbilled(); }, [loadUnbilled]);

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

  // Rent bills a month in advance (this ops month -> next month's proforma);
  // usage bills the current cycle itself, matching getCurrentCycleReady()'s
  // window in unbilled-queue.ts so a freshly-generated draft immediately
  // shows up under "Current cycle — ready to send" instead of falling
  // outside the window it's being checked against.
  const nowIst = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  const opsMonth = nowIst.getUTCMonth() + 1;
  const opsYear = nowIst.getUTCFullYear();
  const nextMonth = opsMonth === 12 ? 1 : opsMonth + 1;
  const nextYear = opsMonth === 12 ? opsYear + 1 : opsYear;

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
          onSuccess={async () => { await loadUnbilled(); if (onFinalized) await onFinalized(); }}
        />
      ) : (
        <ProformaBillingCard
          mode="usage"
          periodLabel={monthLabel(opsYear, opsMonth)}
          month={opsMonth}
          year={opsYear}
          pendingDraftsCount={counts.current_cycle}
          onSuccess={async () => { await loadUnbilled(); if (onFinalized) await onFinalized(); }}
        />
      )}

      <div className="flex items-center gap-2 border-b pb-3">
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
                  <div className="rounded-md border divide-y">
                    {rows.map((row) => (
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
                    ))}
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
    </div>
  );
}
