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

import { Fragment, useEffect, useMemo, useState, useCallback, useRef, memo } from "react";
import { RefreshCw, Inbox as InboxIcon, AlertCircle, Clock, CheckCircle2, FileText, Send, Upload, ChevronDown, ChevronUp, Loader2, FileDown, FileCheck, Check, Search, X, Pencil, CalendarDays, IndianRupee, ImageIcon, History } from "lucide-react";
import { formatCurrency, formatDate } from "@/lib/utils";
import { createClient } from "@/lib/supabase/client";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { TDS_CLIENT_SECTIONS } from "@/lib/constants";
import {
  AGING_ESCALATE_HOURS,
  HANDOFF_STATE_LABELS,
  type BookingHandoffState,
  type BookingInboxRow,
  type HandoffBucket,
  type InboxPayment,
  type InboxResponse,
  type InboxRow,
} from "@/lib/tally-handoff";
import { TallyInboxUploadForm } from "./tally-inbox-upload-form";
import { BookingGstUploadForm } from "./booking-gst-upload-form";
import { InboxSendDialog } from "./inbox-send-dialog";
import { StatementHistoryDialog } from "./statement-history-dialog";

type FilterTab = "all" | "gst_to_issue" | "payment_to_record" | "discrepancy" | "closed";

// Success confirmation shown in place of a row once an action closes it out —
// the row itself drops out of the "open" list on the next reload, so without
// this the user has no way to tell whether the last click actually worked.
type CompletionInfo = {
  id: string;
  kind: "statement" | "booking";
  partyName: string;
  identifierLabel: string;
  amount: number;
  invoiceNumber: string | null;
  emailedTo: string | null;
  action: "invoice_sent" | "marked_complete";
};

const FILTER_TABS: { key: FilterTab; label: string }[] = [
  { key: "all", label: "All open" },
  { key: "gst_to_issue", label: "GST to issue" },
  { key: "payment_to_record", label: "Payments" },
  { key: "discrepancy", label: "Discrepancies" },
  { key: "closed", label: "Closed" },
];

