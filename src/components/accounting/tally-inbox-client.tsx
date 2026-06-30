"use client";

/**
 * Client worklist for /accounting/inbox.
 *
 * Fetches GET /api/accounting/inbox once on mount + on manual refresh.
 * Renders:
 *   - 4 stat cards (GST to issue / Payments to record / Discrepancies / Aging >48h)
 *   - Filter tabs (All open / GST / Payments / Discrepancies)
 *   - Worklist rows
 *
 * Upload form lives in PR #2c — rows here are read-only links to the
 * underlying statement detail page.
 */

import { Fragment, useEffect, useMemo, useState, useCallback } from "react";
import { RefreshCw, Inbox as InboxIcon, AlertCircle, Clock, CheckCircle2, FileText, Send, Upload, ChevronDown, ChevronUp, Loader2, FileDown, FileCheck, Check, Search, X, Pencil, CalendarDays, IndianRupee } from "lucide-react";
import { formatCurrency, formatDate } from "@/lib/utils";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  AGING_ESCALATE_HOURS,
  HANDOFF_STATE_LABELS,
  type BookingHandoffState,
  type BookingInboxRow,
  type HandoffBucket,
  type InboxResponse,
  type InboxRow,
} from "@/lib/tally-handoff";
import { TallyInboxUploadForm } from "./tally-inbox-upload-form";
import { BookingGstUploadForm } from "./booking-gst-upload-form";

type FilterTab = "all" | "gst_to_issue" | "payment_to_record" | "discrepancy" | "closed";

const FILTER_TABS: { key: FilterTab; label: string }[] = [
  { key: "all", label: "All open" },
  { key: "gst_to_issue", label: "GST to issue" },
  { key: "payment_to_record", label: "Payments" },
  { key: "discrepancy", label: "Discrepancies" },
  { key: "closed", label: "Closed" },
];

function partyDisplay(row: InboxRow): string {
  const lead = row.contract?.lead;
  if (!lead) return "(unknown party)";
  if (lead.company) return lead.company;
  const name = [lead.first_name, lead.last_name].filter(Boolean).join(" ");
  return name || lead.email || "(unnamed)";
}

function bucketBadgeClass(bucket: HandoffBucket, hasDiscrepancy: boolean): string {
  if (hasDiscrepancy) return "bg-red-50 text-red-900 border-red-200";
  switch (bucket) {
    case "gst_to_issue":
      return "bg-blue-50 text-blue-900 border-blue-200";
    case "payment_to_record":
      return "bg-green-50 text-green-900 border-green-200";
    case "in_flight":
      return "bg-amber-50 text-amber-900 border-amber-200";
    default:
      return "bg-muted text-muted-foreground border-muted-foreground/20";
  }
}

function bucketLabel(bucket: HandoffBucket): string {
  switch (bucket) {
    case "gst_to_issue": return "GST to issue";
    case "payment_to_record": return "Record receipt";
    case "discrepancy": return "Mismatch";
    case "in_flight": return "In flight";
    default: return bucket;
  }
}

