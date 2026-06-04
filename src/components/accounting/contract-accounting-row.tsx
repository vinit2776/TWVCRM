"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight, IndianRupee, Send, Receipt, CheckCircle, Calendar, Eye, FileCheck, X, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { formatCurrency, formatDate } from "@/lib/utils";
import { FacilityUsageForm } from "./facility-usage-form";
import { AddContractPaymentDialog } from "./add-contract-payment-dialog";
import { AddUsageChargeDialog } from "@/components/billing/add-usage-charge-dialog";
import { BillingLifecycleStatus } from "@/components/billing/billing-lifecycle-status";
import { TallyStatusBadge } from "@/components/billing/tally-status-badge";
import { BillingLifecycleFlow, resolveBillingStage } from "@/components/billing/billing-lifecycle-flow";
import { CONTRACT_PAYMENT_MODE_LABELS, CONTRACT_PAYMENT_STATUS_COLORS, CONTRACT_PAYMENT_STATUS_LABELS } from "@/lib/constants";
import { toast } from "sonner";

interface ContractSummary {
  contract: {
    id: string;
    contract_number: string;
    title: string;
    total_amount: number;
    lead?: {
      id: string;
      first_name: string;
      last_name: string;
      company?: string;
      email?: string;
      secondary_email?: string;
    };
  };
  recurring_amount: number;
  facility_usage_total: number;
  facility_usages: Array<{
    id?: string;
    contract_facility_id: string;
    quantity_used: number;
    free_quota_applied: number;
    billable_quantity: number;
    unit_price: number;
    total_charge: number;
    is_template?: boolean;
    contract_facility?: {
      id: string;
      name: string;
      unit: string;
      cost_per_unit: number;
      free_quota: number;
    };
  }>;
  ad_hoc_total: number;
  ad_hoc_charges: Array<{
    id: string;
    description: string;
    quantity: number;
    unit_price: number;
    total: number;
  }>;
  booking_total: number;
  posted_bookings: Array<{
    id: string;
    booking_number?: string;
    total_amount: number;
    space?: { name: string };
    booking_date: string;
    start_time?: string;
    end_time?: string;
    status?: string;
    payment_status?: string;
  }>;
  current_month_charges: number;
  carried_forward: number;
  total_owed: number;
  payments: Array<{
    id: string;
    payment_number: string;
    amount: number;
    payment_mode: string;
    payment_date: string;
    status: string;
    payment_reference?: string;
    reminder_sent_at?: string;
    creator?: { full_name: string };
  }>;
  total_paid_this_month: number;
  outstanding: number;
  gst_invoice: {
    number: string | null;
    path: string | null;
    status: string | null;
    sent_at: string | null;
    sent_to: string | null;
  } | null;
  /** Full billing statement record for this contract in this period, if any */
  billing_statement?: {
    id: string;
    status: string;
    statement_number: string;
    total_amount?: number | null;
    fixed_amount?: number | null;
    usage_amount?: number | null;
    booking_usage_amount?: number | null;
    finalized_at?: string | null;
    proforma_sent_at?: string | null;
    gst_invoice_number?: string | null;
    payment_status?: string | null;
    accounted?: boolean | null;
    accounted_at?: string | null;
    razorpay_payment_link_url?: string | null;
    emailed_at?: string | null;
    // Tally state (surfaced via the compact TallyStatusBadge)
    issuance_channel?: string | null;
    lifecycle_stage?: string | null;
    tally_invoice_number?: string | null;
    tally_irn?: string | null;
    tally_credit_note_number?: string | null;
    tally_last_error?: string | null;
    tally_delivered_at?: string | null;
    /** Actor names from joined users table */
    finalized_by_user?: { full_name: string } | null;
    proforma_sent_by_user?: { full_name: string } | null;
    gst_generated_by_user?: { full_name: string } | null;
    accounted_by_user?: { full_name: string } | null;
    /** Statement-level payments (billing_payments table) */
    billing_payments?: Array<{
      id: string;
      amount: number;
      payment_date: string;
      payment_mode: string;
      payment_reference?: string | null;
      razorpay_payment_id?: string | null;
      recorded_by_user?: { full_name: string } | null;
    }> | null;
  } | null;
}

