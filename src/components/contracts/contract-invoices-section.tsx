"use client";

import { useState, useEffect, useMemo } from "react";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Loader2, ExternalLink, FileText, Receipt, FileCheck, Zap, AlertTriangle, CalendarPlus } from "lucide-react";
import { formatCurrency, formatDate } from "@/lib/utils";
import { unbilledMonths } from "@/lib/billing-months";
import { toast } from "sonner";
import { StatementLifecycleBadge, StatementQuickActions } from "@/components/accounting/statement-lifecycle";

interface Statement {
  id: string;
  statement_number: string;
  contract_id: string | null;
  billed_on_behalf_of_contract_id: string | null;
  statement_type: string;
  prepaid_month: number | null;
  prepaid_year: number | null;
  voided_at: string | null;
  period_start: string;
  period_end: string;
  total_amount: number;
  status: string;
  payment_status: string | null;
  gst_invoice_number: string | null;
  gst_invoice_path: string | null;
  razorpay_payment_link_url: string | null;
  finalized_at: string | null;
  pi_cancelled_at: string | null;
}

const STATEMENT_STATUS_LABELS: Record<string, string> = {
  draft: "Draft",
  finalized: "Finalized",
  exported: "Exported",
  voided: "Voided",
};

const STATEMENT_STATUS_COLORS: Record<string, string> = {
  draft: "bg-gray-100 text-gray-700 border-gray-200",
  finalized: "bg-blue-50 text-blue-700 border-blue-200",
  exported: "bg-purple-50 text-purple-700 border-purple-200",
  voided: "bg-red-50 text-red-600 border-red-200",
};

const PAYMENT_STATUS_LABELS: Record<string, string> = {
  unpaid: "Unpaid",
  partially_paid: "Partial",
  paid: "Paid",
};

const PAYMENT_STATUS_COLORS: Record<string, string> = {
  unpaid: "bg-red-50 text-red-700 border-red-200",
  partially_paid: "bg-amber-50 text-amber-700 border-amber-200",
  paid: "bg-green-50 text-green-700 border-green-200",
};

// The proforma-pdf route 400s on draft/voided statements — their numbers
// aren't locked yet, so there's nothing to render. Keep this in sync with
// the status checks in src/app/api/billing-statements/[id]/proforma-pdf/route.ts.
function canPreviewPdf(status: string) {
  return status !== "draft" && status !== "voided";
}

function periodLabel(start: string, end: string) {
  const s = new Date(start + "T00:00:00Z");
  const e = new Date(end + "T00:00:00Z");
  const month = s.toLocaleString("en-IN", { month: "short", timeZone: "UTC" });
  const year = s.getUTCFullYear();
  // If period spans a single calendar month, show "Jun 2025"; otherwise show date range
  if (s.getUTCMonth() === e.getUTCMonth() && s.getUTCFullYear() === e.getUTCFullYear()) {
    return `${month} ${year}`;
  }
  return `${formatDate(start)} – ${formatDate(end)}`;
}

interface ContractInvoicesSectionProps {
  contractId: string;
  billingMode?: 'proforma_first' | 'gst_direct' | null;
  contractStatus?: string;
  /** Proposal linked to this contract — the pro-rata invoice that was
   *  collected before activation lives on the proposal, not the contract,
   *  so it needs its own lookup rather than showing up in `statements`. */
  proposalId?: string;
  proposalNumber?: string;
  prorataPaymentStatus?: string;
  prorataPaymentReceivedAt?: string;
  billingCycle?: string | null;
  nextBillingDate?: string | null;
  startDate?: string | null;
  endDate?: string | null;
  createdAt?: string | null;
}

/** One rent line the upcoming-cycle preview would bill. */
interface CyclePreviewLine {
  description: string;
  amount: number;
  qty?: number;
  unit_price?: number;
  note?: string;
}

interface CyclePreview {
  period_label: string;
  subtotal: number;
  tax_amount: number;
  total_amount: number;
  line_items?: CyclePreviewLine[];
  note?: string;
}

const BILLING_ROLES = ["admin", "manager", "accounts"];

const MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function ContractInvoicesSection({
  contractId,
  billingMode,
  contractStatus,
  proposalId,
  proposalNumber,
  prorataPaymentStatus,
  prorataPaymentReceivedAt,
  billingCycle,
  nextBillingDate,
  startDate,
  endDate,
  createdAt,
}: ContractInvoicesSectionProps) {
  const [statements, setStatements] = useState<Statement[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingMode, setSavingMode] = useState(false);
  const [currentMode, setCurrentMode] = useState<'proforma_first' | 'gst_direct'>(billingMode || 'proforma_first');
  const [userRole, setUserRole] = useState<string | null>(null);
  const [pendingModeDialogOpen, setPendingModeDialogOpen] = useState(false);
  const [convertReason, setConvertReason] = useState(
    "Contract billing mode switched to GST Direct — clearing pending proforma."
  );
  const [convertingId, setConvertingId] = useState<string | null>(null);
  const [prorataStatement, setProrataStatement] = useState<Statement | null>(null);
  const [cycleDialogOpen, setCycleDialogOpen] = useState(false);
  const [cyclePreviewing, setCyclePreviewing] = useState(false);
  const [cyclePreview, setCyclePreview] = useState<CyclePreview | null>(null);
  const [cycleBlockedReason, setCycleBlockedReason] = useState<string | null>(null);
  const [cycleSending, setCycleSending] = useState(false);

  useEffect(() => {
    setCurrentMode(billingMode || 'proforma_first');
  }, [billingMode]);

  // Chain-wide: the unbilled-month check needs the parent's statements too (a
  // renewal's opening months are billed there while it awaits activation). The
  // table below still lists only this contract's own statements.
  const refreshStatements = () => {
    return fetch(`/api/billing-statements?contract_id=${contractId}&include_chain=1&limit=200`)
      .then((r) => r.json())
      .then((d) => setStatements((d.data || []) as Statement[]))
      .catch(() => setStatements([]));
  };

  useEffect(() => {
    refreshStatements().finally(() => setLoading(false));
    fetch("/api/me")
      .then((r) => r.json())
      .then((d) => setUserRole(d.role ?? null))
      .catch(() => setUserRole(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contractId]);

  // The pro-rata invoice (generated via the proposal's "Preview & Send GST
  // Invoice" step) is a billing_statements row keyed by proposal_id, not
  // contract_id — the contract didn't exist yet when it was sent.
  useEffect(() => {
    if (!proposalId) {
      setProrataStatement(null);
      return;
    }
    fetch(`/api/billing-statements?proposal_id=${proposalId}&limit=1`)
      .then((r) => r.json())
      .then((d) => setProrataStatement(((d.data || []) as Statement[])[0] || null))
      .catch(() => setProrataStatement(null));
  }, [proposalId]);

  // Only this contract's own statements belong in the invoice table — an
  // ancestor's rows are fetched for the coverage check, not for display.
  const ownStatements = useMemo(
    () => statements.filter((s) => !s.contract_id || s.contract_id === contractId),
    [statements, contractId],
  );

  // Proformas still open under the old Proforma First flow — switching to
  // GST Direct only affects future cycles, so these are left behind unless
  // resolved via the GST override (convert-to-gst-early).
  const pendingUnpaidStatements = useMemo(
    () =>
      ownStatements.filter(
        (s) =>
          s.status === "finalized" &&
          s.payment_status !== "paid" &&
          !s.gst_invoice_number &&
          !s.pi_cancelled_at
      ),
    [ownStatements]
  );

  const applyModeChange = async (newMode: 'proforma_first' | 'gst_direct') => {
    setSavingMode(true);
    try {
      const res = await fetch(`/api/contracts/${contractId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ billing_mode: newMode }),
      });
      if (res.ok) {
        setCurrentMode(newMode);
        toast.success(newMode === 'gst_direct' ? "GST Direct billing enabled from next cycle" : "Proforma First billing restored from next cycle");
      } else {
        const err = await res.json().catch(() => null);
        toast.error(err?.error || "Failed to update billing mode");
      }
    } catch {
      toast.error("Failed to update billing mode");
    } finally {
      setSavingMode(false);
    }
  };

  const handleModeChange = async (newMode: 'proforma_first' | 'gst_direct') => {
    if (newMode === currentMode) return;
    if (newMode === 'gst_direct' && pendingUnpaidStatements.length > 0) {
      setPendingModeDialogOpen(true);
      return;
    }
    await applyModeChange(newMode);
  };

  const handleConvertToGst = async (statementId: string) => {
    setConvertingId(statementId);
    try {
      const res = await fetch(`/api/billing-statements/${statementId}/convert-to-gst-early`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: convertReason }),
      });
      if (res.ok) {
        toast.success("PI cancelled — queued for GST invoice in Tally Inbox");
        await refreshStatements();
      } else {
        const err = await res.json().catch(() => null);
        toast.error(err?.error || "Failed to convert to GST");
      }
    } catch {
      toast.error("Failed to convert to GST");
    } finally {
      setConvertingId(null);
    }
  };

  // Months already past their billing run with no rent statement against them.
  // Surfaced rather than auto-billed: rent is sometimes invoiced outside the
  // CRM, so this is a prompt to check, not proof of lost revenue.
  const missedMonths = useMemo(() => {
    if (!startDate || !endDate || !createdAt) return [];
    return unbilledMonths({
      startDate, endDate, createdAt,
      today: new Date(Date.now() + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10),
      statements,
      contractId,
      contractStatus,
    });
  }, [startDate, endDate, createdAt, statements, contractId, contractStatus]);

  // Monthly + renewal_in_progress with a real detected gap: the one case
  // where a missed month can sit behind "now" with nothing else able to
  // reach it. The batch cron only ever bills forward from today, and a plain
  // monthly contract's next_billing_date is never advanced (see below), so
  // there is no anchor to walk back from — "Bill next cycle" would otherwise
  // only ever be able to raise TODAY's next month, never the one actually
  // owed. Scoped tightly to renewal_in_progress + missedMonths (itself now
  // aware of the renewal-continues-billing rule, see the window note on
  // unbilledMonths() in billing-months.ts) so this can't be used to
  // backfill an unrelated missed month on an ordinary active contract —
  // those need their own investigation, not a one-click resend.
  const monthlyBackfillTarget = useMemo(() => {
    if (billingCycle !== "monthly" || contractStatus !== "renewal_in_progress" || missedMonths.length === 0) return null;
    const oldest = missedMonths[0];
    return oldest.month === 1 ? { month: 12, year: oldest.year - 1 } : { month: oldest.month - 1, year: oldest.year };
  }, [billingCycle, contractStatus, missedMonths]);

  // A rent run bills the month AFTER the month it targets, so to bill the cycle
  // this contract is actually due for, target the month before its billing
  // anchor. Without this the button only works during the one calendar month
  // the anchor happens to fall due in — an advance-billed contract asking for
  // its next quarter early, or one whose dispatch failed and left the anchor
  // behind, could never be billed from here.
  // Monthly contracts are otherwise excluded: nothing advances their
  // next_billing_date, so the stored value is stale by design — they bill
  // from the current month unless monthlyBackfillTarget applies above.
  const cycleTarget = useMemo(() => {
    if (monthlyBackfillTarget) return monthlyBackfillTarget;
    if (!nextBillingDate || !billingCycle || billingCycle === "monthly") return null;
    const [y, m] = nextBillingDate.split("-").map(Number);
    if (!y || !m) return null;
    return m === 1 ? { month: 12, year: y - 1 } : { month: m - 1, year: y };
  }, [monthlyBackfillTarget, nextBillingDate, billingCycle]);

  // Bill this one contract's upcoming rent cycle without running the whole
  // month's batch. Same generator the batch uses (so proration, rate phases,
  // GST and the advance-cycle length all behave identically) — just scoped to
  // one contract_id. Previews first: this dispatches to the client for real.
  const openCycleDialog = async () => {
    setCycleDialogOpen(true);
    setCyclePreview(null);
    setCycleBlockedReason(null);
    setCyclePreviewing(true);
    try {
      const res = await fetch("/api/billing/auto-generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dry_run: true, mode: "rent", contract_id: contractId, ...(cycleTarget ?? {}) }),
      });
      const json = await res.json();
      if (!res.ok) {
        setCycleBlockedReason(json.error || "Preview failed");
        return;
      }
      const rent = json.rent_proformas ?? {};
      const item = (rent.preview ?? [])[0] as CyclePreview | undefined;
      if (item) {
        setCyclePreview(item);
      } else if ((rent.already_sent ?? []).length > 0) {
        setCycleBlockedReason("This cycle's rent proforma has already been sent to the client.");
      } else if ((rent.cycle_skipped ?? []).length > 0) {
        setCycleBlockedReason(
          "Not due yet — this contract bills in advance, and its next billing date falls outside the upcoming month. Nothing to raise until then."
        );
      } else {
        setCycleBlockedReason("Nothing to bill for the upcoming period.");
      }
    } catch {
      setCycleBlockedReason("Preview failed");
    } finally {
      setCyclePreviewing(false);
    }
  };

  const runCycleBilling = async () => {
    setCycleSending(true);
    try {
      const res = await fetch("/api/billing/auto-generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dry_run: false, mode: "rent", contract_id: contractId, ...(cycleTarget ?? {}) }),
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
        // Never report this as sent: the statement is finalized, so no billing
        // run will retry it. It needs a manual resend from the statement itself.
        toast.error("Proforma raised but the send failed — resend it from the statement below.", {
          duration: 10000,
        });
      } else if ((json.rent_proformas?.generated ?? 0) > 0) {
        toast.success("Proforma raised and sent to the client");
      } else {
        toast.info("Nothing was generated for this period");
      }
      setCycleDialogOpen(false);
      await refreshStatements();
    } catch {
      toast.error("Failed to generate the proforma");
    } finally {
      setCycleSending(false);
    }
  };

  // Show toggle for active/live contracts — locked for terminated/expired/completed/renewed
  const canEditMode = !contractStatus || ["active", "renewal_in_progress", "draft", "sent", "accepted"].includes(contractStatus);
  const canBillCycle =
    !!userRole &&
    BILLING_ROLES.includes(userRole) &&
    !!contractStatus &&
    ["active", "renewal_in_progress"].includes(contractStatus);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Receipt className="h-4 w-4 text-muted-foreground" />
          Monthly Invoices
        </CardTitle>
        <div className="flex items-center gap-1">
          {canBillCycle && (
            <Button variant="outline" size="sm" onClick={openCycleDialog}>
              <CalendarPlus className="h-3.5 w-3.5 mr-1" />
              {monthlyBackfillTarget ? "Bill missed month" : "Bill next cycle"}
            </Button>
          )}
          <Link href={`/billing?contract_id=${contractId}`}>
            <Button variant="ghost" size="sm">
              <ExternalLink className="h-3.5 w-3.5 mr-1" />
              Billing
            </Button>
          </Link>
        </div>
      </CardHeader>

      {/* Pro-rata invoice — collected via the proposal before the contract
          existed, so it never shows up in the monthly statements table below. */}
      {proposalId && (
        <div className="px-6 pb-3">
          <div className="flex items-center justify-between rounded-md border bg-muted/20 px-3 py-2">
            <div className="flex items-center gap-2 text-xs">
              <span className="font-medium text-muted-foreground">Pro-rata Invoice</span>
              {prorataStatement ? (
                canPreviewPdf(prorataStatement.status) ? (
                  <Link
                    href={`/api/billing-statements/${prorataStatement.id}/proforma-pdf`}
                    target="_blank"
                    className="font-mono text-primary hover:underline"
                  >
                    {prorataStatement.statement_number}
                  </Link>
                ) : (
                  <span
                    className="font-mono text-muted-foreground"
                    title="Finalize this statement in Billing to preview the PDF"
                  >
                    {prorataStatement.statement_number}
                  </span>
                )
              ) : proposalNumber ? (
                <Link href={`/proposals/${proposalId}`} className="text-primary hover:underline">
                  via {proposalNumber}
                </Link>
              ) : null}
              {(prorataStatement?.total_amount ?? undefined) !== undefined && (
                <span className="text-muted-foreground">· {formatCurrency(prorataStatement!.total_amount)}</span>
              )}
            </div>
            <div className="flex items-center gap-2">
              {(() => {
                const paid = prorataStatement ? prorataStatement.payment_status === "paid" : prorataPaymentStatus === "paid";
                const paidAt = prorataStatement ? undefined : prorataPaymentReceivedAt;
                return (
                  <>
                    {paid && paidAt && (
                      <span className="text-[10px] text-muted-foreground">{formatDate(paidAt)}</span>
                    )}
                    <Badge
                      variant="outline"
                      className={`text-[10px] ${paid ? PAYMENT_STATUS_COLORS.paid : PAYMENT_STATUS_COLORS.unpaid}`}
                    >
                      {paid ? "Paid" : "Unpaid"}
                    </Badge>
                  </>
                );
              })()}
            </div>
          </div>
        </div>
      )}

      {/* Months already past their billing run with nothing charged against
          them. Deliberately a prompt, not an alarm — rent is sometimes
          invoiced outside the CRM, so a person decides what this means. */}
      {missedMonths.length > 0 && (
        <div className="px-6 pb-3">
          <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
            <div className="flex items-start gap-2">
              <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
              <div>
                <span className="font-medium">
                  No rent invoiced for {missedMonths.map((m) => MONTH_LABELS[m.month - 1] + " " + m.year).join(", ")}
                </span>
                <p className="text-xs mt-1 text-amber-800">
                  These months are past their billing run. If the rent was collected outside the CRM,
                  no action is needed — otherwise raise it before it ages further.
                </p>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Billing mode toggle */}
      {canEditMode && (
        <div className="px-6 pb-3">
          <p className="text-xs text-muted-foreground mb-2 font-medium">Invoice Type (from next billing cycle)</p>
          <div className="flex gap-2">
            <button
              onClick={() => handleModeChange('proforma_first')}
              disabled={savingMode}
              className={`flex-1 flex items-center justify-center gap-1.5 rounded-md border px-3 py-2 text-xs font-medium transition-colors ${
                currentMode === 'proforma_first'
                  ? 'bg-[#015E65] text-white border-[#015E65]'
                  : 'bg-background text-muted-foreground border-border hover:bg-muted/30'
              }`}
            >
              <FileCheck className="h-3.5 w-3.5 shrink-0" />
              Proforma First
            </button>
            <button
              onClick={() => handleModeChange('gst_direct')}
              disabled={savingMode}
              className={`flex-1 flex items-center justify-center gap-1.5 rounded-md border px-3 py-2 text-xs font-medium transition-colors ${
                currentMode === 'gst_direct'
                  ? 'bg-violet-700 text-white border-violet-700'
                  : 'bg-background text-muted-foreground border-border hover:bg-muted/30'
              }`}
            >
              <Zap className="h-3.5 w-3.5 shrink-0" />
              GST Direct
            </button>
          </div>
          {currentMode === 'gst_direct' && (
            <p className="text-[10px] text-violet-700 mt-1.5">
              Tax invoice issued directly each cycle · Due date = issue date + 7 days · No proforma
            </p>
          )}
        </div>
      )}

      <CardContent>
        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : ownStatements.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4 text-center">
            No invoices generated yet. Statements are created automatically each month after contract activation.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-xs text-muted-foreground">
                  <th className="text-left font-medium pb-2 pr-4">Period</th>
                  <th className="text-left font-medium pb-2 pr-4">Proforma #</th>
                  <th className="text-right font-medium pb-2 pr-4">Amount</th>
                  <th className="text-left font-medium pb-2 pr-4">Status</th>
                  <th className="text-left font-medium pb-2 pr-4">Payment</th>
                  <th className="text-left font-medium pb-2 pr-4">GST Invoice</th>
                  <th className="text-left font-medium pb-2">Tally Lifecycle</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {ownStatements.map((s) => (
                  <tr key={s.id} className="hover:bg-muted/30 transition-colors">
                    <td className="py-2.5 pr-4 whitespace-nowrap">
                      {periodLabel(s.period_start, s.period_end)}
                    </td>
                    <td className="py-2.5 pr-4">
                      {canPreviewPdf(s.status) ? (
                        <Link
                          href={`/api/billing-statements/${s.id}/proforma-pdf`}
                          target="_blank"
                          className="font-mono text-xs text-primary hover:underline"
                        >
                          {s.statement_number}
                        </Link>
                      ) : (
                        <span
                          className="font-mono text-xs text-muted-foreground"
                          title="Finalize this statement in Billing to preview the PDF"
                        >
                          {s.statement_number}
                        </span>
                      )}
                    </td>
                    <td className="py-2.5 pr-4 text-right tabular-nums font-medium whitespace-nowrap">
                      {formatCurrency(s.total_amount)}
                    </td>
                    <td className="py-2.5 pr-4">
                      <Badge
                        variant="outline"
                        className={`text-[10px] ${STATEMENT_STATUS_COLORS[s.status] ?? ""}`}
                      >
                        {STATEMENT_STATUS_LABELS[s.status] ?? s.status}
                      </Badge>
                    </td>
                    <td className="py-2.5 pr-4">
                      {s.payment_status ? (
                        <Badge
                          variant="outline"
                          className={`text-[10px] ${PAYMENT_STATUS_COLORS[s.payment_status] ?? ""}`}
                        >
                          {PAYMENT_STATUS_LABELS[s.payment_status] ?? s.payment_status}
                        </Badge>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="py-2.5 pr-4">
                      {s.gst_invoice_number ? (
                        <div className="flex items-center gap-1.5">
                          <span className="font-mono text-xs text-green-700">{s.gst_invoice_number}</span>
                          {s.gst_invoice_path && (
                            <Button variant="ghost" size="icon" className="h-5 w-5" asChild>
                              <a href={s.gst_invoice_path} target="_blank" rel="noopener noreferrer" title="Download GST Invoice">
                                <FileText className="h-3 w-3" />
                              </a>
                            </Button>
                          )}
                        </div>
                      ) : (
                        <span className="text-[10px] text-muted-foreground italic">
                          {s.payment_status === "paid" ? "Generating…" : "Issued on payment"}
                        </span>
                      )}
                    </td>
                    {/* Tally lifecycle: handoff_state badge + quick-action buttons.
                        Each component self-fetches /api/accounting/inbox?id=… via a
                        shared 30s SWR cache, so badges + actions in the same row
                        share one request. */}
                    <td className="py-2.5">
                      <div className="flex items-center gap-2 flex-wrap">
                        <StatementLifecycleBadge statementId={s.id} compact />
                        <StatementQuickActions statementId={s.id} compact />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>

      <Dialog open={cycleDialogOpen} onOpenChange={setCycleDialogOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <CalendarPlus className="h-4 w-4 shrink-0" />
              {monthlyBackfillTarget ? "Bill a missed month" : "Bill the upcoming cycle"}
            </DialogTitle>
            <DialogDescription>
              {monthlyBackfillTarget
                ? "This contract's renewal hasn't been activated yet, and a past month never got a rent statement. Raises that missed month's rent proforma at the renewal's terms, without running the month's batch. Sending it creates the payment link and emails the client."
                : "Raises this contract's next rent proforma on its own, without running the month's batch. Sending it creates the payment link and emails the client."}
            </DialogDescription>
          </DialogHeader>

          {cyclePreviewing ? (
            <div className="flex items-center gap-2 py-8 justify-center text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Working out what&apos;s due…
            </div>
          ) : cycleBlockedReason ? (
            <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
              {cycleBlockedReason}
            </div>
          ) : cyclePreview ? (
            <div className="space-y-3">
              <div className="flex items-baseline justify-between">
                <span className="text-sm text-muted-foreground">Period</span>
                <span className="text-sm font-medium">{cyclePreview.period_label}</span>
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
                    {(cyclePreview.line_items ?? []).map((li, i) => (
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
                  <span className="tabular-nums">{formatCurrency(cyclePreview.subtotal)}</span>
                </div>
                <div className="flex justify-between text-muted-foreground">
                  <span>GST</span>
                  <span className="tabular-nums">{formatCurrency(cyclePreview.tax_amount)}</span>
                </div>
                <div className="flex justify-between font-medium">
                  <span>Total</span>
                  <span className="tabular-nums">{formatCurrency(cyclePreview.total_amount)}</span>
                </div>
              </div>
              {cyclePreview.note && (
                <p className="text-xs text-muted-foreground">{cyclePreview.note}</p>
              )}
            </div>
          ) : null}

          <DialogFooter>
            <Button variant="outline" onClick={() => setCycleDialogOpen(false)} disabled={cycleSending}>
              Cancel
            </Button>
            <Button onClick={runCycleBilling} disabled={!cyclePreview || cycleSending}>
              {cycleSending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Raise &amp; send
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={pendingModeDialogOpen} onOpenChange={setPendingModeDialogOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-amber-700">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              {pendingUnpaidStatements.length} pending proforma{pendingUnpaidStatements.length > 1 ? "s" : ""} on Proforma First
            </DialogTitle>
            <DialogDescription>
              Switching to GST Direct only changes future billing cycles — it won&apos;t touch these
              existing unpaid proformas. Use the GST override below to cancel a PI and queue it for a
              direct tax invoice instead, or switch now and resolve them later from Accounting → Tally Inbox.
            </DialogDescription>
          </DialogHeader>

          <div className="border rounded-md max-h-64 overflow-y-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-xs text-muted-foreground sticky top-0">
                <tr>
                  <th className="text-left font-medium py-2 px-3">Period</th>
                  <th className="text-left font-medium py-2 px-3">PI #</th>
                  <th className="text-right font-medium py-2 px-3">Amount</th>
                  <th className="text-left font-medium py-2 px-3">Payment</th>
                  <th className="py-2 px-3" />
                </tr>
              </thead>
              <tbody className="divide-y">
                {pendingUnpaidStatements.map((s) => (
                  <tr key={s.id}>
                    <td className="py-2 px-3 whitespace-nowrap">{periodLabel(s.period_start, s.period_end)}</td>
                    <td className="py-2 px-3 font-mono text-xs">{s.statement_number}</td>
                    <td className="py-2 px-3 text-right tabular-nums">{formatCurrency(s.total_amount)}</td>
                    <td className="py-2 px-3">
                      <Badge
                        variant="outline"
                        className={`text-[10px] ${PAYMENT_STATUS_COLORS[s.payment_status ?? ""] ?? ""}`}
                      >
                        {PAYMENT_STATUS_LABELS[s.payment_status ?? ""] ?? s.payment_status}
                      </Badge>
                    </td>
                    <td className="py-2 px-3 text-right whitespace-nowrap">
                      {userRole && ["admin", "manager"].includes(userRole) ? (
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 text-xs"
                          disabled={convertingId === s.id}
                          onClick={() => handleConvertToGst(s.id)}
                        >
                          {convertingId === s.id ? <Loader2 className="h-3 w-3 animate-spin" /> : "Convert to GST"}
                        </Button>
                      ) : (
                        <span className="text-[10px] text-muted-foreground italic">Admin/manager only</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">
              Reason (used for any override triggered above)
            </label>
            <Textarea
              value={convertReason}
              onChange={(e) => setConvertReason(e.target.value)}
              className="text-xs"
              rows={2}
            />
          </div>

          <DialogFooter>
            <Button variant="ghost" onClick={() => setPendingModeDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              className="bg-violet-700 hover:bg-violet-800 text-white"
              disabled={savingMode}
              onClick={async () => {
                setPendingModeDialogOpen(false);
                await applyModeChange("gst_direct");
              }}
            >
              {savingMode ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : null}
              Switch to GST Direct anyway
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
