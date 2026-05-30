"use client";

/**
 * Monthly Billing Tabs — focused per-month workflow for the /billing page.
 *
 * Single mental model: the month picker = the "operations month" (the
 * calendar month you are doing the billing IN).
 *
 *   Rent tab   — shows the advance rent PIs being sent IN this month
 *                (= statements where period_start is in the NEXT month).
 *                e.g. May toggle → June advance rent PIs.
 *                Batch Preview → Run & Send (one click for all contracts).
 *
 *   Usage tab  — shows each contract that had usage IN this month.
 *                One row per contract with usage rolled up. Operator
 *                expands the row to review line items (free quota at ₹0,
 *                paid items at actuals), then clicks Verify & Send to
 *                finalize + dispatch the proforma in one step.
 *
 * Status badges per Usage row:
 *   PENDING  — usage exists, no statement yet
 *   DRAFT    — statement created (e.g. by batch Generate Drafts) but
 *              not yet finalized + sent
 *   SENT     — proforma dispatched to customer
 *   PAID     — payment received
 */

import { useState, useEffect, useCallback, useMemo } from "react";
import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Loader2, Send, FileDown, ChevronDown, ChevronRight } from "lucide-react";
import { toast } from "sonner";
import { formatCurrency, formatDate } from "@/lib/utils";
import { ProformaBillingCard } from "@/components/billing/proforma-billing-card";

interface Lead { email?: string; phone?: string; mobile?: string; company?: string; first_name?: string; last_name?: string; }

interface RentStmt {
  id: string; statement_number: string; status: string;
  period_start: string; period_end: string; due_date: string | null;
  total_amount: number; payment_status: string | null;
  proforma_sent_at: string | null; razorpay_payment_link_url: string | null;
  voided_at: string | null;
  contract?: { id: string; contract_number: string };
  /** /api/billing-statements joins the lead directly on the statement (not
   *  nested under contract). Use this for customer display. */
  lead?: Lead;
}

interface LineItem { description: string; amount: number; source: "ad_hoc" | "service" }
interface UsageRow {
  contract_id: string;
  contract_number: string;
  customer: string;
  free_count: number;
  paid_count: number;
  paid_total: number;
  line_items: LineItem[];
  statement: {
    id: string;
    statement_number: string;
    status: string;
    payment_status: string | null;
    proforma_sent_at: string | null;
    total_amount: number;
    due_date: string | null;
  } | null;
}

function monthLabel(year: number, month: number): string {
  return new Date(Date.UTC(year, month - 1, 1)).toLocaleDateString("en-IN", { timeZone: "UTC", month: "long", year: "numeric" });
}

/** Next calendar month (handles December → January). */
function nextMonth(year: number, month: number): { year: number; month: number } {
  return month === 12 ? { year: year + 1, month: 1 } : { year, month: month + 1 };
}

interface Props {
  /** Page-level <MonthPicker /> is the single source of truth. */
  year: number;
  month: number; // 1-12
  /** Refresh AR aging / summary widgets after a successful send. */
  onFinalized?: () => void | Promise<void>;
}

