"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, Loader2, Users } from "lucide-react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { AttachmentPicker } from "@/components/queries/attachment-picker";
import { STATEMENT_PAYMENT_MODES, STATEMENT_PAYMENT_MODE_LABELS } from "@/lib/constants";
import { formatCurrency } from "@/lib/utils";
import {
  PAYMENT_REPORT_DUE_DAYS,
  PAYMENT_REPORT_STATUS_LABELS,
  validatePaymentReport,
  type PaymentReportStatus,
} from "@/lib/queries/payment-reports";
import { formatDate } from "@/lib/utils";

/**
 * "The customer says they've paid" — the form ops fill in when a payment
 * arrives outside the CRM and the confirmation lands in someone's WhatsApp
 * rather than in Razorpay.
 *
 * Open to every authenticated user by design (see the POST route), so this is
 * written for someone who does not work in accounts: no TDS, no ledger, no
 * allocation. Just what the customer told them, plus the screenshot.
 * Allocation to an invoice is accounts' job at verification.
 */
interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * 'contract' when the invoice is unknown (the common case),
   * 'billing_statement' when reporting against a specific one, or
   * 'proposal_deposit' / 'deposit_topup' for money with no invoice to
   * allocate to — the picker never appears for either (gated on the
   * `contractId` prop below, not on entityType).
   */
  entityType: "contract" | "billing_statement" | "proposal_deposit" | "deposit_topup";
  entityId: string | null;
  /** One-line context under the title: "Bluescale Analytics · TWV-C-0188". */
  partyLabel?: string | null;
  /** Prefills the amount when reporting against a specific invoice. */
  suggestedAmount?: number | null;
  /**
   * The invoice the reporter started from, pre-selected as what the payment
   * covers. Reporting from an AR row is a strong signal — they clicked that
   * invoice — but they can change it, because the customer may have named a
   * different one.
   */
  defaultStatementId?: string | null;
  /** Contract whose open invoices fill the picker. Null for statement-scoped reports. */
  contractId?: string | null;
  onReported: () => void;
}

interface StatementOption {
  id: string;
  statement_number: string | null;
  /** What the invoice is called on screen — GST number once one exists. */
  reference: string;
  balance_due: number;
}

interface ExistingReport {
  id: string;
  amount: number;
  paid_on: string;
  payment_mode: string;
  status: PaymentReportStatus;
  created_by: { full_name: string } | null;
  query: { id: string } | null;
  timeline?: {
    messages?: Array<{
      id: string;
      event_type: string;
      body: string | null;
      created_at: string;
      author: { full_name: string } | null;
    }>;
  } | null;
}

interface Balance {
  outstanding: number;
  pending: number;
  reportable: number;
}

const EVENT_LABELS: Record<string, string> = {
  resolved: "Resolved",
  reopened: "Reopened",
  retargeted: "Re-assigned",
  nudged: "Chased automatically",
  payment_verified: "Verified and recorded",
  payment_rejected: "Closed — no such payment",
};