function timeAgo(iso: string | null): string {
  if (!iso) return "—";
  const diffMs = Date.now() - Date.parse(iso);
  if (diffMs < 0) return "just now";
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function TallyInboxClient() {
  const [data, setData] = useState<InboxResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<FilterTab>("all");
  const [searchInput, setSearchInput] = useState("");
  const [searchTerm, setSearchTerm] = useState("");
  // Statement row state
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [sendingId, setSendingId] = useState<string | null>(null);
  const [closingId, setClosingId] = useState<string | null>(null);
  const [resendingId, setResendingId] = useState<string | null>(null);
  const [sentConfirmedId, setSentConfirmedId] = useState<string | null>(null);
  // Booking row state
  const [expandedBookingId, setExpandedBookingId] = useState<string | null>(null);
  const [sendingBookingId, setSendingBookingId] = useState<string | null>(null);
  const [closingBookingId, setClosingBookingId] = useState<string | null>(null);
  const [resendingBookingId, setResendingBookingId] = useState<string | null>(null);
  const [sentConfirmedBookingId, setSentConfirmedBookingId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [closedPage, setClosedPage] = useState(1);
  // Record Payment dialog state
  const [payRow, setPayRow] = useState<{ id: string; statement_number: string | null; balance_due: number } | null>(null);
  const [payAmount, setPayAmount] = useState("");
  const [payDate, setPayDate] = useState("");
  const [payMode, setPayMode] = useState("bank_transfer");
  const [payRef, setPayRef] = useState("");
  const [payNotes, setPayNotes] = useState("");
  const [paySubmitting, setPaySubmitting] = useState(false);

  const load = useCallback(async (opts?: { tab?: FilterTab; q?: string; page?: number }) => {
    setLoading(true);
    setError(null);
    try {
      const activeTab = opts?.tab ?? tab;
      const apiTab = activeTab === "closed" ? "closed" : "open";
      const params = new URLSearchParams({ tab: apiTab });
      const qTerm = opts?.q ?? searchTerm;
      if (qTerm) params.set("q", qTerm);
      if (apiTab === "closed") params.set("page", String(opts?.page ?? closedPage));
      const res = await fetch(`/api/accounting/inbox?${params}`, { cache: "no-store" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      const json = (await res.json()) as InboxResponse;
      setData(json);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load inbox");
    } finally {
      setLoading(false);
    }
  }, [tab, searchTerm, closedPage]);

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Refetch when tab or search term changes
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, searchTerm]);

  // Debounce typed search input → searchTerm
  useEffect(() => {
    const handle = setTimeout(() => setSearchTerm(searchInput), 300);
    return () => clearTimeout(handle);
  }, [searchInput]);

  // Honor ?focus=<statement_id> from the URL — used by deep links from
  // other surfaces (View in Tally Inbox button on contract / billing
  // dialog). Scrolls the row into view + briefly highlights it; does NOT
  // auto-expand the upload form (per design Decision #1).
  useEffect(() => {
    if (typeof window === "undefined") return;
    const focusId = new URLSearchParams(window.location.search).get("focus");
    if (!focusId) return;
    // Wait a tick for rows to render after the initial fetch
    const handle = setTimeout(() => {
      const el = document.querySelector<HTMLElement>(`[data-statement-id="${CSS.escape(focusId)}"]`);
      if (!el) return;
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.classList.add("ring-2", "ring-blue-400", "ring-offset-2", "transition-shadow");
      setTimeout(() => el.classList.remove("ring-2", "ring-blue-400", "ring-offset-2"), 2400);
    }, 400);
    return () => clearTimeout(handle);
  }, [data]);

  const handleSend = useCallback(async (statementId: string) => {
    setSendingId(statementId);
    setActionError(null);
    try {
      const res = await fetch(`/api/billing-statements/${statementId}/inbox-send`, { method: "POST" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      await load();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Send failed");
    } finally {
      setSendingId(null);
    }
  }, [load]);

  const handleUploaded = useCallback(async () => {
    setExpandedId(null);
    await load();
  }, [load]);

  const handleClose = useCallback(async (statementId: string) => {
    setClosingId(statementId);
    setActionError(null);
    try {
      const res = await fetch(`/api/billing-statements/${statementId}/inbox-complete`, { method: "POST" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      await load();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Close failed");
    } finally {
      setClosingId(null);
    }
  }, [load]);

  const handleResend = useCallback(async (statementId: string) => {
    setResendingId(statementId);
    setActionError(null);
    setSentConfirmedId(null);
    try {
      const res = await fetch(`/api/billing-statements/${statementId}/resend-gst-invoice`, { method: "POST" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      setSentConfirmedId(statementId);
      await load();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Resend failed");
    } finally {
      setResendingId(null);
    }
  }, [load]);

  const openPayDialog = useCallback((row: InboxRow) => {
    const balance = Math.max(0, row.statement_total_amount - (row.total_paid ?? 0));
    setPayRow({ id: row.statement_id, statement_number: row.statement_number, balance_due: balance });
    setPayAmount(String(balance));
    setPayDate(new Date().toISOString().slice(0, 10));
    setPayMode("bank_transfer");
    setPayRef("");
    setPayNotes("");
  }, []);

  const submitPayment = useCallback(async () => {
    if (!payRow) return;
    const amt = parseFloat(payAmount);
    if (!amt || amt <= 0) { setActionError("Enter a valid amount"); return; }
    setPaySubmitting(true);
    setActionError(null);
    try {
      const res = await fetch(`/api/billing-statements/${payRow.id}/payment`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount: amt, payment_date: payDate, payment_mode: payMode, payment_reference: payRef || null, notes: payNotes || null }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed");
      setPayRow(null);
      await load();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Failed to record payment");
    } finally {
      setPaySubmitting(false);
    }
  }, [payRow, payAmount, payDate, payMode, payRef, payNotes, load]);

  const handleAccounted = useCallback(async (statementId: string) => {
    setClosingId(statementId);
    setActionError(null);
    try {
      const res = await fetch(`/api/billing-statements/${statementId}/inbox-complete`, { method: "POST" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      await load();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Failed");
    } finally {
      setClosingId(null);
    }
  }, [load]);

  const handleBookingSend = useCallback(async (taskId: string) => {
    setSendingBookingId(taskId);
    setActionError(null);
    try {
      const res = await fetch(`/api/booking-gst-tasks/${taskId}/inbox-send`, { method: "POST" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      await load();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Send failed");
    } finally {
      setSendingBookingId(null);
    }
  }, [load]);

  const handleBookingClose = useCallback(async (taskId: string) => {
    setClosingBookingId(taskId);
    setActionError(null);
    try {
      const res = await fetch(`/api/booking-gst-tasks/${taskId}/inbox-complete`, { method: "POST" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      await load();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Close failed");
    } finally {
      setClosingBookingId(null);
    }
  }, [load]);

  const handleBookingResend = useCallback(async (taskId: string) => {
    setResendingBookingId(taskId);
    setActionError(null);
    setSentConfirmedBookingId(null);
    try {
      const res = await fetch(`/api/booking-gst-tasks/${taskId}/inbox-send`, { method: "POST" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      setSentConfirmedBookingId(taskId);
      await load();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Resend failed");
    } finally {
      setResendingBookingId(null);
    }
  }, [load]);

  const visibleRows = useMemo(() => {
    if (!data) return [];
    if (tab === "all" || tab === "closed") return data.rows;
    if (tab === "discrepancy") return data.rows.filter((r) => r.has_discrepancy);
    return data.rows.filter((r) => r.bucket === tab && !r.has_discrepancy);
  }, [data, tab]);

  const visibleBookingRows = useMemo(() => {
    if (!data?.booking_rows) return [];
    const br = data.booking_rows;
    if (tab === "closed") return br.filter((r) => r.handoff_state === "complete");
    if (tab === "all") return br.filter((r) => r.handoff_state !== "complete");
    if (tab === "discrepancy") return br.filter((r) => r.has_discrepancy && r.handoff_state !== "complete");
    if (tab === "gst_to_issue") return br.filter((r) => r.bucket === "gst_to_issue" && !r.has_discrepancy && r.handoff_state !== "complete");
    return [];
  }, [data, tab]);

  return (
    <div className="space-y-4">
      {/* Header row */}
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>
          Bridge last synced: <strong>{data?.last_synced_at ? timeAgo(data.last_synced_at) : "not yet"}</strong>
        </span>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="inline-flex items-center gap-1 rounded-md border px-2 py-1 hover:bg-muted transition-colors disabled:opacity-50"
          aria-label="Refresh"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} aria-hidden />
          Refresh
        </button>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard label="GST to issue" value={data?.stats.gst_to_issue ?? 0} icon={FileText} />
        <StatCard label="Payments to record" value={data?.stats.payments_to_record ?? 0} icon={CheckCircle2} />
        <StatCard label="Discrepancies" value={data?.stats.discrepancies ?? 0} icon={AlertCircle} variant="danger" />
        <StatCard label={`Aging > ${AGING_ESCALATE_HOURS}h`} value={data?.stats.aging_over_48h ?? 0} icon={Clock} variant="warning" />
      </div>

      {/* Filter tabs + search */}
      <div className="border-b flex items-center gap-1 flex-wrap">
        {FILTER_TABS.map((t) => {
          // Counts are tab-aware: open tabs reflect the OPEN summary; the
          // Closed tab can't sensibly show a global count, so it shows the
          // page-size result only when we're on it.
          const count =
            t.key === "all" ? data?.stats.total_open
            : t.key === "gst_to_issue" ? data?.stats.gst_to_issue
            : t.key === "payment_to_record" ? data?.stats.payments_to_record
            : t.key === "discrepancy" ? data?.stats.discrepancies
            : t.key === "closed" && tab === "closed" ? data?.rows.length
            : undefined;
          const active = tab === t.key;
          return (
            <button
              key={t.key}
              type="button"
              onClick={() => {
                setTab(t.key);
                setClosedPage(1);
              }}
              className={`px-3 py-2 text-sm border-b-2 -mb-px transition-colors ${
                active
                  ? "border-foreground font-medium text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              {t.label}
              {count !== undefined && (
                <span className="text-xs text-muted-foreground ml-1">({count})</span>
              )}
            </button>
          );
        })}

        {/* Search — visible on all tabs but most useful on Closed */}
        <div className="ml-auto relative">
          <Search className="h-3.5 w-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <input
            type="text"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search customer, invoice #, GSTIN…"
            className="text-xs rounded-md border pl-7 pr-7 py-1.5 w-64 focus:outline-none focus:ring-1 focus:ring-foreground/20"
          />
          {searchInput && (
            <button
              type="button"
              onClick={() => setSearchInput("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              aria-label="Clear search"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Worklist */}
      {error ? (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-900">
          <p className="font-medium">Failed to load inbox</p>
          <p className="mt-1">{error}</p>
        </div>
      ) : loading && !data ? (
        <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
          Loading inbox…
        </div>
      ) : visibleRows.length === 0 && visibleBookingRows.length === 0 ? (
        <EmptyState tab={tab} totalOpen={data?.stats.total_open ?? 0} />
      ) : (
        <>
          {actionError && (
            <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-900 flex items-start gap-2">
              <AlertCircle className="h-4 w-4 mt-0.5 flex-shrink-0" aria-hidden />
              <span>{actionError}</span>
            </div>
          )}
          <ul className="rounded-lg border overflow-hidden divide-y" role="list">
            {visibleRows.map((row) => (
              <InboxRowItem
                key={row.statement_id}
                row={row}
                expanded={expandedId === row.statement_id}
                sending={sendingId === row.statement_id}
                closing={closingId === row.statement_id}
                resending={resendingId === row.statement_id}
                sentConfirmed={sentConfirmedId === row.statement_id}
                onToggle={() => setExpandedId(expandedId === row.statement_id ? null : row.statement_id)}
                onSend={() => handleSend(row.statement_id)}
                onClose={() => handleAccounted(row.statement_id)}
                onResend={() => handleResend(row.statement_id)}
                onUploaded={handleUploaded}
                onCancelUpload={() => setExpandedId(null)}
                onGstinUpdated={() => void load()}
                onRecordPayment={() => openPayDialog(row)}
              />
            ))}
            {visibleBookingRows.map((row) => (
              <BookingInboxRowItem
                key={row.task_id}
                row={row}
                expanded={expandedBookingId === row.task_id}
                sending={sendingBookingId === row.task_id}
                closing={closingBookingId === row.task_id}
                resending={resendingBookingId === row.task_id}
                sentConfirmed={sentConfirmedBookingId === row.task_id}
                onToggle={() => setExpandedBookingId(expandedBookingId === row.task_id ? null : row.task_id)}
                onSend={() => handleBookingSend(row.task_id)}
                onClose={() => handleBookingClose(row.task_id)}
                onResend={() => handleBookingResend(row.task_id)}
                onUploaded={handleUploaded}
                onCancelUpload={() => setExpandedBookingId(null)}
              />
            ))}
          </ul>
          {tab === "closed" && (
            <div className="flex items-center justify-between pt-2 text-xs text-muted-foreground">
              <span>Page {closedPage} · {visibleRows.length} records</span>
              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={closedPage === 1 || loading}
                  onClick={() => {
                    const p = closedPage - 1;
                    setClosedPage(p);
                    void load({ page: p });
                  }}
                  className="px-2 py-1 rounded border hover:bg-muted disabled:opacity-40"
                >
                  ← Prev
                </button>
                <button
                  type="button"
                  disabled={!data?.has_more || loading}
                  onClick={() => {
                    const p = closedPage + 1;
                    setClosedPage(p);
                    void load({ page: p });
                  }}
                  className="px-2 py-1 rounded border hover:bg-muted disabled:opacity-40"
                >
                  Next →
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {/* ── Record Payment dialog ── */}
      <Dialog open={!!payRow} onOpenChange={(o) => !o && setPayRow(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Record Payment — {payRow?.statement_number}</DialogTitle>
          </DialogHeader>
          {payRow && (
            <div className="space-y-3">
              <div className="text-sm text-muted-foreground">
                Balance due: <strong className="text-foreground">{formatCurrency(payRow.balance_due)}</strong>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>Amount (₹)</Label>
                  <Input type="number" value={payAmount} onChange={(e) => setPayAmount(e.target.value)} />
                </div>
                <div>
                  <Label>Payment date</Label>
                  <Input type="date" value={payDate} onChange={(e) => setPayDate(e.target.value)} />
                </div>
              </div>
              <div>
                <Label>Payment mode</Label>
                <Select value={payMode} onValueChange={setPayMode}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="bank_transfer">Bank transfer / NEFT / RTGS</SelectItem>
                    <SelectItem value="upi">UPI</SelectItem>
                    <SelectItem value="cheque">Cheque</SelectItem>
                    <SelectItem value="cash">Cash</SelectItem>
                    <SelectItem value="razorpay">Razorpay (manually reconciled)</SelectItem>
                    <SelectItem value="other">Other</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Reference (UTR / cheque # / txn id)</Label>
                <Input value={payRef} onChange={(e) => setPayRef(e.target.value)} placeholder="optional" />
              </div>
              <div>
                <Label>Notes</Label>
                <Input value={payNotes} onChange={(e) => setPayNotes(e.target.value)} placeholder="optional" />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setPayRow(null)} disabled={paySubmitting}>Cancel</Button>
            <Button onClick={() => void submitPayment()} disabled={paySubmitting}>
              {paySubmitting ? <><Loader2 className="h-4 w-4 animate-spin mr-2" />Recording…</> : "Record payment"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function StatCard({
  label,
  value,
  icon: Icon,
  variant,
}: {
  label: string;
  value: number;
  icon: React.ComponentType<{ className?: string }>;
  variant?: "danger" | "warning";
}) {
  const valueClass =
    variant === "danger" ? "text-red-700" : variant === "warning" ? "text-amber-700" : "text-foreground";
  return (
    <div className="rounded-lg bg-muted/40 border p-3">
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>{label}</span>
        <Icon className="h-3.5 w-3.5" aria-hidden />
      </div>
      <div className={`text-2xl font-semibold mt-1 ${valueClass}`}>{value}</div>
    </div>
  );
}

function EmptyState({ tab, totalOpen }: { tab: FilterTab; totalOpen: number }) {
  if (totalOpen === 0) {
    return (
      <div className="rounded-lg border border-dashed p-10 text-center">
        <InboxIcon className="h-8 w-8 text-muted-foreground mx-auto mb-2" aria-hidden />
        <p className="text-sm font-medium">Inbox is empty</p>
        <p className="text-xs text-muted-foreground mt-1">
          New items appear here when a PI is paid, a direct GST invoice is requested,
          or a customer pays via Razorpay link. Use the Upload button on each row
          to attach the Tally invoice, then Save &amp; send.
        </p>
      </div>
    );
  }
  return (
    <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
      No items in the <strong>{FILTER_TABS.find((t) => t.key === tab)?.label}</strong> filter.
    </div>
  );
}

// ── Lifecycle tracker ──────────────────────────────────────────────────────

type StepStatus = "done" | "current" | "pending";

interface TrackerStep {
  label: string;
  status: StepStatus;
}

function buildSteps(labels: string[], doneFlags: boolean[]): TrackerStep[] {
  return labels.map((label, i) => {
    if (doneFlags[i]) return { label, status: "done" };
    if (i === 0 || doneFlags[i - 1]) return { label, status: "current" };
    return { label, status: "pending" };
  });
}

function InboxRowLifecycleTracker({ row }: { row: InboxRow }) {
  const state = row.handoff_state;
  const paid = row.payment_status === "paid";
  const isComplete = state === "complete";
  const billingMode = row.contract?.billing_mode;

  const inStates = (...ss: string[]) => !!state && ss.includes(state);

  let steps: TrackerStep[];

  if (billingMode === "gst_direct") {
    // Flow 3: GST Direct — customer was never sent a proforma; GST invoice + payment link together
    const gstReady  = inStates("ready_to_send", "gst_sent", "gst_sent_awaiting_payment", "paid_awaiting_receipt_record", "complete");
    const linkSent  = inStates("gst_sent", "gst_sent_awaiting_payment", "paid_awaiting_receipt_record", "complete") || paid;
    const pmtDone   = paid || inStates("paid_awaiting_receipt_record", "complete");
    steps = buildSteps(
      ["GST\nRequested", "GST in\nTally", "Invoice +\nLink Sent", "Collect\nPayment", "Done"],
      [true, gstReady, linkSent, pmtDone, isComplete],
    );
  } else if (row.pi_was_cancelled) {
    // Flow 2: Override — PI was cancelled early so GST invoice is issued before payment
    const gstReady  = inStates("ready_to_send", "gst_sent_awaiting_payment", "paid_awaiting_receipt_record", "complete");
    const emailSent = inStates("gst_sent_awaiting_payment", "paid_awaiting_receipt_record", "complete");
    const pmtDone   = paid || inStates("paid_awaiting_receipt_record", "complete");
    steps = buildSteps(
      ["PI\nCancelled", "GST in\nTally", "Link +\nEmail Sent", "Collect\nPayment", "Done"],
      [true, gstReady, emailSent, pmtDone, isComplete],
    );
  } else {
    // Flow 1: PI-first — payment received before GST invoice is uploaded
    const pmtDone      = paid || inStates("pi_paid_awaiting_gst", "name_check_pending", "ready_to_send", "gst_sent", "paid_awaiting_receipt_record", "complete");
    const gstReady     = inStates("ready_to_send", "gst_sent", "paid_awaiting_receipt_record", "complete");
    const invoiceSent  = inStates("gst_sent", "paid_awaiting_receipt_record", "complete");
    steps = buildSteps(
      ["PI\nSent", "Collect\nPayment", "GST in\nTally", "Invoice\nSent", "Done"],
      [true, pmtDone, gstReady, invoiceSent, isComplete],
    );
  }

  const flowLabel =
    billingMode === "gst_direct"
      ? "GST Direct"
      : row.pi_was_cancelled
      ? "Override"
      : "PI-first";

  return (
    <div className="col-span-2 pt-2 pb-0.5">
      <div className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide mb-1.5">
        {flowLabel}
      </div>
      <div className="flex items-start">
        {steps.map((step, i) => (
          <Fragment key={step.label}>
            <div className="flex flex-col items-center" style={{ minWidth: 52 }}>
              <div
                className={`h-5 w-5 rounded-full flex items-center justify-center border-2 text-[10px] font-semibold ${
                  step.status === "done"
                    ? "bg-green-500 border-green-500 text-white"
                    : step.status === "current"
                    ? "bg-blue-500 border-blue-500 text-white"
                    : "border-gray-200 bg-white text-gray-300"
                }`}
              >
                {step.status === "done" ? <CheckCircle2 className="h-3 w-3" /> : String(i + 1)}
              </div>
              <div
                className={`text-[10px] mt-0.5 text-center leading-tight whitespace-pre-line ${
                  step.status === "done"
                    ? "text-green-700"
                    : step.status === "current"
                    ? "text-blue-700 font-medium"
                    : "text-muted-foreground opacity-50"
                }`}
              >
                {step.label}
              </div>
            </div>
            {i < steps.length - 1 && (
              <div
                className={`flex-1 h-0.5 mt-2.5 rounded-full ${
                  step.status === "done" ? "bg-green-300" : "bg-gray-100"
                }`}
              />
            )}
          </Fragment>
        ))}
      </div>
    </div>
  );
}

const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;

function formatSentAt(iso: string): string {
  return new Date(iso).toLocaleString("en-IN", { dateStyle: "short", timeStyle: "short" });
}

function InboxRowItem({
  row,
  expanded,
  sending,
  closing,
  resending,
  sentConfirmed,
  onToggle,
  onSend,
  onClose,
  onResend,
  onUploaded,
  onCancelUpload,
  onGstinUpdated,
  onRecordPayment,
}: {
  row: InboxRow;
  expanded: boolean;
  sending: boolean;
  closing: boolean;
  resending: boolean;
  sentConfirmed: boolean;
  onToggle: () => void;
  onSend: () => void;
  onClose: () => void;
  onResend: () => void;
  onUploaded: () => void;
  onCancelUpload: () => void;
  onGstinUpdated: () => void;
  onRecordPayment: () => void;
}) {
  const [gstinEditing, setGstinEditing] = useState(false);
  const [gstinInput, setGstinInput] = useState("");
  const [gstinSaving, setGstinSaving] = useState(false);
  const [gstinError, setGstinError] = useState<string | null>(null);

  const handleGstinSave = async () => {
    const val = gstinInput.trim().toUpperCase();
    if (!GSTIN_RE.test(val)) {
      setGstinError("Invalid GSTIN format (e.g. 29AABCU9603R1ZX)");
      return;
    }
    const leadId = row.contract?.lead?.id;
    if (!leadId) return;
    setGstinSaving(true);
    setGstinError(null);
    try {
      const res = await fetch(`/api/leads/${leadId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ gst_number: val }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      setGstinEditing(false);
      setGstinInput("");
      onGstinUpdated();
    } catch (e) {
      setGstinError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setGstinSaving(false);
    }
  };

  const aging = row.aging_hours;
  const agingClass =
    aging >= AGING_ESCALATE_HOURS ? "text-red-700" : aging >= 24 ? "text-amber-700" : "text-muted-foreground";

  const canUpload =
    row.handoff_state === "pi_paid_awaiting_gst" || row.handoff_state === "direct_gst_requested";
  const canSend = row.handoff_state === "ready_to_send" && !row.has_discrepancy;
  const canRecordPayment =
    row.handoff_state === "gst_sent_awaiting_payment"
    || row.handoff_state === "paid_awaiting_receipt_record";
  const canMarkAccounted = row.handoff_state === "gst_sent";
  const hasUpload = row.latest_upload !== null;
  const isClosed = row.handoff_state === "complete";

  // Tally bridge match status — derived from latest_snapshot + has_discrepancy.
  // Bridge v2 isn't deployed yet, so most rows will be "not synced".
  const bridgeStatus: { label: string; cls: string; title: string } = (() => {
    if (row.has_discrepancy) {
      return {
        label: "Tally: drift",
        cls: "bg-red-50 text-red-900 border-red-200",
        title: "Tally voucher exists but its amount differs from the CRM statement",
      };
    }
    if (row.latest_snapshot && row.latest_snapshot.match_confidence === "exact") {
      return {
        label: "Tally: matched",
        cls: "bg-green-50 text-green-900 border-green-200",
        title: "Voucher seen in Tally and matched to this statement",
      };
    }
    if (row.latest_snapshot) {
      return {
        label: "Tally: partial",
        cls: "bg-amber-50 text-amber-900 border-amber-200",
        title: `Snapshot match confidence: ${row.latest_snapshot.match_confidence ?? "unmatched"}`,
      };
    }
    return {
      label: "Tally: not synced",
      cls: "bg-muted text-muted-foreground border-border",
      title: "No voucher in tally_voucher_snapshots for this statement yet",
    };
  })();

  return (
    <li
      className="hover:bg-muted/30 transition-colors rounded"
      data-statement-id={row.statement_id}
    >
      <div className="p-3 md:p-4 grid grid-cols-[1fr_auto] gap-x-4 gap-y-2 items-start">
        {/* ── Line 1 ── primary identity */}
        <div className="min-w-0 flex items-baseline gap-2 flex-wrap">
          <span
            className={`text-[11px] px-2 py-0.5 rounded-full border flex-shrink-0 ${bucketBadgeClass(row.bucket, row.has_discrepancy)}`}
          >
            {bucketLabel(row.bucket)}
          </span>
          <span className="font-medium text-sm truncate">{partyDisplay(row)}</span>
        </div>
        <div className="text-right">
          <div className="font-medium tabular-nums text-sm">
            {formatCurrency(row.statement_total_amount)}
          </div>
        </div>

        {/* ── Line 2 ── meta: contract / statement / state / aging */}
        <div className="min-w-0 text-xs text-muted-foreground truncate">
          {row.contract && (
            <>
              <span className="font-mono">{row.contract.contract_number}</span>
              {row.contract.title && <span> · {row.contract.title}</span>}
              <span> · </span>
            </>
          )}
          <span className="font-mono">{row.statement_number ?? "(no number)"}</span>
          {row.latest_upload?.tally_invoice_number && (
            <span className="font-mono text-foreground"> → {row.latest_upload.tally_invoice_number}</span>
          )}
          <span> · {row.handoff_state ? HANDOFF_STATE_LABELS[row.handoff_state] : "Draft"}</span>
          {row.contract?.billing_mode === "gst_direct" && <span> · direct GST</span>}
        </div>
        <div className={`text-xs ${agingClass} text-right`}>
          {aging < 1 ? "just now" : aging < 24 ? `${aging}h ago` : `${Math.floor(aging / 24)}d ago`}
        </div>

        {/* ── Line 3 ── pills: GSTIN · IRN req · Tally · period */}
        <div className="col-span-2 flex items-center gap-1.5 flex-wrap text-[11px]">
          {row.contract?.lead?.gst_number ? (
            <span className="font-mono px-1.5 py-0.5 rounded bg-muted/60 text-muted-foreground" title="Customer GSTIN">
              {row.contract.lead.gst_number}
            </span>
          ) : gstinEditing ? (
            <span className="flex items-center gap-1 flex-wrap">
              <input
                autoFocus
                type="text"
                value={gstinInput}
                onChange={(e) => { setGstinInput(e.target.value.toUpperCase()); setGstinError(null); }}
                onKeyDown={(e) => { if (e.key === "Enter") void handleGstinSave(); if (e.key === "Escape") { setGstinEditing(false); setGstinInput(""); setGstinError(null); } }}
                placeholder="29AABCU9603R1ZX"
                maxLength={15}
                className="font-mono text-[11px] px-1.5 py-0.5 rounded border focus:outline-none focus:ring-1 focus:ring-foreground/30 w-36 uppercase"
              />
              <button
                type="button"
                onClick={() => void handleGstinSave()}
                disabled={gstinSaving}
                className="inline-flex items-center gap-0.5 text-[11px] px-1.5 py-0.5 rounded bg-foreground text-background disabled:opacity-50"
              >
                {gstinSaving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
                Save
              </button>
              <button
                type="button"
                onClick={() => { setGstinEditing(false); setGstinInput(""); setGstinError(null); }}
                className="text-[11px] px-1.5 py-0.5 rounded border hover:bg-muted"
              >
                Cancel
              </button>
              {gstinError && <span className="text-red-600 text-[11px]">{gstinError}</span>}
            </span>
          ) : (
            <button
              type="button"
              onClick={() => row.contract?.lead?.id && setGstinEditing(true)}
              disabled={!row.contract?.lead?.id}
              className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-amber-50 text-amber-800 border border-amber-200 hover:bg-amber-100 disabled:opacity-40 disabled:cursor-not-allowed"
              title="GSTIN missing — click to add"
            >
              <Pencil className="h-2.5 w-2.5" />
              no GSTIN
            </button>
          )}
          <span
            className={`px-1.5 py-0.5 rounded border ${
              row.irn_required
                ? "bg-blue-50 text-blue-900 border-blue-200"
                : "bg-muted/60 text-muted-foreground border-transparent"
            }`}
            title={row.irn_required ? "A-series invoice + IRN required" : "B-series invoice, no IRN"}
          >
            {row.irn_required ? "IRN required" : "no IRN"}
          </span>
          <span
            className={`px-1.5 py-0.5 rounded border ${bridgeStatus.cls}`}
            title={bridgeStatus.title}
          >
            {bridgeStatus.label}
          </span>
          {row.period_start && row.period_end && (
            <span className="text-muted-foreground">
              {row.period_start} → {row.period_end}
            </span>
          )}
        </div>

        {/* ── Lifecycle tracker ── */}
        <InboxRowLifecycleTracker row={row} />

        {/* ── Discrepancy or upload-pending banner (only when present) ── */}
        {(row.has_discrepancy || (row.latest_upload && !canSend)) && (
          <div className="col-span-2">
            {row.has_discrepancy && row.discrepancy_reason && (
              <div className="text-xs text-red-700 flex items-start gap-1">
                <AlertCircle className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" aria-hidden />
                <span>{row.discrepancy_reason}</span>
              </div>
            )}
            {row.latest_upload && !canSend && (
              <div className="text-xs text-muted-foreground">
                Upload: <span className="font-mono">{row.latest_upload.tally_invoice_number}</span>
                {row.latest_upload.name_check_status === "pending" && (
                  <span className="text-amber-700 ml-1">· name check pending</span>
                )}
              </div>
            )}
          </div>
        )}

        {/* ── Actions row ── */}
        <div className="col-span-2 flex items-center gap-1.5 flex-wrap justify-end pt-1">
          {!row.pi_was_cancelled && (
            <a
              href={`/api/billing-statements/${row.statement_id}/proforma-pdf`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded border hover:bg-muted"
              title="Open the CRM-generated proforma invoice PDF (original bill)"
            >
              <FileDown className="h-3 w-3" />
              View PI
            </a>
          )}
          {hasUpload && (
            <a
              href={`/api/billing-statements/${row.statement_id}/gst-invoice-pdf`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded border hover:bg-muted"
              title="Open the GST tax invoice PDF uploaded by accounts"
            >
              <FileCheck className="h-3 w-3" />
              View GST
            </a>
          )}
          {canUpload && !isClosed && (
            <button
              type="button"
              onClick={onToggle}
              className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded border hover:bg-muted"
              aria-expanded={expanded}
            >
              {expanded ? (
                <><ChevronUp className="h-3 w-3" /> Close</>
              ) : (
                <><Upload className="h-3 w-3" /> Upload <ChevronDown className="h-3 w-3" /></>
              )}
            </button>
          )}
          {canSend && (
            <button
              type="button"
              onClick={onSend}
              disabled={sending}
              className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded bg-foreground text-background hover:opacity-90 disabled:opacity-50"
            >
              {sending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Send className="h-3 w-3" />}
              {sending ? "Sending…" : "Save & send"}
            </button>
          )}
          {canRecordPayment && (
            <button
              type="button"
              onClick={onRecordPayment}
              className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded bg-foreground text-background hover:opacity-90"
              title="Record bank transfer / UPI payment received from customer"
            >
              <IndianRupee className="h-3 w-3" />
              Record payment
            </button>
          )}
          {canMarkAccounted && (
            <button
              type="button"
              onClick={onClose}
              disabled={closing}
              className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded border hover:bg-muted disabled:opacity-50"
              title="Payment already collected via PI — mark GST invoice as accounted"
            >
              {closing ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
              {closing ? "Saving…" : "Mark as accounted"}
            </button>
          )}
          {isClosed && row.latest_upload && (
            <div className="flex flex-col items-end gap-0.5">
              <button
                type="button"
                onClick={onResend}
                disabled={resending}
                className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded border hover:bg-muted disabled:opacity-50"
                title="Resend the GST invoice email to the customer"
              >
                {resending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Send className="h-3 w-3" />}
                {resending ? "Sending…" : "Resend email"}
              </button>
              {sentConfirmed ? (
                <span className="text-[10px] text-green-700 flex items-center gap-0.5">
                  <Check className="h-3 w-3" /> Sent successfully
                </span>
              ) : row.gst_invoice_sent_at ? (
                <span className="text-[10px] text-muted-foreground">
                  Last sent: {formatSentAt(row.gst_invoice_sent_at)}
                </span>
              ) : null}
            </div>
          )}
        </div>
      </div>
      {expanded && canUpload && (
        <TallyInboxUploadForm
          row={row}
          onUploaded={onUploaded}
          onCancel={onCancelUpload}
        />
      )}
    </li>
  );
}

// ── Booking payment confirmation helpers ────────────────────────────────────

import type { BookingPaymentConfirmation } from "@/lib/tally-handoff";

function paymentModeLabel(mode: string): string {
  const map: Record<string, string> = {
    razorpay: "Razorpay",
    upi: "UPI",
    cash: "Cash",
    card: "Card",
    neft: "NEFT",
    rtgs: "RTGS",
    cheque: "Cheque",
    bank_transfer: "Bank Transfer",
  };
  return map[mode.toLowerCase()] ?? mode;
}

function BookingPaymentPill({ confirmations }: { confirmations: BookingPaymentConfirmation[] }) {
  if (confirmations.length === 0) {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded bg-amber-50 text-amber-800 border border-amber-200 flex-shrink-0">
        ⚠ Payment unverified
      </span>
    );
  }
  const latest = confirmations[0];
  const ref = latest.razorpay_payment_id ?? latest.payment_reference;
  return (
    <span className="inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded bg-green-50 text-green-800 border border-green-200 flex-shrink-0">
      <CheckCircle2 className="h-2.5 w-2.5" />
      Paid · {paymentModeLabel(latest.payment_mode)}{ref ? ` · ${ref.slice(-8)}` : ""}
    </span>
  );
}

function BookingPaymentPanel({
  confirmations,
  totalAmount,
}: {
  confirmations: BookingPaymentConfirmation[];
  totalAmount: number;
}) {
  const totalConfirmed = confirmations.reduce((s, p) => s + p.amount, 0);
  const isFullyPaid = Math.abs(totalConfirmed - totalAmount) < 0.5;

  if (confirmations.length === 0) {
    return (
      <div className="mx-3 mb-2 md:mx-4 p-3 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-900">
        <div className="flex items-center gap-1.5 font-medium mb-0.5">
          <AlertCircle className="h-3.5 w-3.5" />
          No confirmed payment records found
        </div>
        <p className="text-amber-800">
          This booking is marked paid but no <code>booking_payments</code> confirmation row exists.
          Verify in the Bookings module before issuing the GST invoice.
        </p>
      </div>
    );
  }

  return (
    <div className="mx-3 mb-2 md:mx-4 p-3 rounded-lg bg-green-50 border border-green-200 text-xs">
      <div className="flex items-center justify-between mb-2">
        <span className="flex items-center gap-1.5 font-medium text-green-900">
          <CheckCircle2 className="h-3.5 w-3.5 text-green-600" />
          Payment confirmed — cross-check before issuing GST invoice
        </span>
        {isFullyPaid ? (
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-100 text-green-800 border border-green-300 font-medium">
            Fully paid
          </span>
        ) : (
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 border border-amber-300 font-medium">
            Partial — {formatCurrency(totalConfirmed)} of {formatCurrency(totalAmount)}
          </span>
        )}
      </div>
      <table className="w-full text-[11px] border-separate border-spacing-y-0.5">
        <thead>
          <tr className="text-muted-foreground">
            <th className="text-left font-medium pb-1">Amount</th>
            <th className="text-left font-medium pb-1">Mode</th>
            <th className="text-left font-medium pb-1">Reference / ID</th>
            <th className="text-left font-medium pb-1">Date</th>
          </tr>
        </thead>
        <tbody>
          {confirmations.map((p) => {
            const ref = p.razorpay_payment_id ?? p.payment_reference ?? "—";
            const date = new Date(p.created_at).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
            return (
              <tr key={p.id} className="text-green-900">
                <td className="font-medium tabular-nums pr-3">{formatCurrency(p.amount)}</td>
                <td className="pr-3">{paymentModeLabel(p.payment_mode)}</td>
                <td className="font-mono pr-3 text-green-700">{ref}</td>
                <td className="text-muted-foreground">{date}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── Booking GST task row ─────────────────────────────────────────────────────

function BookingInboxLifecycleTracker({ state }: { state: BookingHandoffState }) {
  type StepStatus = "done" | "current" | "pending";
  const steps: { label: string; status: StepStatus }[] = [
    {
      label: "GST\nto issue",
      status: state === "gst_to_issue" ? "current" : "done",
    },
    {
      label: "Invoice\nsent",
      status:
        state === "ready_to_send" ? "current"
        : state === "complete" ? "done"
        : "pending",
    },
    {
      label: "Done",
      status: state === "complete" ? "done" : "pending",
    },
  ];

  return (
    <div className="col-span-2 pt-2 pb-0.5">
      <div className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide mb-1.5">
        Direct GST — Booking
      </div>
      <div className="flex items-start">
        {steps.map((step, i) => (
          <Fragment key={step.label}>
            <div className="flex flex-col items-center" style={{ minWidth: 52 }}>
              <div
                className={`h-5 w-5 rounded-full flex items-center justify-center border-2 text-[10px] font-semibold ${
                  step.status === "done"
                    ? "bg-green-500 border-green-500 text-white"
                    : step.status === "current"
                    ? "bg-blue-500 border-blue-500 text-white"
                    : "border-gray-200 bg-white text-gray-300"
                }`}
              >
                {step.status === "done" ? <CheckCircle2 className="h-3 w-3" /> : String(i + 1)}
              </div>
              <div
                className={`text-[10px] mt-0.5 text-center leading-tight whitespace-pre-line ${
                  step.status === "done"
                    ? "text-green-700"
                    : step.status === "current"
                    ? "text-blue-700 font-medium"
                    : "text-muted-foreground opacity-50"
                }`}
              >
                {step.label}
              </div>
            </div>
            {i < steps.length - 1 && (
              <div
                className={`flex-1 h-0.5 mt-2.5 rounded-full ${
                  step.status === "done" ? "bg-green-300" : "bg-gray-100"
                }`}
              />
            )}
          </Fragment>
        ))}
      </div>
    </div>
  );
}

function BookingInboxRowItem({
  row,
  expanded,
  sending,
  closing,
  resending,
  sentConfirmed,
  onToggle,
  onSend,
  onClose,
  onResend,
  onUploaded,
  onCancelUpload,
}: {
  row: BookingInboxRow;
  expanded: boolean;
  sending: boolean;
  closing: boolean;
  resending: boolean;
  sentConfirmed: boolean;
  onToggle: () => void;
  onSend: () => void;
  onClose: () => void;
  onResend: () => void;
  onUploaded: () => void;
  onCancelUpload: () => void;
}) {
  const [paymentOpen, setPaymentOpen] = useState(false);

  const aging = row.aging_hours;
  const agingClass =
    aging >= AGING_ESCALATE_HOURS ? "text-red-700" : aging >= 24 ? "text-amber-700" : "text-muted-foreground";

  const canUpload = row.handoff_state === "gst_to_issue";
  const canSend = row.handoff_state === "ready_to_send" && !row.has_discrepancy;
  const canMarkDone = row.handoff_state === "ready_to_send";
  const hasUpload = row.latest_upload !== null;
  const isClosed = row.handoff_state === "complete";

  const partyName = row.customer_name ?? row.customer_email ?? "(walk-in)";

  return (
    <li className="hover:bg-muted/30 transition-colors rounded" data-statement-id={row.task_id}>
      <div className="p-3 md:p-4 grid grid-cols-[1fr_auto] gap-x-4 gap-y-2 items-start">
        {/* Line 1: badge + party name */}
        <div className="min-w-0 flex items-baseline gap-2 flex-wrap">
          <span className={`text-[11px] px-2 py-0.5 rounded-full border flex-shrink-0 ${bucketBadgeClass(row.bucket as HandoffBucket, row.has_discrepancy)}`}>
            {bucketLabel(row.bucket as HandoffBucket)}
          </span>
          <span className="inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground border border-muted-foreground/20 flex-shrink-0">
            <CalendarDays className="h-2.5 w-2.5" />
            Booking
          </span>
          <BookingPaymentPill confirmations={row.payment_confirmations} />
          <span className="font-medium text-sm truncate">{partyName}</span>
        </div>
        <div className="text-right">
          <div className="font-medium tabular-nums text-sm">{formatCurrency(row.statement_total_amount)}</div>
        </div>

        {/* Line 2: booking number + state + aging */}
        <div className="min-w-0 text-xs text-muted-foreground truncate">
          <span className="font-mono">{row.booking_number ?? "(no number)"}</span>
          {row.space_name && <span> · {row.space_name}</span>}
          {row.booking_date && <span> · {row.booking_date}</span>}
          <span> · {row.handoff_state === "gst_to_issue" ? "GST to issue" : row.handoff_state === "ready_to_send" ? "Ready to send" : "Complete"}</span>
        </div>
        <div className={`text-xs ${agingClass} text-right`}>
          {aging < 1 ? "just now" : aging < 24 ? `${aging}h ago` : `${Math.floor(aging / 24)}d ago`}
        </div>

        {/* Line 3: GSTIN + IRN pill */}
        <div className="col-span-2 flex items-center gap-1.5 flex-wrap text-[11px]">
          {row.customer_gstin ? (
            <span className="font-mono px-1.5 py-0.5 rounded bg-muted/60 text-muted-foreground" title="Customer GSTIN">
              {row.customer_gstin}
            </span>
          ) : (
            <span className="px-1.5 py-0.5 rounded bg-amber-50 text-amber-800 border border-amber-200">no GSTIN</span>
          )}
          <span
            className={`px-1.5 py-0.5 rounded border ${row.irn_required ? "bg-blue-50 text-blue-900 border-blue-200" : "bg-muted/60 text-muted-foreground border-transparent"}`}
            title={row.irn_required ? "A-series invoice + IRN required" : "B-series invoice, no IRN"}
          >
            {row.irn_required ? "IRN required" : "no IRN"}
          </span>
          {row.location_name && (
            <span className="text-muted-foreground">{row.location_name}</span>
          )}
        </div>

        {/* Lifecycle tracker */}
        <BookingInboxLifecycleTracker state={row.handoff_state} />

        {/* Booking usage details */}
        <div className="col-span-2 rounded-md bg-muted/40 border px-3 py-2 text-xs space-y-1.5">
          {/* Date + time */}
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            <span className="text-muted-foreground">Date</span>
            <span className="font-medium">
              {row.booking_date ? formatDate(row.booking_date) : "—"}
            </span>
            <span className="text-muted-foreground ml-auto sm:ml-0">Time</span>
            <span className="font-medium">
              {row.start_time && row.end_time
                ? `${row.start_time} – ${row.end_time}`
                : row.check_in_at && row.check_out_at
                  ? `${new Date(row.check_in_at).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" })} – ${new Date(row.check_out_at).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" })}`
                  : "—"}
              {row.duration_hours != null && (
                <span className="text-muted-foreground ml-1">({row.duration_hours}h)</span>
              )}
            </span>
          </div>

          {/* Charge breakup */}
          <table className="w-full text-xs">
            <tbody>
              <tr>
                <td className="text-muted-foreground py-0.5 pr-2">
                  {row.space_name ?? "Room charge"}
                  {row.pricing_model === "daily" ? " (day pass)" : ""}
                </td>
                <td className="text-right tabular-nums">{formatCurrency(row.base_amount)}</td>
              </tr>
              {row.addons.map((a) => (
                <tr key={a.id}>
                  <td className="text-muted-foreground py-0.5 pr-2">
                    {a.description}
                    {a.quantity > 1 && a.unit_label
                      ? ` × ${a.quantity} ${a.unit_label}`
                      : a.quantity > 1
                        ? ` × ${a.quantity}`
                        : ""}
                  </td>
                  <td className="text-right tabular-nums">{formatCurrency(a.amount)}</td>
                </tr>
              ))}
              <tr className="border-t border-border/50">
                <td className="text-muted-foreground py-0.5 pr-2">GST ({row.gst_rate}%)</td>
                <td className="text-right tabular-nums">{formatCurrency(row.gst_amount)}</td>
              </tr>
              <tr>
                <td className="font-medium py-0.5 pr-2">Total</td>
                <td className="text-right tabular-nums font-semibold">{formatCurrency(row.statement_total_amount)}</td>
              </tr>
            </tbody>
          </table>
        </div>

        {/* Discrepancy banner */}
        {row.has_discrepancy && row.discrepancy_reason && (
          <div className="col-span-2 text-xs text-red-700 flex items-start gap-1">
            <AlertCircle className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" aria-hidden />
            <span>{row.discrepancy_reason}</span>
          </div>
        )}
        {hasUpload && !canSend && (
          <div className="col-span-2 text-xs text-muted-foreground">
            Upload: <span className="font-mono">{row.latest_upload!.tally_invoice_number}</span>
          </div>
        )}

        {/* Actions */}
        <div className="col-span-2 flex items-center gap-1.5 flex-wrap justify-end pt-1">
          {/* Payment detail toggle — always available on booking rows */}
          <button
            type="button"
            onClick={() => setPaymentOpen(o => !o)}
            className={`inline-flex items-center gap-1 text-xs px-2 py-1 rounded border transition-colors mr-auto ${paymentOpen ? "bg-green-50 border-green-300 text-green-800" : "hover:bg-muted"}`}
            title="View payment confirmation details"
          >
            <IndianRupee className="h-3 w-3" />
            Payment
            {paymentOpen ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
          </button>
          {row.lead_id && row.lead_id_proof_path && (
            <a
              href={`/api/leads/${row.lead_id}/id-proof`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded border hover:bg-muted"
              title="Open the customer's KYC identity document"
            >
              <FileText className="h-3 w-3" />
              View KYC
            </a>
          )}
          {row.lead_id && !row.lead_id_proof_path && (
            <span
              className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded border border-dashed text-muted-foreground cursor-default"
              title="No KYC document uploaded for this customer"
            >
              <FileText className="h-3 w-3" />
              No KYC
            </span>
          )}
          {hasUpload && (
            <a
              href={`/api/booking-gst-tasks/${row.task_id}/gst-invoice-pdf`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded border hover:bg-muted"
              title="Open the uploaded GST tax invoice PDF"
            >
              <FileCheck className="h-3 w-3" />
              View GST
            </a>
          )}
          {canUpload && !isClosed && (
            <button
              type="button"
              onClick={onToggle}
              className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded border hover:bg-muted"
              aria-expanded={expanded}
            >
              {expanded ? (
                <><ChevronUp className="h-3 w-3" /> Close</>
              ) : (
                <><Upload className="h-3 w-3" /> Upload <ChevronDown className="h-3 w-3" /></>
              )}
            </button>
          )}
          {canSend && (
            <button
              type="button"
              onClick={onSend}
              disabled={sending}
              className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded bg-foreground text-background hover:opacity-90 disabled:opacity-50"
            >
              {sending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Send className="h-3 w-3" />}
              {sending ? "Sending…" : "Save & send"}
            </button>
          )}
          {canMarkDone && (
            <button
              type="button"
              onClick={onClose}
              disabled={closing}
              className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded border hover:bg-muted disabled:opacity-50"
              title="Mark as done without sending email"
            >
              {closing ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
              {closing ? "Closing…" : "Mark as done"}
            </button>
          )}
          {isClosed && hasUpload && (
            <div className="flex flex-col items-end gap-0.5">
              <button
                type="button"
                onClick={onResend}
                disabled={resending}
                className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded border hover:bg-muted disabled:opacity-50"
                title="Resend the GST invoice email to the customer"
              >
                {resending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Send className="h-3 w-3" />}
                {resending ? "Sending…" : "Resend email"}
              </button>
              {sentConfirmed ? (
                <span className="text-[10px] text-green-700 flex items-center gap-0.5">
                  <Check className="h-3 w-3" /> Sent successfully
                </span>
              ) : row.gst_invoice_sent_at ? (
                <span className="text-[10px] text-muted-foreground">
                  Last sent: {new Date(row.gst_invoice_sent_at).toLocaleString("en-IN", { dateStyle: "short", timeStyle: "short" })}
                </span>
              ) : null}
            </div>
          )}
        </div>
      </div>

      {paymentOpen && (
        <BookingPaymentPanel confirmations={row.payment_confirmations} totalAmount={row.statement_total_amount} />
      )}

      {expanded && canUpload && (
        <BookingGstUploadForm
          taskId={row.task_id}
          bookingNumber={row.booking_number}
          spaceName={row.space_name}
          customerName={row.customer_name}
          customerGstin={row.customer_gstin}
          totalAmount={row.statement_total_amount}
          irnRequired={row.irn_required}
          expectedSeries={row.expected_series ?? (row.irn_required ? "SDIPL-REG" : "SDIPL-UNREG")}
          expectedPrefix={row.expected_prefix ?? (row.irn_required ? "SD/A/" : "SD/B/")}
          onUploaded={onUploaded}
          onCancel={onCancelUpload}
        />
      )}
    </li>
  );
}
