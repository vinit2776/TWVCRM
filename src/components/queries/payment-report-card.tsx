"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, Check, Loader2, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { RecordPaymentDialog } from "@/components/billing/record-payment-dialog";
import { RecordOtherPaymentDialog } from "@/components/billing/record-other-payment-dialog";
import { formatCurrency, formatDate } from "@/lib/utils";
import { STATEMENT_PAYMENT_MODE_LABELS, USER_ROLE_LABELS } from "@/lib/constants";
import { useCurrentUser } from "@/providers/current-user-provider";
import {
  PAYMENT_REPORT_STATUS_COLORS,
  PAYMENT_REPORT_STATUS_LABELS,
  canReviewPaymentReport,
} from "@/lib/queries/payment-reports";
import type { QueryPaymentReport } from "@/lib/queries/types";

/**
 * The structured half of a reported payment, shown at the top of its thread.
 *
 * Everyone authorized on the thread sees the claim; only accounts and admins
 * see the three action buttons, because only they can look at the bank.
 *
 * Verification deliberately routes through the ordinary Record Payment
 * dialog rather than recording a payment from here. That dialog owns TDS
 * capture, deposit adjustment and the Tally receipt hook — a shortcut that
 * wrote a billing_payments row directly would quietly skip all three, which
 * is how the AR page once ended up with its own payment form that silently
 * lacked TDS.
 */
interface Props {
  report: QueryPaymentReport;
  entityType: string;
  entityId: string;
  /**
   * Display fields from the thread's entity summary. Only used to label the
   * deposit-recording dialog, which shows who and how much rather than
   * making accounts look it up again.
   */
  entityTitle?: string | null;
  entityReference?: string | null;
  /** The deposit required (or already received). Drives the shortfall check. */
  entityAmount?: number | null;
  /** Refresh the thread after any outcome. */
  onChanged: () => void;
}

interface StatementOption {
  id: string;
  statement_number: string | null;
  total_amount: number;
  balance_due: number;
}