export function ReportPaymentDialog({
  open, onOpenChange, entityType, entityId, partyLabel, suggestedAmount,
  defaultStatementId, contractId, onReported,
}: Props) {
  const [amount, setAmount] = useState("");
  const [paidOn, setPaidOn] = useState(new Date().toISOString().slice(0, 10));
  const [mode, setMode] = useState("neft");
  const [reference, setReference] = useState("");
  const [payerDiffers, setPayerDiffers] = useState(false);
  const [payerName, setPayerName] = useState("");
  const [note, setNote] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [statementId, setStatementId] = useState<string | null>(null);
  const [statements, setStatements] = useState<StatementOption[] | null>(null);
  const [existing, setExisting] = useState<ExistingReport[] | null>(null);
  const [balance, setBalance] = useState<Balance | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitAttempted, setSubmitAttempted] = useState(false);

  useEffect(() => {
    if (!open) return;
    setAmount(suggestedAmount && suggestedAmount > 0 ? String(Math.round(suggestedAmount)) : "");
    setSubmitAttempted(false);
    setPaidOn(new Date().toISOString().slice(0, 10));
    setMode("neft");
    setReference("");
    setPayerDiffers(false);
    setPayerName("");
    setNote("");
    setFiles([]);
    setStatementId(defaultStatementId ?? null);
  }, [open, suggestedAmount, defaultStatementId]);

  /**
   * Offer the contract's other open invoices, so a reporter told "we paid
   * last month's" can say so.
   *
   * A 403 here is expected, not an error: this endpoint is gated to the roles
   * that can see receivables, and reporting is open to everyone. Those
   * reporters simply keep the invoice they started from — the picker
   * disappears rather than the dialog breaking.
   */
  useEffect(() => {
    if (!open || !entityId) { setExisting(null); setBalance(null); return; }
    let cancelled = false;
    setExisting(null);
    setBalance(null);
    fetch(
      `/api/queries/payment-reports?entity_type=${encodeURIComponent(entityType)}&entity_id=${encodeURIComponent(entityId)}`,
      { cache: "no-store" },
    )
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (cancelled) return;
        setExisting(j?.items ?? []);
        setBalance(j?.balance ?? null);
      })
      .catch(() => { if (!cancelled) { setExisting([]); setBalance(null); } });
    return () => { cancelled = true; };
  }, [open, entityType, entityId]);

  useEffect(() => {
    if (!open || !contractId) { setStatements(null); return; }
    let cancelled = false;
    fetch(`/api/contracts/${encodeURIComponent(contractId)}/open-statements`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (!cancelled) setStatements(j?.data ?? null); })
      .catch(() => { if (!cancelled) setStatements(null); });
    return () => { cancelled = true; };
  }, [open, contractId]);

  async function submit() {
    if (!entityId) return;

    // Validated with the same pure function the server uses, so the message
    // ops see is the message the API would have sent back.
    const check = validatePaymentReport(
      { amount, paid_on: paidOn, payment_mode: mode, payment_reference: reference, payer_name: payerName, payer_differs: payerDiffers },
      new Date(),
    );
    if (!check.ok) {
      toast.error(check.error);
      return;
    }

    const meta = {
      entity_type: entityType,
      entity_id: entityId,
      ...check.value,
      claimed_statement_id: statementId ?? undefined,
      note: note.trim() || undefined,
    };

    setSubmitting(true);
    let init: RequestInit;
    if (files.length === 0) {
      init = { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(meta) };
    } else {
      const form = new FormData();
      form.append("meta", JSON.stringify(meta));
      for (const f of files) form.append("file", f);
      init = { method: "POST", body: form };
    }

    const res = await fetch("/api/queries/payment-reports", init);
    const json = await res.json().catch(() => ({}));
    setSubmitting(false);

    if (!res.ok) {
      toast.error(json.error || "Could not report this payment");
      return;
    }
    const openThread = json.query_id
      ? {
          label: "View",
          onClick: () => { window.location.href = `/queries?open=${json.query_id}`; },
        }
      : undefined;

    if (json.attachments_failed?.length) {
      toast.warning(`Reported, but these attachments failed: ${json.attachments_failed.join(", ")}`, {
        action: openThread,
      });
    } else {
      // Linking straight to the thread matters more than it looks: a report
      // you just filed is not "awaiting you", so it does not appear on the
      // Queries page's default tab and people concluded it hadn't saved.
      toast.success("Sent to accounts to verify against the bank", { action: openThread });
    }
    onOpenChange(false);
    onReported();
  }

  const amountNum = Number(amount);
  const pendingReports = (existing ?? []).filter((r) => r.status === "reported");
  // Only block on a *loaded* balance. A failed lookup must not silently
  // become "nothing left to report" and lock someone out of reporting.
  const fullyReported = !!balance && balance.reportable <= 0 && pendingReports.length > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Report payment received</DialogTitle>
          {partyLabel && <p className="text-sm text-muted-foreground mt-1">{partyLabel}</p>}
        </DialogHeader>

        <div className="space-y-3">
          {(existing ?? []).length > 0 && (
            <div className={`rounded-md border p-3 space-y-2.5 ${
              pendingReports.length > 0 ? "border-amber-200 bg-amber-50" : "border-border bg-muted/40"
            }`}>
              <div className={`flex items-center gap-1.5 text-xs font-medium ${
                pendingReports.length > 0 ? "text-amber-900" : "text-muted-foreground"
              }`}>
                <AlertTriangle className="h-3.5 w-3.5 flex-none" />
                {pendingReports.length > 0
                  ? "Already reported, waiting on accounts"
                  : "Previously reported on this transaction"}
              </div>
              {existing!.map((rep) => (
                <div key={rep.id} className="rounded border bg-background/70 p-2 space-y-1.5">
                  <div className="flex items-baseline justify-between gap-2 text-xs">
                    <span className="font-semibold tabular-nums">{formatCurrency(rep.amount)}</span>
                    <span className={`px-1.5 py-0.5 rounded-full border text-[10px] ${
                      rep.status === "reported"
                        ? "text-amber-800 border-amber-300"
                        : rep.status === "verified"
                          ? "text-green-800 border-green-300"
                          : "text-red-800 border-red-300"
                    }`}>
                      {PAYMENT_REPORT_STATUS_LABELS[rep.status]}
                    </span>
                  </div>
                  <div className="text-[11px] text-muted-foreground">
                    {formatDate(rep.paid_on)} · {STATEMENT_PAYMENT_MODE_LABELS[rep.payment_mode] ?? rep.payment_mode}
                    {rep.created_by ? ` · reported by ${rep.created_by.full_name}` : ""}
                  </div>
                  {(rep.timeline?.messages ?? []).length > 0 && (
                    <ol className="space-y-0.5 border-t pt-1.5">
                      {[...(rep.timeline!.messages ?? [])]
                        .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))
                        .map((m) => (
                          <li key={m.id} className="text-[11px] text-muted-foreground leading-snug">
                            <span className="font-medium text-foreground">
                              {EVENT_LABELS[m.event_type] ?? m.author?.full_name ?? "Note"}
                            </span>
                            {/* A plain message already renders as its author's
                                name above, so naming them again reads as
                                "Noorul (Noorul)". Only typed events need the
                                actor spelled out separately. */}
                            {m.event_type !== "message" && m.author ? ` by ${m.author.full_name}` : ""}
                            {" · "}{formatDate(m.created_at)}
                            {m.body ? <span className="block">{m.body}</span> : null}
                          </li>
                        ))}
                    </ol>
                  )}
                  {rep.query?.id && (
                    <a
                      href={`/queries?open=${rep.query.id}`}
                      className="text-[11px] text-teal-700 underline hover:no-underline inline-block"
                    >
                      Open the thread
                    </a>
                  )}
                </div>
              ))}
              {balance && balance.reportable > 0 && (
                <p className="text-[11px] text-amber-900">
                  {formatCurrency(balance.reportable)} of {formatCurrency(balance.outstanding)} is still
                  unreported — report only the part that hasn&apos;t been claimed yet.
                </p>
              )}
              {fullyReported && (
                <p className="text-[11px] text-amber-900">
                  The full outstanding amount is already reported. There is nothing further to report until
                  accounts verify or reject it.
                </p>
              )}
            </div>
          )}

          {entityType === "proposal_deposit" && (
            <p className="text-xs rounded-md border border-violet-200 bg-violet-50 text-violet-900 p-2.5">
              Security deposit. Once accounts confirm it against the bank it is recorded on the
              proposal and appears in the Tally Inbox for booking.
            </p>
          )}

          {entityType === "deposit_topup" && (
            <p className="text-xs rounded-md border border-purple-200 bg-purple-50 text-purple-900 p-2.5">
              Deposit top-up. Once accounts confirm it against the bank it is recorded on the
              top-up and appears in the Tally Inbox for booking.
            </p>
          )}

          {!fullyReported && (
          <>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label className="text-xs">Amount</Label>
              <Input
                type="number"
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="0"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Paid on</Label>
              <Input type="date" value={paidOn} onChange={(e) => setPaidOn(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">How they paid</Label>
              <Select value={mode} onValueChange={setMode}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {STATEMENT_PAYMENT_MODES.map((m) => (
                    <SelectItem key={m.value} value={m.value}>{m.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">UTR / cheque no.</Label>
              <Input
                value={reference}
                onChange={(e) => setReference(e.target.value)}
                placeholder="If you have it"
              />
            </div>
          </div>

          {statements && statements.length > 0 && (
            <div className="space-y-1">
              <Label className="text-xs">Which invoice did they say this pays?</Label>
              <Select
                value={statementId ?? "unknown"}
                onValueChange={(v) => setStatementId(v === "unknown" ? null : v)}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {statements.map((st) => (
                    <SelectItem key={st.id} value={st.id}>
                      {st.reference} · {formatCurrency(st.balance_due)} due
                    </SelectItem>
                  ))}
                  <SelectItem value="unknown">They didn&apos;t say</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-[11px] text-muted-foreground">
                Accounts can&apos;t tell this from the bank credit — only you have the customer&apos;s message.
              </p>
            </div>
          )}

          {/*
            The remitter block earns its prominence: a credit from an account
            whose name doesn't match the contracting entity is the case
            accounts genuinely cannot resolve on their own.
          */}
          <div className="rounded-md border border-amber-200 bg-amber-50 p-3 space-y-2">
            <label className="flex items-start gap-2 cursor-pointer">
              <Checkbox
                checked={payerDiffers}
                onCheckedChange={(v) => setPayerDiffers(v === true)}
                className="mt-0.5"
              />
              <span className="text-xs text-amber-900 leading-snug">
                Paid from a different account than the contracting entity
              </span>
            </label>
            {payerDiffers && (
              <div className="space-y-1">
                <Label className="text-xs text-amber-900">Name on that account</Label>
                <Input
                  value={payerName}
                  onChange={(e) => setPayerName(e.target.value)}
                  placeholder="e.g. R. Menon (personal a/c)"
                  className="bg-background"
                />
                <p className="text-[11px] text-amber-800">
                  Without this, accounts see an unidentified credit and can&apos;t match it.
                </p>
              </div>
            )}
          </div>

          <div className="space-y-1">
            <Label className="text-xs">Anything else accounts should know</Label>
            <Textarea
              rows={2}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Optional — e.g. which invoices the customer thinks this covers"
            />
          </div>

          <AttachmentPicker files={files} onChange={setFiles} disabled={submitting} />

          <p className="text-[11px] text-muted-foreground flex items-center gap-1.5">
            <Users className="h-3 w-3 flex-none" />
            Goes to Accounts to check against the bank, due in {PAYMENT_REPORT_DUE_DAYS} days.
            Nothing is marked paid until they confirm it.
          </p>
          </>
          )}
        </div>

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            {fullyReported ? "Close" : "Cancel"}
          </Button>
          {!fullyReported && (
          <Button onClick={submit} disabled={submitting || !entityId}>
            {submitting && <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />}
            Send{amountNum > 0 ? ` ${formatCurrency(amountNum)}` : ""} to accounts
          </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