interface ContractAccountingRowProps {
  summary: ContractSummary;
  accountingPeriodId: string;
  isLocked: boolean;
  /** Whether this contract's statement for the period is finalized/exported */
  isStatementFinalized?: boolean;
  /** Period start date (YYYY-MM-DD) — used as default charge date */
  periodStart?: string;
  onRefresh: () => void;
  /** Called when user clicks Finalize Draft — pass the statement id */
  onFinalize?: (statementId: string) => Promise<void>;
  /** Called when user clicks Send Proforma — pass the statement id */
  onSendProforma?: (statementId: string) => Promise<void>;
  /** Called when user clicks Generate GST Invoice — pass the statement id */
  onGenerateGst?: (statementId: string) => Promise<void>;
  /** Called when user clicks Record Payment — opens dialog in parent */
  onRecordStatementPayment?: (statementId: string) => void;
  /** Called when user clicks View — opens view dialog in parent */
  onViewStatement?: (statementId: string) => void;
  /** Called when user clicks Void — opens void dialog in parent */
  onVoidStatement?: (statementId: string) => void;
  /** Called when user clicks Mark as Accounted */
  onMarkAccounted?: (statementId: string) => Promise<void>;
  /** Current user role — used to gate admin-only actions */
  userRole?: string | null;
}