export function MonthlyBillingTabs({ year, month, onFinalized }: Props) {
  const [tab, setTab] = useState<"rent" | "usage">("rent");

  // ── Data ────────────────────────────────────────────────────────────────
  const [rentStmts, setRentStmts] = useState<RentStmt[]>([]);
  const [rentLoading, setRentLoading] = useState(true);

  const [usageRows, setUsageRows] = useState<UsageRow[]>([]);
  const [usageLoading, setUsageLoading] = useState(true);
  const [expandedContract, setExpandedContract] = useState<string | null>(null);
  const [sendingContract, setSendingContract] = useState<string | null>(null);

  // Operations month = `month`. Rent we're sending in this month covers next month.
  const rentPeriodMonth = useMemo(() => nextMonth(year, month), [year, month]);

  const opsLabel  = monthLabel(year, month);
  const rentLabel = monthLabel(rentPeriodMonth.year, rentPeriodMonth.month);

  const loadRent = useCallback(async () => {
    setRentLoading(true);
    try {
      const start = `${rentPeriodMonth.year}-${String(rentPeriodMonth.month).padStart(2, "0")}-01`;
      const lastDay = new Date(rentPeriodMonth.year, rentPeriodMonth.month, 0).getDate();
      const end   = `${rentPeriodMonth.year}-${String(rentPeriodMonth.month).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
      const res = await fetch(`/api/billing-statements?statement_type=rent&period_start_from=${start}&period_start_to=${end}&limit=500`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed");
      // The API may not have period_start filter — fall back to client-side filter just in case.
      const rows: RentStmt[] = (json.data || []).filter((s: RentStmt) =>
        !s.voided_at && s.period_start >= start && s.period_start <= end,
      );
      setRentStmts(rows);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to load rent statements");
    } finally {
      setRentLoading(false);
    }
  }, [rentPeriodMonth.year, rentPeriodMonth.month]);

  const loadUsage = useCallback(async () => {
    setUsageLoading(true);
    try {
      const res = await fetch(`/api/billing/usage-rollup?year=${year}&month=${month}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed");
      setUsageRows(json.rows || []);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to load usage");
    } finally {
      setUsageLoading(false);
    }
  }, [year, month]);

  useEffect(() => { loadRent(); }, [loadRent]);
  useEffect(() => { loadUsage(); }, [loadUsage]);

  // ── Counts ─────────────────────────────────────────────────────────────
  const rentCounts = {
    sent: rentStmts.filter((s) => !!s.proforma_sent_at).length,
    pending: rentStmts.filter((s) => s.status === "draft" && !s.proforma_sent_at).length,
  };
  const usageCounts = {
    sent: usageRows.filter((r) => !!r.statement?.proforma_sent_at).length,
    pending: usageRows.filter((r) => !r.statement?.proforma_sent_at).length,
  };

  // ── Usage: Verify & Send for a single contract ─────────────────────────
  const verifyAndSend = async (row: UsageRow) => {
    const amount = formatCurrency(row.statement?.total_amount || row.paid_total);
    if (!confirm(
      `Verify & Send usage proforma for ${row.contract_number} (${row.customer})?\n\n` +
      `${row.paid_count} paid items · ${row.free_count} free items · Total ${amount}\n\n` +
      `Due date will be set to today + 7 days. Proforma will be emailed (and WhatsApped if a phone is on file).`
    )) return;
    setSendingContract(row.contract_id);
    try {
      const res = await fetch("/api/billing/usage-finalize-and-send-for-contract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contract_id: row.contract_id, year, month }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed");
      toast.success(
        json.no_contact
          ? "Finalized — but customer has no contact info; proforma was NOT sent"
          : `Sent to ${json.emailed_to || "customer"}. Due ${formatDate(json.due_date)}.`,
      );
      await loadUsage();
      if (onFinalized) await onFinalized();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to send");
    } finally {
      setSendingContract(null);
    }
  };

  // ── Render ─────────────────────────────────────────────────────────────
  return (
    <div className="space-y-4">
      {/* Scope label + tab toggle */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 border-b pb-3">
        <div>
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Billing operations for</p>
          <p className="text-sm font-semibold">
            {opsLabel}
            <span className="text-muted-foreground font-normal"> — change month at the top of the page</span>
          </p>
        </div>
        <div className="flex gap-2">
          <Pill label="Rent"  counts={rentCounts}  active={tab === "rent"}  onClick={() => setTab("rent")}  />
          <Pill label="Usage" counts={usageCounts} active={tab === "usage"} onClick={() => setTab("usage")} />
        </div>
      </div>

      {/* ── Rent tab ──────────────────────────────────────────────────────── */}
      {tab === "rent" && (
        <div className="space-y-3">
          <div className="rounded-md bg-blue-50 border border-blue-200 px-4 py-2 text-xs text-blue-900">
            Rent is collected <strong>in advance</strong>. Running this in <strong>{opsLabel}</strong> sends PIs to all contract customers for <strong>{rentLabel}</strong> rent.
          </div>
          <ProformaBillingCard
            mode="rent"
            periodLabel={rentLabel}
            onSuccess={async () => { await loadRent(); if (onFinalized) await onFinalized(); }}
          />
          <RentTable rows={rentStmts} loading={rentLoading} opsLabel={opsLabel} />
        </div>
      )}

      {/* ── Usage tab ─────────────────────────────────────────────────────── */}
      {tab === "usage" && (
        <div className="space-y-3">
          <div className="rounded-md bg-amber-50 border border-amber-200 px-4 py-2 text-xs text-amber-900">
            Usage charges for <strong>{opsLabel}</strong>. Review each contract&apos;s usage, then click <strong>Verify &amp; Send</strong> to dispatch the proforma. Due date = send date + 7 days.
          </div>
          <UsageTable
            rows={usageRows}
            loading={usageLoading}
            opsLabel={opsLabel}
            expandedContract={expandedContract}
            onToggleExpand={(id) => setExpandedContract((prev) => (prev === id ? null : id))}
            onVerifyAndSend={verifyAndSend}
            sendingContract={sendingContract}
          />
        </div>
      )}
    </div>
  );
}

function Pill({ label, counts, active, onClick }: { label: string; counts: { sent: number; pending: number }; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`px-4 py-2 rounded-lg text-sm font-semibold border transition-all ${active ? "bg-teal-700 text-white border-teal-700 shadow-sm" : "bg-white text-gray-700 border-gray-300 hover:border-teal-500"}`}
    >
      <div className="text-left">
        <div>{label}</div>
        <div className={`text-[10px] font-normal mt-0.5 ${active ? "text-teal-50" : "text-muted-foreground"}`}>
          {counts.sent} sent · {counts.pending} pending
        </div>
      </div>
    </button>
  );
}

