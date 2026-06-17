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
import { RefreshCw, Inbox as InboxIcon, AlertCircle, Clock, CheckCircle2, FileText, Send, Upload, ChevronDown, ChevronUp, Loader2, FileDown, FileCheck, Check, Search, X, Pencil } from "lucide-react";
import { formatCurrency } from "@/lib/utils";
import {
  AGING_ESCALATE_HOURS,
  HANDOFF_STATE_LABELS,
  type HandoffBucket,
  type InboxResponse,
  type InboxRow,
} from "@/lib/tally-handoff";
import { TallyInboxUploadForm } from "./tally-inbox-upload-form";

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
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [sendingId, setSendingId] = useState<string | null>(null);
  const [closingId, setClosingId] = useState<string | null>(null);
  const [resendingId, setResendingId] = useState<string | null>(null);
  const [sentConfirmedId, setSentConfirmedId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [closedPage, setClosedPage] = useState(1);

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

  const visibleRows = useMemo(() => {
    if (!data) return [];
    if (tab === "all" || tab === "closed") return data.rows;
    if (tab === "discrepancy") return data.rows.filter((r) => r.has_discrepancy);
    return data.rows.filter((r) => r.bucket === tab && !r.has_discrepancy);
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
      ) : visibleRows.length === 0 ? (
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
                onClose={() => handleClose(row.statement_id)}
                onResend={() => handleResend(row.statement_id)}
                onUploaded={handleUploaded}
                onCancelUpload={() => setExpandedId(null)}
                onGstinUpdated={() => void load()}
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
      ["GST\nRequested", "GST in\nTally", "Invoice +\nLink Sent", "Payment\nReceived", "Done"],
      [true, gstReady, linkSent, pmtDone, isComplete],
    );
  } else if (row.pi_was_cancelled) {
    // Flow 2: Override — PI was cancelled early so GST invoice is issued before payment
    const gstReady  = inStates("ready_to_send", "gst_sent_awaiting_payment", "paid_awaiting_receipt_record", "complete");
    const emailSent = inStates("gst_sent_awaiting_payment", "paid_awaiting_receipt_record", "complete");
    const pmtDone   = paid || inStates("paid_awaiting_receipt_record", "complete");
    steps = buildSteps(
      ["PI\nCancelled", "GST in\nTally", "Link +\nEmail Sent", "Payment\nReceived", "Done"],
      [true, gstReady, emailSent, pmtDone, isComplete],
    );
  } else {
    // Flow 1: PI-first — payment received before GST invoice is uploaded
    const pmtDone      = paid || inStates("pi_paid_awaiting_gst", "name_check_pending", "ready_to_send", "gst_sent", "paid_awaiting_receipt_record", "complete");
    const gstReady     = inStates("ready_to_send", "gst_sent", "paid_awaiting_receipt_record", "complete");
    const invoiceSent  = inStates("gst_sent", "paid_awaiting_receipt_record", "complete");
    steps = buildSteps(
      ["PI\nSent", "Payment\nReceived", "GST in\nTally", "Invoice\nSent", "Done"],
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
  const canMarkDone =
    row.handoff_state === "gst_sent"
    || row.handoff_state === "gst_sent_awaiting_payment"
    || row.handoff_state === "paid_awaiting_receipt_record";
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
          {canMarkDone && (
            <button
              type="button"
              onClick={onClose}
              disabled={closing}
              className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded border hover:bg-muted disabled:opacity-50"
              title="Mark this row as done so it drops off the open inbox"
            >
              {closing ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
              {closing ? "Closing…" : "Mark as done"}
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