export function ContractAccountingRow({
  summary,
  accountingPeriodId,
  isLocked,
  isStatementFinalized,
  periodStart,
  onRefresh,
  onFinalize,
  onSendProforma,
  onGenerateGst,
  onRecordStatementPayment,
  onViewStatement,
  onVoidStatement,
  onMarkAccounted,
  userRole,
}: ContractAccountingRowProps) {
  const [expanded, setExpanded] = useState(false);
  const [showAddPayment, setShowAddPayment] = useState(false);
  const [showAddCharge, setShowAddCharge] = useState(false);
  const [sendingReminder, setSendingReminder] = useState<string | null>(null);
  const [finalizing, setFinalizing] = useState(false);
  const [sendingProforma, setSendingProforma] = useState(false);
  const [generatingGst, setGeneratingGst] = useState(false);
  const [markingAccounted, setMarkingAccounted] = useState(false);

  const { contract } = summary;
  const company = contract.lead?.company || `${contract.lead?.first_name || ""} ${contract.lead?.last_name || ""}`.trim();

  const statement = summary.billing_statement;
  const isDraft = statement?.status === "draft";

  // Unbilled bookings: posted_to_bill bookings for this period not yet on a statement
  const unbilledBookings = summary.posted_bookings;
  const unbilledTotal = summary.booking_total;
  const hasUnbilledBookings = unbilledBookings.length > 0;

  const handleSendReminder = async (paymentId: string) => {
    const emails = [contract.lead?.email, contract.lead?.secondary_email].filter(Boolean) as string[];
    if (emails.length === 0) {
      toast.error("No email addresses found for this lead");
      return;
    }

    setSendingReminder(paymentId);
    try {
      const res = await fetch(`/api/accounting/contract-payments/${paymentId}/remind`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ recipients: emails }),
      });

      if (!res.ok) {
        const err = await res.json();
        toast.error(err.error || "Failed to send reminder");
        return;
      }

      toast.success("Reminder sent");
      onRefresh();
    } catch {
      toast.error("Network error");
    } finally {
      setSendingReminder(null);
    }
  };

  const handleFinalize = async () => {
    if (!statement?.id || !onFinalize) return;
    setFinalizing(true);
    try {
      await onFinalize(statement.id);
    } finally {
      setFinalizing(false);
    }
  };

  const handleSendProforma = async () => {
    if (!statement?.id || !onSendProforma) return;
    setSendingProforma(true);
    try {
      await onSendProforma(statement.id);
    } finally {
      setSendingProforma(false);
    }
  };

  const handleGenerateGst = async () => {
    if (!statement?.id || !onGenerateGst) return;
    setGeneratingGst(true);
    try {
      await onGenerateGst(statement.id);
    } finally {
      setGeneratingGst(false);
    }
  };

  const handleMarkAccounted = async () => {
    if (!statement?.id || !onMarkAccounted) return;
    setMarkingAccounted(true);
    try {
      await onMarkAccounted(statement.id);
    } finally {
      setMarkingAccounted(false);
    }
  };

  const isFinalized = statement?.status === "finalized" || statement?.status === "exported";

  return (
    <div className="border rounded-lg">
      {/* Collapsed row */}
      <div
        className="flex items-center gap-4 px-4 py-3 cursor-pointer hover:bg-accent/50"
        onClick={() => setExpanded(!expanded)}
      >
        <div className="flex-shrink-0">
          {expanded ? (
            <ChevronDown className="h-4 w-4 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-4 w-4 text-muted-foreground" />
          )}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-medium text-sm">{contract.contract_number}</span>
            <span className="text-sm text-muted-foreground truncate">{company}</span>
            {/* Statement lifecycle badge on collapsed row — shows actual stage, not raw DB status */}
            {statement ? (
              <div className="ml-1" onClick={(e) => e.stopPropagation()}>
                <BillingLifecycleStatus
                  status={statement.status}
                  emailed_at={statement.emailed_at}
                  razorpay_payment_link_url={statement.razorpay_payment_link_url}
                  payment_status={statement.payment_status}
                  accounted={statement.accounted}
                  finalized_at={statement.finalized_at}
                  gst_invoice_number={statement.gst_invoice_number}
                  proforma_sent_at={statement.proforma_sent_at}
                  variant="compact"
                />
                <TallyStatusBadge
                  variant="compact"
                  issuance_channel={statement.issuance_channel}
                  lifecycle_stage={statement.lifecycle_stage}
                  tally_invoice_number={statement.tally_invoice_number}
                  tally_irn={statement.tally_irn}
                  tally_credit_note_number={statement.tally_credit_note_number}
                  tally_last_error={statement.tally_last_error}
                  tally_delivered_at={statement.tally_delivered_at}
                />
              </div>
            ) : (
              <Badge variant="secondary" className="text-xs ml-1">No statement</Badge>
            )}
            {hasUnbilledBookings && !isStatementFinalized && (
              <Badge className="text-xs bg-orange-100 text-orange-700 border-orange-200 ml-1">
                {unbilledBookings.length} unbilled booking{unbilledBookings.length > 1 ? "s" : ""}
              </Badge>
            )}
          </div>
        </div>
        <div className="flex items-center gap-6 text-sm">
          <div className="text-right">
            <span className="text-muted-foreground text-xs">Recurring</span>
            <p className="font-medium">{formatCurrency(summary.recurring_amount)}</p>
          </div>
          <div className="text-right">
            <span className="text-muted-foreground text-xs">Usage</span>
            <p className="font-medium">{formatCurrency(summary.facility_usage_total + summary.ad_hoc_total)}</p>
          </div>
          {hasUnbilledBookings && (
            <div className="text-right">
              <span className="text-muted-foreground text-xs">Bookings</span>
              <p className="font-medium text-orange-600">{formatCurrency(unbilledTotal)}</p>
            </div>
          )}
          <div className="text-right">
            <span className="text-muted-foreground text-xs">Paid</span>
            <p className="font-medium text-green-600">{formatCurrency(summary.total_paid_this_month)}</p>
          </div>
          <div className="text-right">
            <span className="text-muted-foreground text-xs">Outstanding</span>
            <p className={`font-medium ${summary.outstanding > 0 ? "text-red-600" : "text-foreground"}`}>
              {formatCurrency(summary.outstanding)}
            </p>
          </div>
        </div>
      </div>

      {/* Expanded detail */}
      {expanded && (
        <div className="border-t px-4 py-4 space-y-6 bg-muted/20">
          {/* Carry forward */}
          {summary.carried_forward > 0 && (
            <div className="bg-amber-50 border border-amber-200 rounded-md px-3 py-2">
              <span className="text-sm text-amber-800 font-medium">
                Carried Forward: {formatCurrency(summary.carried_forward)}
              </span>
              <span className="text-xs text-amber-600 ml-2">(from previous months)</span>
            </div>
          )}

          {/* Recurring charge */}
          <div>
            <h4 className="text-xs font-semibold text-muted-foreground uppercase mb-2">Recurring Charge</h4>
            <p className="text-sm">
              Monthly Membership: <strong>{formatCurrency(summary.recurring_amount)}</strong>
            </p>
          </div>

          {/* Facility Usage — read-only facility list, accounts enters quantity used */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <div>
                <h4 className="text-xs font-semibold text-muted-foreground uppercase">Facility Usage</h4>
                <p className="text-[10px] text-muted-foreground mt-0.5">
                  Rate cards &amp; free quotas are set on the contract. Enter units used this month.
                </p>
              </div>
            </div>
            <FacilityUsageForm
              usages={summary.facility_usages}
              contractId={contract.id}
              accountingPeriodId={accountingPeriodId}
              isLocked={isLocked}
              onRefresh={onRefresh}
            />
          </div>

          {/* Ad-hoc charges */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <h4 className="text-xs font-semibold text-muted-foreground uppercase">Ad-hoc Charges</h4>
              {!isLocked && !isStatementFinalized ? (
                <Button variant="outline" size="sm" onClick={() => setShowAddCharge(true)}>
                  <Receipt className="h-3 w-3 mr-1" />
                  Add Charge
                </Button>
              ) : (isLocked || isStatementFinalized) && (
                <span className="text-xs text-muted-foreground">
                  {isLocked ? "Period locked" : "Bill finalized"}
                </span>
              )}
            </div>
            {summary.ad_hoc_charges.length > 0 ? (
              <div className="space-y-1">
                {summary.ad_hoc_charges.map((charge) => (
                  <div key={charge.id} className="flex justify-between text-sm px-2">
                    <span>{charge.description} ({charge.quantity} × {formatCurrency(charge.unit_price)})</span>
                    <span className="font-medium">{formatCurrency(charge.total)}</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground px-2">No ad-hoc charges</p>
            )}
          </div>

          {/* Unbilled Bookings */}
          {hasUnbilledBookings && (
            <div>
              <div className="flex items-center gap-2 mb-2">
                <h4 className="text-xs font-semibold text-muted-foreground uppercase">
                  Unbilled Bookings
                </h4>
                <Badge className="text-xs bg-orange-100 text-orange-700 border-orange-200">
                  {unbilledBookings.length} pending
                </Badge>
              </div>
              <div className="rounded-md border overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-orange-50 border-b">
                      <th className="px-3 py-2 text-left text-xs font-medium text-orange-800">Booking #</th>
                      <th className="px-3 py-2 text-left text-xs font-medium text-orange-800">Date</th>
                      <th className="px-3 py-2 text-left text-xs font-medium text-orange-800">Space</th>
                      <th className="px-3 py-2 text-left text-xs font-medium text-orange-800">Time</th>
                      <th className="px-3 py-2 text-right text-xs font-medium text-orange-800">Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {unbilledBookings.map((b) => (
                      <tr key={b.id} className="border-b last:border-0 hover:bg-orange-50/40">
                        <td className="px-3 py-2 font-mono text-xs text-muted-foreground">
                          {b.booking_number || "—"}
                        </td>
                        <td className="px-3 py-2 text-xs">{formatDate(b.booking_date)}</td>
                        <td className="px-3 py-2 text-xs">{b.space?.name || "—"}</td>
                        <td className="px-3 py-2 text-xs text-muted-foreground">
                          {b.start_time && b.end_time
                            ? `${b.start_time.slice(0, 5)}–${b.end_time.slice(0, 5)}`
                            : "—"}
                        </td>
                        <td className="px-3 py-2 text-right font-medium">
                          {Number(b.total_amount) === 0 ? (
                            <span className="text-xs text-muted-foreground">Free quota</span>
                          ) : (
                            formatCurrency(b.total_amount)
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="bg-orange-50 border-t">
                      <td colSpan={4} className="px-3 py-2 text-xs font-semibold text-orange-800">
                        Total Unbilled
                      </td>
                      <td className="px-3 py-2 text-right text-sm font-bold text-orange-800">
                        {formatCurrency(unbilledTotal)}
                      </td>
                    </tr>
                  </tfoot>
                </table>
                {isDraft && (
                  <div className="bg-yellow-50 border-t border-yellow-100 px-3 py-2 text-xs text-yellow-700 flex items-center gap-1.5">
                    <CheckCircle className="h-3 w-3 flex-shrink-0" />
                    These bookings are already included in the draft statement. Finalize when ready.
                  </div>
                )}
                {!statement && (
                  <div className="bg-blue-50 border-t border-blue-100 px-3 py-2 text-xs text-blue-700 flex items-center gap-1.5">
                    <Calendar className="h-3 w-3 flex-shrink-0" />
                    These will be automatically included when the monthly statement is generated (~28th).
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Payments */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <div>
                <h4 className="text-xs font-semibold text-muted-foreground uppercase">Payments Received</h4>
                {isFinalized && (
                  <p className="text-[10px] text-muted-foreground mt-0.5">Tracked against the billing statement below</p>
                )}
              </div>
              {/* When a finalized statement exists, route to statement-level payment (updates payment_status).
                  Hide button when statement is fully paid — no further payment needed. */}
              {isFinalized && statement?.payment_status !== "paid" && onRecordStatementPayment && (
                <Button variant="outline" size="sm" onClick={() => onRecordStatementPayment(statement!.id)}>
                  <IndianRupee className="h-3 w-3 mr-1" />
                  Record Payment
                </Button>
              )}
              {isFinalized && statement?.payment_status === "paid" && (
                <span className="text-xs text-green-700 bg-green-50 border border-green-200 rounded px-2 py-1">
                  ✓ Fully paid
                </span>
              )}
              {!isFinalized && (
                <Button variant="outline" size="sm" onClick={() => setShowAddPayment(true)}>
                  <IndianRupee className="h-3 w-3 mr-1" />
                  Record Payment
                </Button>
              )}
            </div>

            {/* Statement-level payments (billing_payments) — shown when statement is finalized */}
            {isFinalized && statement?.billing_payments && statement.billing_payments.length > 0 ? (
              <div className="space-y-1">
                {statement.billing_payments.map((p) => {
                  const isRazorpay = p.payment_mode === "razorpay" || !!p.razorpay_payment_id;
                  const modeLabel = isRazorpay ? "Razorpay" : (p.payment_mode?.toUpperCase() || "—");
                  return (
                    <div key={p.id} className="flex items-center justify-between text-sm px-2 py-1.5 rounded bg-background border">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                        <span className="text-xs text-muted-foreground">{formatDate(p.payment_date)}</span>
                        <Badge variant="outline" className={`text-xs ${isRazorpay ? "border-violet-300 text-violet-700 bg-violet-50" : ""}`}>
                          {modeLabel}
                        </Badge>
                        {/* Razorpay payment ID — hyperlinked to dashboard */}
                        {p.razorpay_payment_id ? (
                          <a
                            href={`https://dashboard.razorpay.com/app/payments/${p.razorpay_payment_id}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-0.5 text-xs text-violet-700 hover:text-violet-900 underline underline-offset-1 font-mono"
                            onClick={(e) => e.stopPropagation()}
                          >
                            {p.razorpay_payment_id}
                            <ExternalLink className="h-2.5 w-2.5 flex-shrink-0" />
                          </a>
                        ) : p.payment_reference ? (
                          <span className="text-xs text-muted-foreground font-mono">Ref: {p.payment_reference}</span>
                        ) : null}
                        {/* Who recorded this payment */}
                        {p.recorded_by_user?.full_name ? (
                          <span className="text-xs text-muted-foreground">· {p.recorded_by_user.full_name}</span>
                        ) : isRazorpay ? (
                          <span className="text-xs text-muted-foreground italic">· via gateway</span>
                        ) : null}
                      </div>
                      <span className="font-medium text-green-700 ml-2 flex-shrink-0">{formatCurrency(p.amount)}</span>
                    </div>
                  );
                })}
              </div>
            ) : isFinalized ? (
              <p className="text-sm text-muted-foreground px-2">No payments recorded</p>
            ) : null}

            {/* Legacy contract_payments — shown only when no finalized statement */}
            {!isFinalized && summary.payments.length > 0 && (
              <div className="space-y-1">
                {summary.payments.map((p) => (
                  <div key={p.id} className="flex items-center justify-between text-sm px-2 py-1 rounded hover:bg-accent/50">
                    <div className="flex items-center gap-2">
                      <span className="text-muted-foreground">{p.payment_number}</span>
                      <span className="text-xs text-muted-foreground">{formatDate(p.payment_date)}</span>
                      <Badge variant="outline" className="text-xs">
                        {CONTRACT_PAYMENT_MODE_LABELS[p.payment_mode] || p.payment_mode}
                      </Badge>
                      <Badge className={`text-xs ${CONTRACT_PAYMENT_STATUS_COLORS[p.status] || ""}`} variant="outline">
                        {CONTRACT_PAYMENT_STATUS_LABELS[p.status] || p.status}
                      </Badge>
                      {p.payment_reference && (
                        <span className="text-xs text-muted-foreground">Ref: {p.payment_reference}</span>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{formatCurrency(p.amount)}</span>
                      {summary.outstanding > 0 && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6"
                          onClick={() => handleSendReminder(p.id)}
                          disabled={sendingReminder === p.id}
                          title={p.reminder_sent_at ? `Reminder sent ${formatDate(p.reminder_sent_at)}` : "Send reminder"}
                        >
                          <Send className={`h-3 w-3 ${p.reminder_sent_at ? "text-green-600" : ""}`} />
                        </Button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
            {!isFinalized && summary.payments.length === 0 && (
              <p className="text-sm text-muted-foreground px-2">No payments recorded</p>
            )}
          </div>

          {/* Billing Statement */}
          <div>
            <h4 className="text-xs font-semibold text-muted-foreground uppercase mb-2">Billing Statement</h4>
            {statement ? (
              <div className="rounded-md border bg-background p-3 space-y-3">
                {/* Statement identity + compact lifecycle badge */}
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div>
                    <span className="font-medium text-sm">
                      {statement.statement_number || (isDraft ? "Draft (not yet numbered)" : statement.id.slice(0, 8))}
                    </span>
                    {statement.total_amount != null && (
                      <span className="ml-2 text-sm text-muted-foreground">{formatCurrency(statement.total_amount)}</span>
                    )}
                  </div>
                  <BillingLifecycleStatus
                    status={statement.status}
                    emailed_at={statement.emailed_at}
                    razorpay_payment_link_url={statement.razorpay_payment_link_url}
                    payment_status={statement.payment_status}
                    accounted={statement.accounted}
                    finalized_at={statement.finalized_at}
                    gst_invoice_number={statement.gst_invoice_number}
                    proforma_sent_at={statement.proforma_sent_at}
                  />
                  <TallyStatusBadge
                    variant="compact"
                    issuance_channel={statement.issuance_channel}
                    lifecycle_stage={statement.lifecycle_stage}
                    tally_invoice_number={statement.tally_invoice_number}
                    tally_irn={statement.tally_irn}
                    tally_credit_note_number={statement.tally_credit_note_number}
                    tally_last_error={statement.tally_last_error}
                    tally_delivered_at={statement.tally_delivered_at}
                  />
                </div>

                {/* Visual lifecycle flow stepper */}
                {statement.status !== "voided" && (
                  <div className="border rounded-md bg-muted/30 px-3 pt-2 pb-3">
                    <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide mb-1">
                      Billing Lifecycle
                    </p>
                    <BillingLifecycleFlow
                      stage={resolveBillingStage({
                        status: statement.status,
                        paymentStatus: statement.payment_status,
                        gstInvoiceNumber: statement.gst_invoice_number,
                        accounted: statement.accounted,
                        proformaSentAt: statement.proforma_sent_at,
                      })}
                      statementId={statement.id}
                      statementNumber={statement.statement_number}
                      gstInvoiceNumber={statement.gst_invoice_number}
                      actors={{
                        finalized_by: statement.finalized_by_user?.full_name,
                        proforma_sent_by: statement.proforma_sent_by_user?.full_name,
                        gst_generated_by: statement.gst_generated_by_user?.full_name,
                        accounted_by: statement.accounted_by_user?.full_name,
                      }}
                    />
                  </div>
                )}

                {/* GST Invoice details — shown once GST invoice has been generated */}
                {statement.gst_invoice_number && (
                  <div className="rounded-md border border-teal-200 bg-teal-50 px-3 py-2 flex items-start justify-between gap-3 flex-wrap">
                    <div className="space-y-0.5">
                      <p className="text-[10px] font-semibold text-teal-700 uppercase tracking-wide">GST Invoice</p>
                      <p className="text-sm font-medium text-teal-900">{statement.gst_invoice_number}</p>
                      {summary.gst_invoice?.sent_at && (
                        <p className="text-xs text-teal-700">
                          Sent {formatDate(summary.gst_invoice.sent_at)}
                          {summary.gst_invoice.sent_to && (
                            <span className="text-teal-600"> → {summary.gst_invoice.sent_to}</span>
                          )}
                        </p>
                      )}
                    </div>
                    <Button size="sm" variant="outline" className="h-7 text-xs border-teal-300 text-teal-700 hover:bg-teal-100" asChild>
                      <a
                        href={`/api/billing-statements/${statement.id}/gst-invoice-pdf`}
                        download={`GST-${statement.gst_invoice_number?.replace(/\//g, "-")}.pdf`}
                        onClick={(e) => e.stopPropagation()}
                      >
                        <FileCheck className="h-3 w-3 mr-1" />Download GST PDF
                      </a>
                    </Button>
                  </div>
                )}

                {/* Action buttons */}
                <div className="flex flex-wrap gap-2">
                  {/* Finalize — only on draft */}
                  {isDraft && !isLocked && onFinalize && (
                    <Button
                      size="sm"
                      className="h-7 text-xs bg-teal-600 hover:bg-teal-700 text-white"
                      onClick={(e) => { e.stopPropagation(); handleFinalize(); }}
                      disabled={finalizing}
                    >
                      {finalizing ? (
                        <><span className="mr-1 h-3 w-3 rounded-full border-2 border-white border-r-transparent animate-spin inline-block" />Finalizing…</>
                      ) : (
                        <><CheckCircle className="h-3 w-3 mr-1" />Finalize</>
                      )}
                    </Button>
                  )}

                  {/* Send / Resend Proforma — only while payment not yet fully received */}
                  {isFinalized && onSendProforma && !statement.gst_invoice_number && statement.payment_status !== "paid" && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-xs"
                      onClick={(e) => { e.stopPropagation(); handleSendProforma(); }}
                      disabled={sendingProforma}
                    >
                      {sendingProforma ? (
                        <><span className="mr-1 h-3 w-3 rounded-full border-2 border-current border-r-transparent animate-spin inline-block" />Sending…</>
                      ) : (
                        <><Send className="h-3 w-3 mr-1" />{statement.proforma_sent_at ? "Resend Proforma" : "Send Proforma"}</>
                      )}
                    </Button>
                  )}

                  {/* Hint: payment received, GST next */}
                  {isFinalized && !statement.gst_invoice_number && statement.payment_status === "paid" && !onGenerateGst && (
                    <span className="text-xs text-violet-700 bg-violet-50 border border-violet-200 rounded px-2 py-1">
                      ✓ Payment received — Generate GST invoice
                    </span>
                  )}

                  {/* Generate GST Invoice — only after full payment received */}
                  {isFinalized && !statement.gst_invoice_number && statement.payment_status === "paid" && onGenerateGst && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-xs"
                      onClick={(e) => { e.stopPropagation(); handleGenerateGst(); }}
                      disabled={generatingGst}
                    >
                      {generatingGst ? (
                        <><span className="mr-1 h-3 w-3 rounded-full border-2 border-current border-r-transparent animate-spin inline-block" />Generating…</>
                      ) : (
                        <><FileCheck className="h-3 w-3 mr-1" />GST Invoice</>
                      )}
                    </Button>
                  )}

                  {/* Record Payment button removed from here — it now lives in the "Payments Received"
                      section above so users always find payment recording in one consistent place. */}

                  {/* View statement detail */}
                  {onViewStatement && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 text-xs"
                      onClick={(e) => { e.stopPropagation(); onViewStatement(statement.id); }}
                    >
                      <Eye className="h-3 w-3 mr-1" />View
                    </Button>
                  )}

                  {/* Download proforma PDF */}
                  {isFinalized && (
                    <Button size="sm" variant="ghost" className="h-7 text-xs" asChild>
                      <a
                        href={`/api/billing-statements/${statement.id}/proforma-pdf`}
                        download={`Proforma-${statement.statement_number?.replace(/\//g, "-") || statement.id.slice(0, 8)}.pdf`}
                        onClick={(e) => e.stopPropagation()}
                      >
                        <FileCheck className="h-3 w-3 mr-1" />PDF
                      </a>
                    </Button>
                  )}

                  {/* Mark as Accounted — shown once GST invoice exists and not yet accounted */}
                  {isFinalized && statement.gst_invoice_number && !statement.accounted && onMarkAccounted && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-xs border-green-300 text-green-700 hover:bg-green-50"
                      onClick={(e) => { e.stopPropagation(); handleMarkAccounted(); }}
                      disabled={markingAccounted}
                    >
                      {markingAccounted ? (
                        <><span className="mr-1 h-3 w-3 rounded-full border-2 border-current border-r-transparent animate-spin inline-block" />Saving…</>
                      ) : (
                        <><CheckCircle className="h-3 w-3 mr-1" />Mark as Accounted</>
                      )}
                    </Button>
                  )}

                  {/* Accounted — read-only confirmation */}
                  {statement.accounted && (
                    <span className="inline-flex items-center gap-1 text-xs text-green-700 bg-green-50 border border-green-200 rounded px-2 py-1 h-7">
                      <CheckCircle className="h-3 w-3" />
                      Accounted{statement.accounted_at ? ` · ${formatDate(statement.accounted_at)}` : ""}
                    </span>
                  )}

                  {/* Void — admin only */}
                  {isFinalized && userRole === "admin" && onVoidStatement && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 text-xs text-destructive hover:text-destructive hover:bg-destructive/10"
                      onClick={(e) => { e.stopPropagation(); onVoidStatement(statement.id); }}
                    >
                      <X className="h-3 w-3 mr-1" />Void
                    </Button>
                  )}
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-2 text-sm text-muted-foreground py-2 px-1 rounded-md border border-dashed">
                <Calendar className="h-4 w-4 flex-shrink-0 ml-2" />
                <span>Statement auto-generates around the 28th of the month</span>
              </div>
            )}
          </div>

          {/* Totals row */}
          <div className="border-t pt-3 flex items-center justify-between text-sm font-medium">
            <span>Total This Month</span>
            <div className="flex items-center gap-6">
              <span>Charges: {formatCurrency(summary.current_month_charges)}</span>
              {hasUnbilledBookings && (
                <span className="text-orange-600">Bookings: {formatCurrency(unbilledTotal)}</span>
              )}
              <span className="text-green-600">Paid: {formatCurrency(summary.total_paid_this_month)}</span>
              <span className={summary.outstanding > 0 ? "text-red-600" : ""}>
                Outstanding: {formatCurrency(summary.outstanding)}
              </span>
            </div>
          </div>
        </div>
      )}

      {/* Dialogs */}
      <AddContractPaymentDialog
        open={showAddPayment}
        onOpenChange={setShowAddPayment}
        onSuccess={onRefresh}
        contractId={contract.id}
        accountingPeriodId={accountingPeriodId}
      />

      <AddUsageChargeDialog
        open={showAddCharge}
        onOpenChange={setShowAddCharge}
        onSuccess={onRefresh}
        contractId={contract.id}
        defaultChargeDate={periodStart}
      />
    </div>
  );
}