function partyDisplay(row: InboxRow): string {
  const lead = row.contract?.lead ?? row.proposal?.lead ?? row.invoice?.lead;
  if (lead) {
    if (lead.company) return lead.company;
    const name = [lead.first_name, lead.last_name].filter(Boolean).join(" ");
    return name || lead.email || "(unnamed)";
  }
  // Per-case VO statements (prepaid aggregator / direct client) carry no
  // lead — they use the case's own client fields instead.
  if (row.case) {
    return row.case.client_company_name || row.case.client_name || "(unnamed)";
  }
  // Postpaid aggregator consolidated statements carry no lead either.
  if (row.aggregator) {
    return row.aggregator.name || "(unnamed)";
  }
  return "(unknown party)";
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

function paymentStatusBadge(status: string): { label: string; cls: string } {
  switch (status) {
    case "paid":
      return { label: "Paid", cls: "bg-green-50 text-green-800 border-green-200" };
    case "partially_paid":
      return { label: "Partially paid", cls: "bg-amber-50 text-amber-800 border-amber-200" };
    case "unpaid":
      return { label: "Unpaid", cls: "bg-muted/60 text-muted-foreground border-transparent" };
    default:
      return { label: status, cls: "bg-muted/60 text-muted-foreground border-transparent" };
  }
}

/**
 * "All open" groups rows by the action a user would actually click next,
 * instead of raw last-updated order. One group per action button already
 * on the row (canUpload / canSend / canRecordPayment / canMarkAccounted),
 * plus discrepancies pulled to the top since those block everything else.
 * Mirrors INBOX_ACTIONABLE_STATES — every open row belongs to exactly one
 * group (discrepancy overrides state).
 */
type ActionGroupKey = "discrepancy" | "upload_gst" | "send_to_customer" | "record_payment" | "mark_accounted";

const ACTION_GROUPS: { key: ActionGroupKey; title: string; caption: string; wrapCls: string }[] = [
  {
    key: "discrepancy",
    title: "Discrepancies to resolve",
    caption: "Amount, name, or GST number doesn't match what Tally expects. Always cleared first.",
    wrapCls: "bg-red-50/60 border-red-200",
  },
  {
    key: "upload_gst",
    title: "Upload GST invoice",
    caption: "Payment's in, or GST was requested direct — issue the invoice in Tally and upload it here.",
    wrapCls: "bg-blue-50/60 border-blue-200",
  },
  {
    key: "send_to_customer",
    title: "Send to customer",
    caption: "GST invoice is uploaded and name-matched — one click sends it on.",
    wrapCls: "bg-violet-50/60 border-violet-200",
  },
  {
    key: "record_payment",
    title: "Record payment",
    caption: "Customer already has the invoice. Bank statement in hand? Log it here.",
    wrapCls: "bg-amber-50/60 border-amber-200",
  },
  {
    key: "mark_accounted",
    title: "Mark as accounted",
    caption: "GST already sent and payment already collected via the PI — just needs closing out.",
    wrapCls: "bg-green-50/60 border-green-200",
  },
];

function getRowActionGroup(row: InboxRow): ActionGroupKey {
  if (row.has_discrepancy) return "discrepancy";
  switch (row.handoff_state) {
    case "pi_paid_awaiting_gst":
    case "direct_gst_requested":
      return "upload_gst";
    case "ready_to_send":
      return "send_to_customer";
    case "gst_sent_awaiting_payment":
    case "paid_awaiting_receipt_record":
      return "record_payment";
    case "gst_sent":
      return "mark_accounted";
    default:
      return "upload_gst";
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
  // Primary split — rental/contract statements vs walk-in booking GST tasks.
  // These are backed by entirely different tables (billing_statements vs
  // booking_gst_tasks) and were previously stacked in one unlabeled list.
  const [activeType, setActiveType] = useState<"contracts" | "bookings">("contracts");
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
  // "All open" action-group collapse state, keyed by ActionGroupKey. Only
  // set when a user explicitly toggles a group — undefined falls back to
  // "open if non-empty" in the render, so newly-populated groups (e.g. a
  // discrepancy appearing) open on their own without clobbering a group the
  // user deliberately collapsed.
  const [groupOverrides, setGroupOverrides] = useState<Record<string, boolean>>({});
  // Completion confirmations — kept visible until the user dismisses them,
  // even after the underlying row drops out of the "open" list.
  const [completions, setCompletions] = useState<CompletionInfo[]>([]);
  const pushCompletion = useCallback((c: CompletionInfo) => {
    setCompletions((prev) => [c, ...prev.filter((x) => x.id !== c.id)]);
  }, []);
  const dismissCompletion = useCallback((id: string) => {
    setCompletions((prev) => prev.filter((x) => x.id !== id));
  }, []);
  // History dialog (timeline + communications) — shared across open/closed rows.
  const [historyRow, setHistoryRow] = useState<{ id: string; statement_number: string | null } | null>(null);
  // Pre-send dialog
  const [sendDialogOpen, setSendDialogOpen] = useState(false);
  const [pendingSend, setPendingSend] = useState<{ type: "statement"; id: string; recipients: string[] } | { type: "booking"; id: string; recipients: string[] } | null>(null);
  // Record Payment dialog state
  const [payRow, setPayRow] = useState<{ id: string; statement_number: string | null; balance_due: number } | null>(null);
  const [payAmount, setPayAmount] = useState("");
  const [payDate, setPayDate] = useState("");
  const [payMode, setPayMode] = useState("bank_transfer");
  const [payRef, setPayRef] = useState("");
  const [payNotes, setPayNotes] = useState("");
  const [paySubmitting, setPaySubmitting] = useState(false);
  // TDS deduction on this payment (declared explicitly, never inferred) —
  // mirrors the AR Receivables Record Payment dialog (billing/page.tsx).
  const [payTdsEnabled, setPayTdsEnabled] = useState(false);
  const [payTdsSection, setPayTdsSection] = useState("194I");
  const [payTdsAmount, setPayTdsAmount] = useState("");
  // Adjustment against deposit — same split-payment behavior as the shared
  // AR/Billing Record Payment dialog (record-payment-dialog.tsx).
  const [payDepositAvailable, setPayDepositAvailable] = useState<number | null>(null);
  const [payNotifyCustomer, setPayNotifyCustomer] = useState(false);
  const [payRemainderMode, setPayRemainderMode] = useState("bank_transfer");
  const [payRemainderRef, setPayRemainderRef] = useState("");

  // Auto-expand the first pi_paid_awaiting_gst row on initial load so accounts
  // can see the upload form without an extra click.
  const hasAutoExpanded = useRef(false);
  useEffect(() => {
    if (hasAutoExpanded.current || !data) return;
    const first = data.rows.find((r) => r.handoff_state === "pi_paid_awaiting_gst");
    if (first) {
      setExpandedId(first.statement_id);
      hasAutoExpanded.current = true;
    }
  }, [data]);

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

  // Re-fetch and patch a single statement instead of the whole list after a
  // row-level mutation (upload / send / record payment / close / GSTIN
  // save). The full inbox query joins across 5 owner types plus a 6-query
  // fan-out — doing that for every click when only one row actually changed
  // is what made the page feel slower with each successive action. The
  // ?id= mode is the same query scoped to one row, so it's cheap.
  // contractStats/visibleRows/groupedRows are memoized off `data`, so
  // patching data.rows here is enough for the whole UI to catch up —
  // nothing downstream needs to change.
  const refreshRow = useCallback(async (statementId: string) => {
    try {
      const res = await fetch(`/api/accounting/inbox?id=${encodeURIComponent(statementId)}`, { cache: "no-store" });
      if (!res.ok) return;
      const json = (await res.json()) as InboxResponse;
      const fresh = json.rows[0] as InboxRow | undefined;
      setData((prev) => {
        if (!prev) return prev;
        // Which tab we're viewing determines whether a state change should
        // make the row appear or disappear from the current list — e.g.
        // "mark accounted" should drop the row off "All open" immediately,
        // but a resend on the Closed tab should keep it right where it is.
        const isClosedTab = tab === "closed";
        const belongsHere = !!fresh && (isClosedTab
          ? (fresh.handoff_state === "complete" || fresh.is_voided)
          : (fresh.handoff_state !== "complete" && !fresh.is_voided));
        const idx = prev.rows.findIndex((r) => r.statement_id === statementId);
        let rows: InboxRow[];
        if (!belongsHere) {
          rows = idx === -1 ? prev.rows : prev.rows.filter((r) => r.statement_id !== statementId);
        } else if (idx === -1) {
          rows = [...prev.rows, fresh as InboxRow];
        } else {
          rows = prev.rows.map((r, i) => (i === idx ? (fresh as InboxRow) : r));
        }
        return rows === prev.rows ? prev : { ...prev, rows };
      });
    } catch {
      // Silent — worst case the row looks stale until the next natural
      // reload or manual Refresh click, which beats failing the action
      // that already succeeded server-side.
    }
  }, [tab]);

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

  const handleSend = useCallback((statementId: string, row: InboxRow) => {
    const lead = row.contract?.lead ?? row.proposal?.lead ?? row.invoice?.lead;
    const recipients = Array.from(new Set([
      lead?.email,
      ...(lead?.billing_emails ?? []),
    ].filter((e): e is string => !!e)));
    setPendingSend({ type: "statement", id: statementId, recipients });
    setSendDialogOpen(true);
  }, []);

  const handleSendConfirm = useCallback(async (extraRecipients: string[]) => {
    if (!pendingSend) return;
    const { type, id } = pendingSend;
    if (type === "statement") setSendingId(id);
    else setSendingBookingId(id);
    setActionError(null);
    setSendDialogOpen(false);
    try {
      const url = type === "statement"
        ? `/api/billing-statements/${id}/inbox-send`
        : `/api/booking-gst-tasks/${id}/inbox-send`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ extra_recipients: extraRecipients }),
      });
      const body = await res.json().catch(() => ({} as { error?: string; emailed_to?: string }));
      if (!res.ok) {
        throw new Error((body as { error?: string }).error || `HTTP ${res.status}`);
      }
      if (type === "statement") {
        const row = data?.rows.find((r) => r.statement_id === id);
        if (row) {
          pushCompletion({
            id,
            kind: "statement",
            partyName: partyDisplay(row),
            identifierLabel: row.statement_number ?? "—",
            amount: row.statement_total_amount,
            invoiceNumber: row.latest_upload?.tally_invoice_number ?? null,
            emailedTo: (body as { emailed_to?: string }).emailed_to ?? row.contract?.lead?.email ?? row.proposal?.lead?.email ?? row.invoice?.lead?.email ?? null,
            action: "invoice_sent",
          });
        }
      } else {
        const row = data?.booking_rows?.find((r) => r.task_id === id);
        if (row) {
          pushCompletion({
            id,
            kind: "booking",
            partyName: row.customer_name ?? row.customer_email ?? "(walk-in)",
            identifierLabel: row.booking_number ?? "—",
            amount: row.statement_total_amount,
            invoiceNumber: row.latest_upload?.tally_invoice_number ?? null,
            emailedTo: (body as { emailed_to?: string }).emailed_to ?? row.customer_email ?? null,
            action: "invoice_sent",
          });
        }
      }
      if (type === "statement") await refreshRow(id);
      else await load();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Send failed");
    } finally {
      setSendingId(null);
      setSendingBookingId(null);
      setPendingSend(null);
    }
  }, [pendingSend, load, refreshRow, data, pushCompletion]);

  const handleUploaded = useCallback(async (statementId: string) => {
    setExpandedId(null);
    await refreshRow(statementId);
  }, [refreshRow]);

  const handleBookingUploaded = useCallback(async (
    row: BookingInboxRow,
    info: { invoiceNumber: string; amount: number; emailedTo: string | null },
  ) => {
    setExpandedBookingId(null);
    pushCompletion({
      id: row.task_id,
      kind: "booking",
      partyName: row.customer_name ?? row.customer_email ?? "(walk-in)",
      identifierLabel: row.booking_number ?? "—",
      amount: info.amount,
      invoiceNumber: info.invoiceNumber,
      emailedTo: info.emailedTo,
      action: info.emailedTo ? "invoice_sent" : "marked_complete",
    });
    await load();
  }, [load, pushCompletion]);

  const handleClose = useCallback(async (statementId: string) => {
    setClosingId(statementId);
    setActionError(null);
    try {
      const res = await fetch(`/api/billing-statements/${statementId}/inbox-complete`, { method: "POST" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      const row = data?.rows.find((r) => r.statement_id === statementId);
      if (row) {
        pushCompletion({
          id: statementId,
          kind: "statement",
          partyName: partyDisplay(row),
          identifierLabel: row.statement_number ?? "—",
          amount: row.statement_total_amount,
          invoiceNumber: row.latest_upload?.tally_invoice_number ?? null,
          emailedTo: null,
          action: "marked_complete",
        });
      }
      await load();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Close failed");
    } finally {
      setClosingId(null);
    }
  }, [load, data, pushCompletion]);

  const handleResend = useCallback(async (statementId: string) => {
    setResendingId(statementId);
    setActionError(null);
    setSentConfirmedId(null);
    try {
      const res = await fetch(`/api/billing-statements/${statementId}/resend-gst-invoice`, { method: "POST" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      setSentConfirmedId(statementId);
      await refreshRow(statementId);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Resend failed");
    } finally {
      setResendingId(null);
    }
  }, [refreshRow]);

  const openPayDialog = useCallback((row: InboxRow) => {
    const balance = Math.max(0, row.statement_total_amount - (row.total_paid ?? 0));
    setPayRow({ id: row.statement_id, statement_number: row.statement_number, balance_due: balance });
    setPayAmount(String(balance));
    setPayDate(new Date().toISOString().slice(0, 10));
    setPayMode("bank_transfer");
    setPayRef("");
    setPayNotes("");
    setPayTdsEnabled(false);
    setPayTdsSection("194I");
    setPayTdsAmount("");
    setPayNotifyCustomer(false);
    setPayRemainderMode("bank_transfer");
    setPayRemainderRef("");
    setPayDepositAvailable(null);
    fetch(`/api/billing-statements/${row.statement_id}/deposit-balance`)
      .then((res) => (res.ok ? res.json() : null))
      .then((json) => setPayDepositAvailable(json?.data?.available ?? 0))
      .catch(() => setPayDepositAvailable(0));
  }, []);

  const isPayDepositMode = payMode === "deposit_adjustment";
  const payRequestedAmount = parseFloat(payAmount || "0");
  const payDepositLeg = isPayDepositMode ? Math.min(payRequestedAmount, payDepositAvailable ?? 0) : 0;
  const payRemainderLeg = isPayDepositMode ? Math.max(0, payRequestedAmount - (payDepositAvailable ?? 0)) : 0;

  const submitPayment = useCallback(async () => {
    if (!payRow) return;

    if (isPayDepositMode) {
      if (payDepositLeg <= 0) { setActionError("Enter a valid amount"); return; }
      if (payRemainderLeg > 0 && !payRemainderMode) { setActionError("Select a payment mode for the remainder"); return; }
      setPaySubmitting(true);
      setActionError(null);
      try {
        const depositRes = await fetch(`/api/billing-statements/${payRow.id}/deposit-adjustment`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ amount: payDepositLeg, notify_customer: payNotifyCustomer }),
        });
        const depositJson = await depositRes.json();
        if (!depositRes.ok) throw new Error(depositJson.error || "Failed to submit deposit adjustment request");

        if (payRemainderLeg > 0) {
          const remainderRes = await fetch(`/api/billing-statements/${payRow.id}/payment`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              amount: payRemainderLeg,
              payment_date: payDate,
              payment_mode: payRemainderMode,
              payment_reference: payRemainderRef || null,
              notes: payNotes || null,
            }),
          });
          if (!remainderRes.ok) {
            const remainderJson = await remainderRes.json().catch(() => ({}));
            setActionError(
              `Deposit adjustment of ${formatCurrency(payDepositLeg)} submitted for approval, but recording the ` +
              `${formatCurrency(payRemainderLeg)} remainder failed: ${remainderJson.error || "unknown error"}. Record it separately.`
            );
            setPayRow(null);
            await refreshRow(payRow.id);
            return;
          }
        }
        setPayRow(null);
        await refreshRow(payRow.id);
      } catch (e) {
        setActionError(e instanceof Error ? e.message : "Failed to submit deposit adjustment");
      } finally {
        setPaySubmitting(false);
      }
      return;
    }

    const amt = parseFloat(payAmount);
    if (!amt || amt <= 0) { setActionError("Enter a valid amount"); return; }
    const tdsAmt = payTdsEnabled ? Math.max(0, Number(payTdsAmount) || 0) : 0;
    if (payTdsEnabled && tdsAmt <= 0) { setActionError("Enter the TDS amount deducted by the client"); return; }
    if (payTdsEnabled && !payTdsSection) { setActionError("Select the TDS section"); return; }
    setPaySubmitting(true);
    setActionError(null);
    try {
      const res = await fetch(`/api/billing-statements/${payRow.id}/payment`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          amount: amt,
          payment_date: payDate,
          payment_mode: payMode,
          payment_reference: payRef || null,
          notes: payNotes || null,
          tds_amount: tdsAmt,
          tds_section: payTdsEnabled ? payTdsSection : null,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed");
      setPayRow(null);
      await refreshRow(payRow.id);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Failed to record payment");
    } finally {
      setPaySubmitting(false);
    }
  }, [payRow, payAmount, payDate, payMode, payRef, payNotes, payTdsEnabled, payTdsSection, payTdsAmount, refreshRow, isPayDepositMode, payDepositLeg, payRemainderLeg, payRemainderMode, payRemainderRef, payNotifyCustomer]);

  const handleAccounted = useCallback(async (statementId: string) => {
    setClosingId(statementId);
    setActionError(null);
    try {
      const res = await fetch(`/api/billing-statements/${statementId}/inbox-complete`, { method: "POST" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      const row = data?.rows.find((r) => r.statement_id === statementId);
      if (row) {
        pushCompletion({
          id: statementId,
          kind: "statement",
          partyName: partyDisplay(row),
          identifierLabel: row.statement_number ?? "—",
          amount: row.statement_total_amount,
          invoiceNumber: row.latest_upload?.tally_invoice_number ?? null,
          emailedTo: null,
          action: "marked_complete",
        });
      }
      await refreshRow(statementId);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Failed");
    } finally {
      setClosingId(null);
    }
  }, [refreshRow, data, pushCompletion]);

  const handleBookingSend = useCallback((taskId: string, row: BookingInboxRow) => {
    const recipients = Array.from(new Set([
      row.customer_email,
      ...(row.lead_billing_emails ?? []),
    ].filter((e): e is string => !!e)));
    setPendingSend({ type: "booking", id: taskId, recipients });
    setSendDialogOpen(true);
  }, []);

  const handleBookingClose = useCallback(async (taskId: string) => {
    setClosingBookingId(taskId);
    setActionError(null);
    try {
      const res = await fetch(`/api/booking-gst-tasks/${taskId}/inbox-complete`, { method: "POST" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      const row = data?.booking_rows?.find((r) => r.task_id === taskId);
      if (row) {
        pushCompletion({
          id: taskId,
          kind: "booking",
          partyName: row.customer_name ?? row.customer_email ?? "(walk-in)",
          identifierLabel: row.booking_number ?? "—",
          amount: row.statement_total_amount,
          invoiceNumber: row.latest_upload?.tally_invoice_number ?? null,
          emailedTo: null,
          action: "marked_complete",
        });
      }
      await load();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Close failed");
    } finally {
      setClosingBookingId(null);
    }
  }, [load, data, pushCompletion]);

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

  // Per-type stats — data.rows / data.booking_rows already come scoped to the
  // open/closed apiTab, so these are computed client-side (mirrors the
  // combined reduce the API does server-side for data.stats).
  const contractStats = useMemo(() => {
    const list = data?.rows ?? [];
    return list.reduce(
      (acc, r) => {
        acc.total_open += 1;
        if (r.has_discrepancy) acc.discrepancies += 1;
        else if (r.bucket === "gst_to_issue") acc.gst_to_issue += 1;
        else if (r.bucket === "payment_to_record") acc.payments_to_record += 1;
        if (r.aging_hours >= AGING_ESCALATE_HOURS) acc.aging_over_48h += 1;
        return acc;
      },
      { gst_to_issue: 0, payments_to_record: 0, discrepancies: 0, aging_over_48h: 0, total_open: 0 },
    );
  }, [data]);

  const bookingStats = useMemo(() => {
    const list = (data?.booking_rows ?? []).filter((r) =>
      tab === "closed" ? r.handoff_state === "complete" : r.handoff_state !== "complete",
    );
    return list.reduce(
      (acc, r) => {
        acc.total_open += 1;
        if (r.has_discrepancy) acc.discrepancies += 1;
        else if (r.bucket === "gst_to_issue") acc.gst_to_issue += 1;
        if (r.aging_hours >= AGING_ESCALATE_HOURS) acc.aging_over_48h += 1;
        return acc;
      },
      { gst_to_issue: 0, payments_to_record: 0, discrepancies: 0, aging_over_48h: 0, total_open: 0 },
    );
  }, [data, tab]);

  const activeStats = activeType === "contracts" ? contractStats : bookingStats;

  const visibleRows = useMemo(() => {
    if (!data) return [];
    if (tab === "all" || tab === "closed") return data.rows;
    if (tab === "discrepancy") return data.rows.filter((r) => r.has_discrepancy);
    return data.rows.filter((r) => r.bucket === tab && !r.has_discrepancy);
  }, [data, tab]);

  // Only meaningful on the "All open" tab, where rows needing five different
  // actions are otherwise interleaved by last-updated order. visibleRows is
  // already search-filtered (server-side), so grouping it directly keeps
  // groups in sync with the search box for free.
  const groupedRows = useMemo(() => {
    const map = new Map<ActionGroupKey, InboxRow[]>();
    for (const g of ACTION_GROUPS) map.set(g.key, []);
    for (const row of visibleRows) {
      map.get(getRowActionGroup(row))!.push(row);
    }
    return map;
  }, [visibleRows]);

  const visibleBookingRows = useMemo(() => {
    if (!data?.booking_rows) return [];
    const br = data.booking_rows;
    if (tab === "closed") return br.filter((r) => r.handoff_state === "complete");
    if (tab === "all") return br.filter((r) => r.handoff_state !== "complete");
    if (tab === "discrepancy") return br.filter((r) => r.has_discrepancy && r.handoff_state !== "complete");
    if (tab === "gst_to_issue") return br.filter((r) => r.bucket === "gst_to_issue" && !r.has_discrepancy && r.handoff_state !== "complete");
    return [];
  }, [data, tab]);

  // Shared row renderer so the flat list and the grouped-by-action sections
  // (both below) render identical rows — same props, same handlers.
  const renderStatementRow = (row: InboxRow) => (
    <InboxRowItem
      key={row.statement_id}
      row={row}
      expanded={expandedId === row.statement_id}
      sending={sendingId === row.statement_id}
      closing={closingId === row.statement_id}
      resending={resendingId === row.statement_id}
      sentConfirmed={sentConfirmedId === row.statement_id}
      onToggle={() => setExpandedId(expandedId === row.statement_id ? null : row.statement_id)}
      onSend={() => handleSend(row.statement_id, row)}
      onClose={() => handleAccounted(row.statement_id)}
      onResend={() => handleResend(row.statement_id)}
      onUploaded={() => handleUploaded(row.statement_id)}
      onCancelUpload={() => setExpandedId(null)}
      onGstinUpdated={() => void refreshRow(row.statement_id)}
      onRecordPayment={() => openPayDialog(row)}
      onViewHistory={() => setHistoryRow({ id: row.statement_id, statement_number: row.statement_number })}
    />
  );

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

      {/* Primary type tabs — Contracts (rental billing_statements) vs Bookings (walk-in booking_gst_tasks) */}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setActiveType("contracts")}
          className={`inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-semibold border transition-colors ${
            activeType === "contracts"
              ? "bg-foreground text-background border-foreground"
              : "bg-muted/40 text-muted-foreground border-transparent hover:bg-muted"
          }`}
        >
          Contracts
          <span className={`text-xs rounded-full px-1.5 py-0.5 ${activeType === "contracts" ? "bg-background/20" : "bg-muted-foreground/10"}`}>
            {contractStats.total_open}
          </span>
        </button>
        <button
          type="button"
          onClick={() => setActiveType("bookings")}
          className={`inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-semibold border transition-colors ${
            activeType === "bookings"
              ? "bg-foreground text-background border-foreground"
              : "bg-muted/40 text-muted-foreground border-transparent hover:bg-muted"
          }`}
        >
          Bookings
          <span className={`text-xs rounded-full px-1.5 py-0.5 ${activeType === "bookings" ? "bg-background/20" : "bg-muted-foreground/10"}`}>
            {bookingStats.total_open}
          </span>
        </button>
      </div>

      {/* Stat cards — scoped to the active type */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard label="GST to issue" value={activeStats.gst_to_issue} icon={FileText} />
        <StatCard label="Payments to record" value={activeStats.payments_to_record} icon={CheckCircle2} />
        <StatCard label="Discrepancies" value={activeStats.discrepancies} icon={AlertCircle} variant="danger" />
        <StatCard label={`Aging > ${AGING_ESCALATE_HOURS}h`} value={activeStats.aging_over_48h} icon={Clock} variant="warning" />
      </div>

      {/* Filter tabs + search */}
      <div className="border-b flex items-center gap-1 flex-wrap">
        {FILTER_TABS.map((t) => {
          // Counts are tab-aware: open tabs reflect the OPEN summary; the
          // Closed tab can't sensibly show a global count, so it shows the
          // page-size result only when we're on it.
          const count =
            t.key === "all" ? activeStats.total_open
            : t.key === "gst_to_issue" ? activeStats.gst_to_issue
            : t.key === "payment_to_record" ? activeStats.payments_to_record
            : t.key === "discrepancy" ? activeStats.discrepancies
            : t.key === "closed" && tab === "closed" ? (activeType === "contracts" ? visibleRows.length : visibleBookingRows.length)
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
      ) : (activeType === "contracts" ? visibleRows.length === 0 : visibleBookingRows.length === 0) ? (
        <EmptyState tab={tab} totalOpen={activeStats.total_open} />
      ) : (
        <>
          {actionError && (
            <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-900 flex items-start gap-2">
              <AlertCircle className="h-4 w-4 mt-0.5 flex-shrink-0" aria-hidden />
              <span>{actionError}</span>
            </div>
          )}
          {completions.map((c) => (
            <CompletionBanner key={c.id} completion={c} onDismiss={() => dismissCompletion(c.id)} />
          ))}
          {activeType === "contracts" && tab === "all" ? (
            <div className="space-y-2">
              {ACTION_GROUPS.map((g) => {
                const rows = groupedRows.get(g.key) ?? [];
                if (rows.length === 0) return null;
                const isOpen = groupOverrides[g.key] ?? true;
                return (
                  <div key={g.key} className={`rounded-lg border p-2.5 ${g.wrapCls}`}>
                    <button
                      type="button"
                      onClick={() => setGroupOverrides((prev) => ({ ...prev, [g.key]: !isOpen }))}
                      aria-expanded={isOpen}
                      className="w-full flex items-baseline gap-2 py-1 text-left"
                    >
                      <span className="text-sm font-semibold">{g.title}</span>
                      <span className="text-xs text-muted-foreground">({rows.length})</span>
                      <ChevronDown
                        className={`h-3.5 w-3.5 ml-auto text-muted-foreground flex-shrink-0 transition-transform ${isOpen ? "" : "-rotate-90"}`}
                        aria-hidden
                      />
                    </button>
                    <p className="text-xs text-muted-foreground mb-2">{g.caption}</p>
                    {isOpen && (
                      <ul className="rounded-lg border overflow-hidden divide-y bg-background" role="list">
                        {rows.map(renderStatementRow)}
                      </ul>
                    )}
                  </div>
                );
              })}
            </div>
          ) : (
            <ul className="rounded-lg border overflow-hidden divide-y" role="list">
              {activeType === "contracts" && visibleRows.map(renderStatementRow)}
              {activeType === "bookings" && visibleBookingRows.map((row) => (
                <BookingInboxRowItem
                  key={row.task_id}
                  row={row}
                  expanded={expandedBookingId === row.task_id}
                  sending={sendingBookingId === row.task_id}
                  closing={closingBookingId === row.task_id}
                  resending={resendingBookingId === row.task_id}
                  sentConfirmed={sentConfirmedBookingId === row.task_id}
                  onToggle={() => setExpandedBookingId(expandedBookingId === row.task_id ? null : row.task_id)}
                  onSend={() => handleBookingSend(row.task_id, row)}
                  onClose={() => handleBookingClose(row.task_id)}
                  onResend={() => handleBookingResend(row.task_id)}
                  onUploaded={() => void load()}
                  onInvoiceUploaded={(info) => handleBookingUploaded(row, info)}
                  onCancelUpload={() => setExpandedBookingId(null)}
                />
              ))}
            </ul>
          )}
          {tab === "closed" && activeType === "contracts" && (
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
      <Dialog open={!!payRow} onOpenChange={(o) => {
        if (!o) {
          setPayRow(null);
          setPayTdsEnabled(false);
          setPayTdsSection("194I");
          setPayTdsAmount("");
        }
      }}>
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
                    {(payDepositAvailable ?? 0) > 0 && (
                      <SelectItem value="deposit_adjustment">Adjustment against deposit</SelectItem>
                    )}
                  </SelectContent>
                </Select>
              </div>
              {!isPayDepositMode && (
                <div>
                  <Label>Reference (UTR / cheque # / txn id)</Label>
                  <Input value={payRef} onChange={(e) => setPayRef(e.target.value)} placeholder="optional" />
                </div>
              )}
              <div>
                <Label>Notes</Label>
                <Input value={payNotes} onChange={(e) => setPayNotes(e.target.value)} placeholder="optional" />
              </div>

              {/* ── Adjustment against deposit block ── */}
              {isPayDepositMode && (
                <div className="rounded-lg border border-teal-200 bg-teal-50/50 p-3 space-y-3">
                  <p className="text-xs text-muted-foreground">
                    Available deposit balance: <span className="font-semibold text-foreground">{formatCurrency(payDepositAvailable ?? 0)}</span>
                  </p>
                  <div className="rounded px-2.5 py-1.5 text-xs font-medium bg-white border border-teal-200">
                    {formatCurrency(payDepositLeg)} from deposit
                    {payRemainderLeg > 0 && <> + {formatCurrency(payRemainderLeg)} via another mode</>}
                    {" = "}{formatCurrency(payDepositLeg + payRemainderLeg)}
                  </div>
                  {payRemainderLeg > 0 && (
                    <div className="grid grid-cols-2 gap-3 pt-1 border-t border-teal-200">
                      <div className="space-y-1">
                        <Label className="text-xs">Remainder payment mode</Label>
                        <Select value={payRemainderMode} onValueChange={setPayRemainderMode}>
                          <SelectTrigger className="h-9 text-xs"><SelectValue /></SelectTrigger>
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
                      <div className="space-y-1">
                        <Label className="text-xs">Remainder reference</Label>
                        <Input
                          value={payRemainderRef}
                          onChange={(e) => setPayRemainderRef(e.target.value)}
                          placeholder="UTR or cheque number"
                          className="h-9 text-xs"
                        />
                      </div>
                    </div>
                  )}
                  <label className="flex items-center gap-2 text-xs cursor-pointer">
                    <Checkbox checked={payNotifyCustomer} onCheckedChange={(v) => setPayNotifyCustomer(v === true)} />
                    Email the customer a confirmation of this adjustment
                  </label>
                  <p className="text-[11px] text-muted-foreground">
                    This requires admin or manager approval before it settles — the deposit portion won&apos;t reduce
                    the balance due until approved.
                  </p>
                </div>
              )}

              {/* ── TDS deduction block (mirrors AR Receivables Record Payment) ── */}
              {!isPayDepositMode && (
              <div className="rounded-lg border border-border">
                <button
                  type="button"
                  className="w-full flex items-center justify-between px-3 py-2.5 text-sm hover:bg-muted/30 rounded-lg transition-colors"
                  onClick={() => { setPayTdsEnabled((v) => !v); if (!payTdsEnabled) setPayTdsAmount(""); }}
                >
                  <span className="flex items-center gap-2 font-medium">
                    <span className={`w-4 h-4 rounded border flex items-center justify-center text-xs ${payTdsEnabled ? "bg-teal-600 border-teal-600 text-white" : "border-gray-400"}`}>
                      {payTdsEnabled ? "✓" : ""}
                    </span>
                    Client deducted TDS on this payment
                  </span>
                  <span className="text-xs text-muted-foreground">TDS on income</span>
                </button>

                {payTdsEnabled && (
                  <div className="px-3 pb-3 pt-1 space-y-3 border-t">
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1">
                        <Label className="text-xs">TDS section *</Label>
                        <Select value={payTdsSection} onValueChange={setPayTdsSection}>
                          <SelectTrigger className="h-9 text-xs"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            {TDS_CLIENT_SECTIONS.map((s) => (
                              <SelectItem key={s.code} value={s.code} className="text-xs">
                                <span className="font-mono font-medium">{s.label}</span>
                                <span className="text-muted-foreground ml-1.5">— {s.description}</span>
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="space-y-1">
                        <Label className="text-xs">TDS amount (₹) *</Label>
                        <Input
                          type="number"
                          min={0.01}
                          step="any"
                          value={payTdsAmount}
                          onChange={(e) => setPayTdsAmount(e.target.value)}
                          placeholder="e.g. 1500"
                          className="h-9 text-xs"
                        />
                      </div>
                    </div>
                    {/* Live settlement preview */}
                    {parseFloat(payTdsAmount || "0") > 0 && (
                      <div className={`rounded px-2.5 py-1.5 text-xs font-medium ${
                        Math.abs((parseFloat(payAmount || "0") + parseFloat(payTdsAmount || "0")) - payRow.balance_due) < 1
                          ? "bg-emerald-50 text-emerald-800 border border-emerald-200"
                          : "bg-blue-50 text-blue-800 border border-blue-200"
                      }`}>
                        Cash {formatCurrency(parseFloat(payAmount || "0"))} + TDS {formatCurrency(parseFloat(payTdsAmount || "0"))}
                        {" = "}{formatCurrency(parseFloat(payAmount || "0") + parseFloat(payTdsAmount || "0"))}
                        {Math.abs((parseFloat(payAmount || "0") + parseFloat(payTdsAmount || "0")) - payRow.balance_due) < 1
                          ? " ✓ settles invoice"
                          : ""}
                      </div>
                    )}
                    <p className="text-[11px] text-muted-foreground">
                      Invoice settles as: cash received + TDS deducted = invoice total. Tally receipt splits bank + TDS ledger + party.
                    </p>
                  </div>
                )}
              </div>
              )}
            </div>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setPayRow(null)} disabled={paySubmitting}>Cancel</Button>
            <Button onClick={() => void submitPayment()} disabled={paySubmitting}>
              {paySubmitting
                ? <><Loader2 className="h-4 w-4 animate-spin mr-2" />{isPayDepositMode ? "Submitting…" : "Recording…"}</>
                : (isPayDepositMode ? "Submit for Approval" : "Record payment")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Pre-send confirmation dialog */}
      <InboxSendDialog
        open={sendDialogOpen}
        onOpenChange={(v) => { if (!v) setPendingSend(null); setSendDialogOpen(v); }}
        savedRecipients={pendingSend?.recipients ?? []}
        sending={!!(sendingId || sendingBookingId)}
        onConfirm={handleSendConfirm}
      />

      {/* History dialog — timeline + communications, open or closed rows */}
      <StatementHistoryDialog
        statementId={historyRow?.id ?? null}
        statementNumber={historyRow?.statement_number ?? null}
        onOpenChange={(open) => { if (!open) setHistoryRow(null); }}
      />
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

function CompletionBanner({ completion, onDismiss }: { completion: CompletionInfo; onDismiss: () => void }) {
  const c = completion;
  return (
    <div className="rounded-lg border border-green-200 bg-green-50 p-3 text-sm text-green-900 flex items-start gap-3">
      <CheckCircle2 className="h-4 w-4 mt-0.5 flex-shrink-0 text-green-600" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="font-medium">
          {c.action === "invoice_sent" ? "GST invoice sent" : "Marked complete"}
          {c.invoiceNumber && <> — <span className="font-mono">{c.invoiceNumber}</span></>}
        </p>
        <p className="text-xs text-green-800 mt-0.5">
          {c.identifierLabel} · {c.partyName} · {formatCurrency(c.amount)}
          {c.emailedTo && <> · emailed to <span className="font-medium">{c.emailedTo}</span></>}
        </p>
      </div>
      <button
        type="button"
        onClick={onDismiss}
        className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded border border-green-300 text-green-800 hover:bg-green-100 flex-shrink-0"
      >
        <Check className="h-3 w-3" /> Dismiss
      </button>
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

const InboxRowItem = memo(function InboxRowItem({
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
  onViewHistory,
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
  onViewHistory: () => void;
}) {
  const [gstinEditing, setGstinEditing] = useState(false);
  const [gstinInput, setGstinInput] = useState("");
  const [gstinSaving, setGstinSaving] = useState(false);
  const [gstinError, setGstinError] = useState<string | null>(null);
  // Auto-open the payment panel for pi_paid_awaiting_gst so the amount is
  // immediately visible — user can still collapse it via the toggle button.
  const [paymentOpen, setPaymentOpen] = useState(
    row.handoff_state === "pi_paid_awaiting_gst" && row.payments_received.length > 0,
  );

  const handleGstinSave = async () => {
    const val = gstinInput.trim().toUpperCase();
    if (!GSTIN_RE.test(val)) {
      setGstinError("Invalid GSTIN format (e.g. 29AABCU9603R1ZX)");
      return;
    }
    const leadId = row.contract?.lead?.id ?? row.proposal?.lead?.id ?? row.invoice?.lead?.id;
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
          {row.contract ? (
            <>
              <span className="font-mono">{row.contract.contract_number}</span>
              {row.contract.title && <span> · {row.contract.title}</span>}
              <span> · </span>
            </>
          ) : row.proposal ? (
            <>
              <span className="font-mono">{row.proposal.proposal_number}</span>
              <span className="text-[10px] ml-1 px-1 py-0.5 rounded bg-muted/60">Proposal PI</span>
              <span> · </span>
            </>
          ) : row.invoice ? (
            <>
              <span className="font-mono">{row.invoice.invoice_number}</span>
              <span className="text-[10px] ml-1 px-1 py-0.5 rounded bg-muted/60">Ad-hoc Invoice</span>
              <span> · </span>
            </>
          ) : null}
          <span className="font-mono">{row.statement_number ?? "(no number)"}</span>
          {row.latest_upload?.tally_invoice_number && (
            <span className="font-mono text-foreground"> → {row.latest_upload.tally_invoice_number}</span>
          )}
          <span> · {row.handoff_state ? HANDOFF_STATE_LABELS[row.handoff_state] : "Draft"}</span>
          {row.contract?.billing_mode === "gst_direct" && <span> · direct GST</span>}
          {row.tally_credit_note_number && (
            <span className="font-mono text-red-700" title="Cancelled via credit note">
              {" "}· Cancelled via {row.tally_credit_note_number}
            </span>
          )}
        </div>
        <div className={`text-xs ${agingClass} text-right`}>
          {aging < 1 ? "just now" : aging < 24 ? `${aging}h ago` : `${Math.floor(aging / 24)}d ago`}
        </div>

        {/* ── Line 3 ── pills: payment status · GSTIN · IRN req · Tally · period */}
        <div className="col-span-2 flex items-center gap-1.5 flex-wrap text-[11px]">
          {(() => {
            const ps = paymentStatusBadge(row.payment_status);
            return (
              <span className={`px-1.5 py-0.5 rounded border font-medium ${ps.cls}`} title="Payment status">
                {ps.label}
              </span>
            );
          })()}
          {(row.contract?.lead?.gst_number ?? row.proposal?.lead?.gst_number ?? row.invoice?.lead?.gst_number) ? (
            <span className="font-mono px-1.5 py-0.5 rounded bg-muted/60 text-muted-foreground" title="Customer GSTIN">
              {row.contract?.lead?.gst_number ?? row.proposal?.lead?.gst_number ?? row.invoice?.lead?.gst_number}
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
              onClick={() => (row.contract?.lead?.id ?? row.proposal?.lead?.id ?? row.invoice?.lead?.id) && setGstinEditing(true)}
              disabled={!(row.contract?.lead?.id ?? row.proposal?.lead?.id ?? row.invoice?.lead?.id)}
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
          <button
            type="button"
            onClick={onViewHistory}
            className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded border hover:bg-muted"
            title="Timeline and communications sent for this statement"
          >
            <History className="h-3 w-3" />
            History
          </button>
          {row.payments_received.length > 0 && (
            <button
              type="button"
              onClick={() => setPaymentOpen((v) => !v)}
              className={`inline-flex items-center gap-1 text-xs px-2 py-1 rounded border transition-colors ${
                paymentOpen ? "bg-green-50 border-green-300 text-green-800" : "hover:bg-muted"
              }`}
            >
              <IndianRupee className="h-3 w-3" />
              Payment ({row.payments_received.length})
              {paymentOpen ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
            </button>
          )}
          {!row.pi_was_cancelled && row.contract?.billing_mode !== "gst_direct" && (
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
              className={`inline-flex items-center gap-1 text-xs px-2 py-1 rounded ${
                row.handoff_state === "pi_paid_awaiting_gst"
                  ? "bg-foreground text-background hover:opacity-90"
                  : "border hover:bg-muted"
              }`}
              aria-expanded={expanded}
            >
              {expanded ? (
                <><ChevronUp className="h-3 w-3" /> Close</>
              ) : (
                <><Upload className="h-3 w-3" /> Upload GST invoice <ChevronDown className="h-3 w-3" /></>
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
              {sending ? "Sending…" : "Retry send"}
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
      {paymentOpen && row.payments_received.length > 0 && (
        <StatementPaymentPanel
          payments={row.payments_received}
          totalAmount={row.statement_total_amount}
          nextStepMessage={
            row.handoff_state === "pi_paid_awaiting_gst"
              ? "Statement fully paid — issue the GST invoice in Tally, then upload it here."
              : undefined
          }
        />
      )}
    </li>
  );
}, (prev, next) =>
  // Callback props are re-created every parent render regardless — comparing
  // them by reference would defeat the memo. They all just forward to
  // useCallback-stabilized handlers with `row` (or its id) as the argument,
  // so skipping a re-render when `row` itself hasn't changed is safe:
  // refreshRow() only creates a new row object for the one row that
  // actually changed, leaving every other row's reference untouched.
  prev.row === next.row &&
  prev.expanded === next.expanded &&
  prev.sending === next.sending &&
  prev.closing === next.closing &&
  prev.resending === next.resending &&
  prev.sentConfirmed === next.sentConfirmed
);

// ── Billing statement payment panel ────────────────────────────────────────

function StatementPaymentPanel({
  payments,
  totalAmount,
  nextStepMessage,
}: {
  payments: InboxPayment[];
  totalAmount: number;
  nextStepMessage?: string;
}) {
  const totalPaid = payments.reduce((s, p) => s + p.amount, 0);
  const isFullyPaid = Math.abs(totalPaid - totalAmount) < 0.5;

  return (
    <div className="mx-3 mb-2 md:mx-4 p-3 rounded-lg bg-green-50 border border-green-200 text-xs">
      <div className="flex items-center justify-between mb-2">
        <span className="font-medium text-green-900 flex items-center gap-1.5">
          <CheckCircle2 className="h-3.5 w-3.5" />
          Payment collected
        </span>
        <span className={`text-[10px] px-1.5 py-0.5 rounded border font-medium ${
          isFullyPaid
            ? "bg-green-100 text-green-800 border-green-300"
            : "bg-amber-100 text-amber-800 border-amber-200"
        }`}>
          {isFullyPaid ? "Fully paid" : `Partial · ${formatCurrency(totalPaid)} of ${formatCurrency(totalAmount)}`}
        </span>
      </div>
      <div className="space-y-2">
        {payments.map((p) => {
          const txnDate = new Date(p.payment_date).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
          const isRazorpay = !!p.razorpay_payment_id;
          return (
            <div key={p.id} className="rounded border border-green-200 bg-white/60 px-2.5 py-2 space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="font-semibold text-green-900 tabular-nums">{formatCurrency(p.amount)}</span>
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-100 text-green-800 border border-green-200 font-medium">
                  {paymentModeLabel(p.payment_mode)}
                </span>
              </div>
              {isRazorpay ? (
                <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-[11px]">
                  <span className="text-muted-foreground">Txn ID</span>
                  <span className="font-mono text-green-800 break-all">{p.razorpay_payment_id}</span>
                  <span className="text-muted-foreground">Transacted on</span>
                  <span>{txnDate}</span>
                  {p.settled === true ? (
                    <>
                      <span className="text-muted-foreground">Settled to bank</span>
                      <span className="text-green-700 font-medium">
                        {p.settled_at ? new Date(p.settled_at).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }) : "—"}
                      </span>
                      {p.settlement_utr && (
                        <>
                          <span className="text-muted-foreground">Bank UTR</span>
                          <span className="font-mono text-green-800">{p.settlement_utr}</span>
                        </>
                      )}
                    </>
                  ) : p.settled === false ? (
                    <>
                      <span className="text-muted-foreground">Settlement</span>
                      <span className="text-amber-700">Pending — not yet settled to bank</span>
                    </>
                  ) : (
                    <>
                      <span className="text-muted-foreground">Settlement</span>
                      <span className="text-muted-foreground italic">Not synced yet</span>
                    </>
                  )}
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-[11px]">
                  <span className="text-muted-foreground">Date recorded</span>
                  <span>{txnDate}</span>
                  {p.payment_reference && (
                    <>
                      <span className="text-muted-foreground">Reference</span>
                      <span className="font-mono text-green-800">{p.payment_reference}</span>
                    </>
                  )}
                  {p.recorded_by_name && (
                    <>
                      <span className="text-muted-foreground">Recorded by</span>
                      <span>{p.recorded_by_name}</span>
                    </>
                  )}
                </div>
              )}
              {p.notes && (
                <div className="text-[11px] text-green-800 border-t border-green-100 pt-1.5">
                  <span className="text-muted-foreground">Notes: </span>
                  {p.notes}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {nextStepMessage && (
        <div className="mt-2 pt-2 border-t border-green-200 flex items-center gap-1.5 text-green-800">
          <CheckCircle2 className="h-3.5 w-3.5 flex-shrink-0 text-green-600" aria-hidden />
          {nextStepMessage}
        </div>
      )}
    </div>
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
  const [zoomedUrl, setZoomedUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  if (confirmations.length === 0) {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded bg-amber-50 text-amber-800 border border-amber-200 flex-shrink-0">
        ⚠ Payment unverified
      </span>
    );
  }
  const latest = confirmations[0];
  const ref = latest.razorpay_payment_id ?? latest.payment_reference;

  const handleViewScreenshot = async () => {
    setLoading(true);
    try {
      const supabase = createClient();
      const { data } = await supabase.storage
        .from("crm-documents")
        .createSignedUrl(latest.screenshot_path!, 3600);
      if (data?.signedUrl) setZoomedUrl(data.signedUrl);
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <span className="inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded bg-green-50 text-green-800 border border-green-200 flex-shrink-0">
        <CheckCircle2 className="h-2.5 w-2.5" />
        Paid · {paymentModeLabel(latest.payment_mode)}{ref ? ` · ${ref.slice(-8)}` : ""}
        {latest.screenshot_path && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); handleViewScreenshot(); }}
            disabled={loading}
            title="View payment screenshot"
            className="ml-0.5 hover:text-green-950"
          >
            {loading ? <Loader2 className="h-2.5 w-2.5 animate-spin" /> : <ImageIcon className="h-2.5 w-2.5" />}
          </button>
        )}
      </span>

      {zoomedUrl && (
        <div
          className="fixed inset-0 z-[200] bg-black/80 flex flex-col items-center justify-center p-6 cursor-pointer"
          onClick={() => setZoomedUrl(null)}
        >
          <button
            className="absolute top-4 right-4 text-white/80 hover:text-white transition-colors"
            onClick={() => setZoomedUrl(null)}
          >
            <X className="h-8 w-8" />
          </button>
          <div className="bg-white rounded-2xl p-3 shadow-2xl max-w-[90vw] max-h-[85vh]" onClick={(e) => e.stopPropagation()}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={zoomedUrl}
              alt="UPI payment confirmation screenshot"
              className="max-w-[85vw] max-h-[80vh] object-contain rounded"
            />
          </div>
          <p className="text-white/40 text-xs mt-3">Tap anywhere to close</p>
        </div>
      )}
    </>
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
  const [zoomedUrl, setZoomedUrl] = useState<string | null>(null);
  const [loadingScreenshotId, setLoadingScreenshotId] = useState<string | null>(null);

  const handleViewScreenshot = useCallback(async (paymentId: string, screenshotPath: string) => {
    setLoadingScreenshotId(paymentId);
    try {
      const supabase = createClient();
      const { data } = await supabase.storage
        .from("crm-documents")
        .createSignedUrl(screenshotPath, 3600);
      if (data?.signedUrl) setZoomedUrl(data.signedUrl);
    } finally {
      setLoadingScreenshotId(null);
    }
  }, []);

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
      <div className="space-y-2">
        {confirmations.map((p) => {
          const txnDate = new Date(p.created_at).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
          const isRazorpay = !!p.razorpay_payment_id;
          return (
            <div key={p.id} className="rounded border border-green-200 bg-white/60 px-2.5 py-2 space-y-1.5">
              {/* Row 1: amount + mode */}
              <div className="flex items-center justify-between">
                <span className="font-semibold text-green-900 tabular-nums">{formatCurrency(p.amount)}</span>
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-100 text-green-800 border border-green-200 font-medium">
                  {paymentModeLabel(p.payment_mode)}
                </span>
              </div>
              {isRazorpay ? (
                /* Razorpay payment detail */
                <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-[11px]">
                  <span className="text-muted-foreground">Txn ID</span>
                  <span className="font-mono text-green-800 break-all">{p.razorpay_payment_id}</span>
                  <span className="text-muted-foreground">Transacted on</span>
                  <span>{txnDate}</span>
                  {p.settled === true ? (
                    <>
                      <span className="text-muted-foreground">Settled to bank</span>
                      <span className="text-green-700 font-medium">
                        {p.settled_at ? new Date(p.settled_at).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }) : "Yes"}
                      </span>
                      {p.settlement_utr && (
                        <>
                          <span className="text-muted-foreground">Bank UTR</span>
                          <span className="font-mono text-green-800">{p.settlement_utr}</span>
                        </>
                      )}
                    </>
                  ) : p.settled === false ? (
                    <>
                      <span className="text-muted-foreground">Settlement</span>
                      <span className="text-amber-700 font-medium">Pending — not yet settled to bank</span>
                    </>
                  ) : (
                    <>
                      <span className="text-muted-foreground">Settlement</span>
                      <span className="text-muted-foreground italic">Not synced yet</span>
                    </>
                  )}
                </div>
              ) : (
                /* Manual / offline payment detail */
                <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-[11px]">
                  <span className="text-muted-foreground">Date recorded</span>
                  <span>{txnDate}</span>
                  {p.payment_reference && (
                    <>
                      <span className="text-muted-foreground">Reference</span>
                      <span className="font-mono text-green-800">{p.payment_reference}</span>
                    </>
                  )}
                  {p.verification_notes && (
                    <>
                      <span className="text-muted-foreground">Notes</span>
                      <span className="text-green-900">{p.verification_notes}</span>
                    </>
                  )}
                </div>
              )}
              {p.screenshot_path && (
                <button
                  type="button"
                  className="inline-flex items-center gap-1 text-[11px] text-green-700 hover:text-green-900 underline underline-offset-2"
                  onClick={() => handleViewScreenshot(p.id, p.screenshot_path!)}
                  disabled={loadingScreenshotId === p.id}
                >
                  {loadingScreenshotId === p.id ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <ImageIcon className="h-3 w-3" />
                  )}
                  View payment screenshot
                </button>
              )}
            </div>
          );
        })}
      </div>

      {zoomedUrl && (
        <div
          className="fixed inset-0 z-[200] bg-black/80 flex flex-col items-center justify-center p-6 cursor-pointer"
          onClick={() => setZoomedUrl(null)}
        >
          <button
            className="absolute top-4 right-4 text-white/80 hover:text-white transition-colors"
            onClick={() => setZoomedUrl(null)}
          >
            <X className="h-8 w-8" />
          </button>
          <div className="bg-white rounded-2xl p-3 shadow-2xl max-w-[90vw] max-h-[85vh]" onClick={(e) => e.stopPropagation()}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={zoomedUrl}
              alt="UPI payment confirmation screenshot"
              className="max-w-[85vw] max-h-[80vh] object-contain rounded"
            />
          </div>
          <p className="text-white/40 text-xs mt-3">Tap anywhere to close</p>
        </div>
      )}
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
  onInvoiceUploaded,
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
  onInvoiceUploaded: (info: { invoiceNumber: string; amount: number; emailedTo: string | null }) => void;
  onCancelUpload: () => void;
}) {
  const [paymentOpen, setPaymentOpen] = useState(false);
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
    if (!row.lead_id) return;
    setGstinSaving(true);
    setGstinError(null);
    try {
      const res = await fetch(`/api/leads/${row.lead_id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ gst_number: val }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error || `HTTP ${res.status}`);
      }
      setGstinEditing(false);
      setGstinInput("");
      // Refresh inbox to pick up new GSTIN
      onUploaded();
    } catch (e) {
      setGstinError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setGstinSaving(false);
    }
  };

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
          ) : gstinEditing ? (
            <span className="flex items-center gap-1 flex-wrap">
              <input
                autoFocus
                type="text"
                value={gstinInput}
                onChange={(e) => { setGstinInput(e.target.value.toUpperCase()); setGstinError(null); }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void handleGstinSave();
                  if (e.key === "Escape") { setGstinEditing(false); setGstinInput(""); setGstinError(null); }
                }}
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
              onClick={() => row.lead_id && setGstinEditing(true)}
              disabled={!row.lead_id}
              className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-amber-50 text-amber-800 border border-amber-200 hover:bg-amber-100 disabled:opacity-40 disabled:cursor-not-allowed"
              title={row.lead_id ? "GSTIN missing — click to add" : "No lead linked to this booking"}
            >
              <Pencil className="h-2.5 w-2.5" />
              no GSTIN
            </button>
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
          onUploaded={onInvoiceUploaded}
          onCancel={onCancelUpload}
        />
      )}
    </li>
  );
}