function RentTable({ rows, loading, opsLabel }: { rows: RentStmt[]; loading: boolean; opsLabel: string }) {
  const sorted = useMemo(() => {
    return [...rows].sort((a, b) => (a.contract?.contract_number || "").localeCompare(b.contract?.contract_number || ""));
  }, [rows]);

  if (loading) return <Card><CardContent className="p-6 text-center text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin inline mr-2" />Loading…</CardContent></Card>;
  if (sorted.length === 0) return <Card><CardContent className="p-8 text-center text-sm text-muted-foreground">No rent PIs dispatched in {opsLabel} yet. Run the batch above when ready.</CardContent></Card>;

  return (
    <Card>
      <CardContent className="p-0">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-xs uppercase text-gray-600 border-b">
              <tr>
                <th className="px-4 py-3 text-left">Contract / Customer</th>
                <th className="px-4 py-3 text-left">Statement #</th>
                <th className="px-4 py-3 text-left">Rent period</th>
                <th className="px-4 py-3 text-left">Status</th>
                <th className="px-4 py-3 text-left">Due</th>
                <th className="px-4 py-3 text-right">Amount</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {sorted.map((s) => {
                const isPaid = s.payment_status === "paid";
                const isSent = !!s.proforma_sent_at;
                // /api/billing-statements joins lead directly on the statement,
                // not under contract — use s.lead.
                const lead = s.lead;
                const customer = lead?.company || `${lead?.first_name || ""} ${lead?.last_name || ""}`.trim() || "—";
                return (
                  <tr key={s.id}>
                    <td className="px-4 py-3">
                      <Link href={`/contracts/${s.contract?.id}`} className="font-medium text-teal-700 hover:underline">{s.contract?.contract_number || "—"}</Link>
                      <div className="text-xs text-muted-foreground">{customer}</div>
                    </td>
                    <td className="px-4 py-3">
                      <Link href={`/api/billing-statements/${s.id}/proforma-pdf`} target="_blank" className="text-teal-700 hover:underline font-mono text-xs flex items-center gap-1">
                        {s.statement_number}<FileDown className="h-3 w-3" />
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-xs whitespace-nowrap text-muted-foreground">{formatDate(s.period_start)} → {formatDate(s.period_end)}</td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      {isPaid ? <Badge className="bg-emerald-100 text-emerald-800 border-emerald-300 text-[10px]">PAID</Badge>
                        : isSent ? <Badge className="bg-blue-100 text-blue-800 border-blue-300 text-[10px]">SENT</Badge>
                        : <Badge className="bg-amber-100 text-amber-800 border-amber-300 text-[10px]">DRAFT</Badge>}
                    </td>
                    <td className="px-4 py-3 text-xs whitespace-nowrap text-muted-foreground">{s.due_date ? formatDate(s.due_date) : "—"}</td>
                    <td className="px-4 py-3 text-right whitespace-nowrap font-semibold">{formatCurrency(s.total_amount)}</td>
                    <td className="px-4 py-3 whitespace-nowrap text-right">
                      {s.razorpay_payment_link_url && (
                        <a href={s.razorpay_payment_link_url} target="_blank" rel="noreferrer" className="text-xs text-teal-700 hover:underline">Pay link</a>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}

function UsageTable(props: {
  rows: UsageRow[]; loading: boolean; opsLabel: string;
  expandedContract: string | null;
  onToggleExpand: (id: string) => void;
  onVerifyAndSend: (row: UsageRow) => void;
  sendingContract: string | null;
}) {
  const { rows, loading, opsLabel, expandedContract, onToggleExpand, onVerifyAndSend, sendingContract } = props;

  // Pending first (call-to-action), sorted by contract number within group.
  const sorted = useMemo(() => {
    return [...rows].sort((a, b) => {
      const aPending = a.statement?.proforma_sent_at ? 1 : 0;
      const bPending = b.statement?.proforma_sent_at ? 1 : 0;
      if (aPending !== bPending) return aPending - bPending;
      return a.contract_number.localeCompare(b.contract_number);
    });
  }, [rows]);

  if (loading) return <Card><CardContent className="p-6 text-center text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin inline mr-2" />Loading…</CardContent></Card>;
  if (sorted.length === 0) return <Card><CardContent className="p-8 text-center text-sm text-muted-foreground">No usage charges recorded for {opsLabel} on any contract.</CardContent></Card>;

  return (
    <Card>
      <CardContent className="p-0">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-xs uppercase text-gray-600 border-b">
              <tr>
                <th className="px-2 py-3"></th>
                <th className="px-4 py-3 text-left">Contract / Customer</th>
                <th className="px-4 py-3 text-center">Free</th>
                <th className="px-4 py-3 text-center">Paid items</th>
                <th className="px-4 py-3 text-right">Paid total</th>
                <th className="px-4 py-3 text-left">Status</th>
                <th className="px-4 py-3 text-left">Due</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {sorted.map((r) => {
                const expanded = expandedContract === r.contract_id;
                const stmt = r.statement;
                const isSent = !!stmt?.proforma_sent_at;
                const isPaid = stmt?.payment_status === "paid";
                const status = isPaid ? "PAID" : isSent ? "SENT" : (stmt?.status === "draft" ? "DRAFT" : "PENDING");
                const statusClass =
                  status === "PAID"  ? "bg-emerald-100 text-emerald-800 border-emerald-300"
                : status === "SENT"  ? "bg-blue-100    text-blue-800    border-blue-300"
                : status === "DRAFT" ? "bg-amber-100   text-amber-800   border-amber-300"
                :                      "bg-orange-100  text-orange-800  border-orange-300";
                const rowBg = !isSent ? "bg-amber-50/40" : "";

                return (
                  <>
                    <tr key={r.contract_id} className={rowBg}>
                      <td className="px-2 py-3 text-center">
                        <button onClick={() => onToggleExpand(r.contract_id)} className="text-muted-foreground hover:text-foreground">
                          {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                        </button>
                      </td>
                      <td className="px-4 py-3">
                        <div className="font-medium text-teal-700">{r.contract_number}</div>
                        <div className="text-xs text-muted-foreground">{r.customer}</div>
                      </td>
                      <td className="px-4 py-3 text-center text-muted-foreground">{r.free_count > 0 ? r.free_count : "—"}</td>
                      <td className="px-4 py-3 text-center font-medium">{r.paid_count > 0 ? r.paid_count : "—"}</td>
                      <td className="px-4 py-3 text-right font-semibold">{formatCurrency(stmt?.total_amount || r.paid_total)}</td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        <Badge className={`${statusClass} text-[10px]`}>{status}</Badge>
                        {stmt?.statement_number && (
                          <Link href={`/api/billing-statements/${stmt.id}/proforma-pdf`} target="_blank" className="block text-[10px] text-teal-700 hover:underline font-mono mt-1">
                            {stmt.statement_number}
                          </Link>
                        )}
                      </td>
                      <td className="px-4 py-3 text-xs whitespace-nowrap text-muted-foreground">{stmt?.due_date ? formatDate(stmt.due_date) : "—"}</td>
                      <td className="px-4 py-3 whitespace-nowrap text-right">
                        {!isSent && (r.paid_count > 0 || r.free_count > 0) && (
                          <Button
                            size="sm"
                            onClick={() => onVerifyAndSend(r)}
                            disabled={sendingContract === r.contract_id || r.paid_total <= 0}
                            className="bg-teal-700 hover:bg-teal-800"
                            title={r.paid_total <= 0 ? "All charges are free quota — nothing to bill" : undefined}
                          >
                            {sendingContract === r.contract_id
                              ? <><Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />Sending…</>
                              : <><Send className="h-3.5 w-3.5 mr-1" />Verify &amp; Send</>}
                          </Button>
                        )}
                      </td>
                    </tr>
                    {expanded && (() => {
                      // Show ONLY paid items in the expanded view — these are
                      // what will actually be billed in the PI. Free-quota
                      // items are summarised by the `Free` column count on the
                      // main row and not listed here per ops feedback.
                      const paidItems = r.line_items.filter((li) => li.amount > 0);
                      return (
                        <tr className="bg-gray-50/60">
                          <td></td>
                          <td colSpan={7} className="px-4 py-3">
                            {paidItems.length === 0 ? (
                              <p className="text-xs text-muted-foreground italic">
                                {r.free_count > 0
                                  ? `All ${r.free_count} usage item${r.free_count > 1 ? "s" : ""} this month were within free quota — nothing to bill.`
                                  : "No paid items in this month."}
                              </p>
                            ) : (
                              <table className="w-full text-xs">
                                <thead className="text-muted-foreground">
                                  <tr>
                                    <th className="text-left py-1">Description</th>
                                    <th className="text-left py-1">Source</th>
                                    <th className="text-right py-1">Amount</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {paidItems.map((li, i) => (
                                    <tr key={i} className="border-t border-gray-200">
                                      <td className="py-1 pr-4">{li.description}</td>
                                      <td className="py-1 pr-4 text-muted-foreground capitalize">{li.source.replace("_", " ")}</td>
                                      <td className="py-1 text-right font-mono">{formatCurrency(li.amount)}</td>
                                    </tr>
                                  ))}
                                  <tr className="border-t-2 border-gray-300 font-semibold">
                                    <td className="py-1 pr-4">Total to bill</td>
                                    <td></td>
                                    <td className="py-1 text-right font-mono">{formatCurrency(r.paid_total)}</td>
                                  </tr>
                                </tbody>
                              </table>
                            )}
                          </td>
                        </tr>
                      );
                    })()}
                  </>
                );
              })}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}