export function PaymentReportCard({
  report, entityType, entityId, entityTitle, entityReference, entityAmount, onChanged,
}: Props) {
  // A deposit is recorded on the proposal itself, so there is no invoice to
  // allocate to and no billing_payments row to link. Verification proves
  // itself differently — see the verify route.
  const isDeposit = report.target_kind === "deposit";
  const { user } = useCurrentUser();
  const canReview = canReviewPaymentReport(user?.role) && report.status === "reported";

  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<"idle" | "not_found" | "rejected">("idle");
  const [note, setNote] = useState("");

  // Statement allocation — only needed when the report hangs off a contract,
  // which is the common case: the reporter knew the customer, not the invoice.
  const [statements, setStatements] = useState<StatementOption[] | null>(null);
  // Pre-selected from what the reporter was told. Accounts only ever see a
  // bank credit with no invoice reference, so asking them to choose from
  // scratch asks the one person in the loop who cannot know. Still editable:
  // customers do name the wrong invoice.
  const [statementId, setStatementId] = useState<string | null>(
    report.claimed_statement_id ?? (entityType === "billing_statement" ? entityId : null),
  );
  const [recordOpen, setRecordOpen] = useState(false);

  const needsAllocation = entityType === "contract" && !isDeposit;

  useEffect(() => {
    if (!canReview || !needsAllocation) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `/api/contracts/${encodeURIComponent(entityId)}/open-statements`,
          { cache: "no-store" },
        );
        if (!res.ok) throw new Error();
        const json = (await res.json()) as { data?: StatementOption[] };
        if (cancelled) return;
        const rows = json.data ?? [];
        setStatements(rows);
        // Only fall back to "the only open invoice" when the reporter didn't
        // say. Their answer always wins over the guess.
        if (rows.length === 1 && !report.claimed_statement_id) setStatementId(rows[0].id);
      } catch {
        if (!cancelled) setStatements([]);
      }
    })();
    return () => { cancelled = true; };
  }, [canReview, needsAllocation, entityId, report.claimed_statement_id]);

  const settle = useCallback(
    async (outcome: "verified" | "not_found" | "rejected", billingPaymentId?: string) => {
      setBusy(true);
      const res = await fetch(`/api/queries/payment-reports/${report.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          outcome,
          billing_payment_id: billingPaymentId,
          note: note.trim() || undefined,
        }),
      });
      const json = await res.json().catch(() => ({}));
      setBusy(false);
      if (!res.ok) {
        toast.error(json.error || "Could not update this report");
        return;
      }
      toast.success(
        outcome === "verified"
          ? "Payment verified and recorded"
          : outcome === "rejected"
            ? "Report closed as no such payment"
            : "Reporter told it isn't in the bank yet",
      );
      setMode("idle");
      setNote("");
      onChanged();
    },
    [report.id, note, onChanged],
  );

  const modeLabel = STATEMENT_PAYMENT_MODE_LABELS[report.payment_mode] ?? report.payment_mode;
  const tone = PAYMENT_REPORT_STATUS_COLORS[report.status];

  return (
    <>
      <div className={`rounded-md border p-3 space-y-2.5 ${tone}`}>
        <div className="flex items-baseline justify-between gap-2 flex-wrap">
          <span className="text-lg font-semibold tabular-nums">{formatCurrency(report.amount)}</span>
          <span className="text-[11px] px-2 py-0.5 rounded-full border bg-background/70">
            {PAYMENT_REPORT_STATUS_LABELS[report.status]}
          </span>
        </div>

        <dl className="text-xs space-y-0.5">
          <Row label="Paid on" value={`${formatDate(report.paid_on)} · ${modeLabel}`} />
          {report.payment_reference && <Row label="Reference" value={report.payment_reference} mono />}
          {report.payer_differs && report.payer_name && (
            <Row label="Remitter" value={report.payer_name} emphasis />
          )}
          {report.claimed_statement?.statement_number && (
            <Row label="Against invoice" value={report.claimed_statement.statement_number} emphasis />
          )}
          <Row
            label="Reported by"
            value={`${report.created_by.full_name} (${USER_ROLE_LABELS[report.created_by.role] ?? report.created_by.role})`}
          />
          {report.reviewed_by && report.reviewed_at && (
            <Row
              label={report.status === "verified" ? "Verified by" : "Closed by"}
              value={`${report.reviewed_by.full_name} · ${formatDate(report.reviewed_at)}`}
            />
          )}
        </dl>

        {report.payer_differs && report.payer_name && report.status === "reported" && (
          <p className="text-[11px] flex items-start gap-1.5">
            <AlertTriangle className="h-3 w-3 mt-0.5 flex-none" />
            The bank credit will show <span className="font-medium">{report.payer_name}</span>, not the
            contracting entity.
          </p>
        )}

        {report.status !== "reported" && report.resolution_note && (
          <p className="text-xs italic border-t pt-2 opacity-90">{report.resolution_note}</p>
        )}

        {canReview && (
          <div className="space-y-2 border-t pt-2.5">
            {needsAllocation && (
              <div className="space-y-1">
                <label className="text-[11px] font-medium">
                  {report.claimed_statement_id ? "Allocate to invoice — as reported" : "Allocate to invoice"}
                </label>
                {statements === null ? (
                  <div className="text-[11px] flex items-center gap-1.5 opacity-80">
                    <Loader2 className="h-3 w-3 animate-spin" /> Loading outstanding invoices…
                  </div>
                ) : statements.length === 0 ? (
                  <p className="text-[11px] opacity-80">
                    No outstanding invoices on this contract. Record it against the right statement from
                    the Billing page, then come back and verify.
                  </p>
                ) : (
                  <Select value={statementId ?? ""} onValueChange={setStatementId}>
                    <SelectTrigger className="h-8 text-xs bg-background">
                      <SelectValue placeholder="Which invoice does this pay?" />
                    </SelectTrigger>
                    <SelectContent>
                      {statements.map((s) => (
                        <SelectItem key={s.id} value={s.id}>
                          {s.statement_number ?? "Draft"} · {formatCurrency(s.balance_due)} due
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </div>
            )}

            {mode !== "idle" && (
              <Textarea
                rows={2}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder={
                  mode === "rejected"
                    ? "Why is this not a real payment? The reporter has to go back to the customer with this."
                    : "What did you check? e.g. not on the 12–14 Aug statements."
                }
                className="text-xs bg-background"
              />
            )}

            <div className="flex flex-wrap gap-1.5">
              {mode === "idle" ? (
                <>
                  <Button
                    size="sm"
                    className="h-7 text-xs bg-green-600 hover:bg-green-700"
                    disabled={busy || (!isDeposit && !statementId)}
                    title={
                      isDeposit
                        ? "Record this deposit against the proposal"
                        : statementId
                          ? "Record this payment against the invoice"
                          : "Pick which invoice this pays first"
                    }
                    onClick={() => setRecordOpen(true)}
                  >
                    <Check className="h-3 w-3 mr-1" /> Verify and record
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs bg-background"
                    disabled={busy}
                    onClick={() => setMode("not_found")}
                  >
                    <Search className="h-3 w-3 mr-1" /> Not found yet
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs bg-background text-red-700 border-red-200 hover:bg-red-50"
                    disabled={busy}
                    onClick={() => setMode("rejected")}
                  >
                    <X className="h-3 w-3 mr-1" /> No such payment
                  </Button>
                </>
              ) : (
                <>
                  <Button
                    size="sm"
                    className="h-7 text-xs"
                    disabled={busy || (mode === "rejected" && !note.trim())}
                    onClick={() => settle(mode)}
                  >
                    {busy && <Loader2 className="h-3 w-3 mr-1 animate-spin" />}
                    {mode === "rejected" ? "Close as no such payment" : "Send update to reporter"}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 text-xs"
                    disabled={busy}
                    onClick={() => { setMode("idle"); setNote(""); }}
                  >
                    Cancel
                  </Button>
                </>
              )}
            </div>

            {mode === "idle" && (
              <p className="text-[11px] opacity-80">
                &ldquo;Not found yet&rdquo; keeps this open and chasing. Only close it if the payment
                genuinely doesn&apos;t exist.
              </p>
            )}
          </div>
        )}
      </div>

      {isDeposit && recordOpen && (
        <RecordOtherPaymentDialog
          row={{
            id: entityId,
            kind: "deposit",
            reference: entityReference ?? "Deposit",
            party_name: entityTitle ?? "",
            total_amount: entityAmount ?? report.amount,
            balance_due: entityAmount ?? report.amount,
            due_date: null,
            days_overdue: null,
            payment_link_url: null,
            is_stale: false,
            followup_enabled: false,
            reminder_count: 0,
            href: null,
          }}
          onClose={() => setRecordOpen(false)}
          onDone={() => {
            setRecordOpen(false);
            // The route re-reads the proposal and refuses unless its
            // deposit_payment_status is actually 'paid', so this can't mark a
            // report verified off the back of a dialog that only looked like
            // it worked.
            void settle("verified");
          }}
        />
      )}

      {!isDeposit && (
      <RecordPaymentDialog
        open={recordOpen}
        onOpenChange={setRecordOpen}
        statementId={statementId}
        balanceDue={null}
        partyLabel={`Verifying a payment reported by ${report.created_by.full_name}`}
        prefill={{
          amount: report.amount,
          date: report.paid_on,
          mode: report.payment_mode,
          reference: report.payment_reference,
        }}
        onSuccess={(paymentId) => {
          if (!paymentId) {
            // The deposit-adjustment route creates no payment, so there is
            // nothing to verify against. Say so rather than marking the
            // report verified with a dangling reference.
            toast.warning(
              "That went through as a deposit adjustment, so there's no payment to verify against yet. " +
              "The report is still open.",
            );
            onChanged();
            return;
          }
          void settle("verified", paymentId);
        }}
      />
      )}
    </>
  );
}

function Row({ label, value, mono, emphasis }: {
  label: string; value: string; mono?: boolean; emphasis?: boolean;
}) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="opacity-75 flex-none">{label}</dt>
      <dd className={`text-right ${mono ? "font-mono text-[11px]" : ""} ${emphasis ? "font-medium" : ""}`}>
        {value}
      </dd>
    </div>
  );
}
