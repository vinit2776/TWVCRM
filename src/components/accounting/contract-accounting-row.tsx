"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight, Plus, IndianRupee, Send, Receipt, CheckCircle, Clock, Calendar } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { formatCurrency, formatDate } from "@/lib/utils";
import { FacilityUsageForm } from "./facility-usage-form";
import { AddContractFacilityDialog } from "./add-contract-facility-dialog";
import { AddContractPaymentDialog } from "./add-contract-payment-dialog";
import { AddUsageChargeDialog } from "@/components/billing/add-usage-charge-dialog";
import { CONTRACT_PAYMENT_MODE_LABELS, CONTRACT_PAYMENT_STATUS_COLORS, CONTRACT_PAYMENT_STATUS_LABELS } from "@/lib/constants";
import { toast } from "sonner";

interface ContractSummary {
  contract: {
    id: string;
    contract_number: string;
    title: string;
    monthly_membership_fee: number;
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
  /** Billing statement for this contract in this period, if any */
  billing_statement?: {
    id: string;
    status: string;
    statement_number: string;
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
}

export function ContractAccountingRow({
  summary,
  accountingPeriodId,
  isLocked,
  isStatementFinalized,
  periodStart,
  onRefresh,
  onFinalize,
}: ContractAccountingRowProps) {
  const [expanded, setExpanded] = useState(false);
  const [showAddFacility, setShowAddFacility] = useState(false);
  const [showAddPayment, setShowAddPayment] = useState(false);
  const [showAddCharge, setShowAddCharge] = useState(false);
  const [sendingReminder, setSendingReminder] = useState<string | null>(null);
  const [finalizing, setFinalizing] = useState(false);

  const { contract } = summary;
  const company = contract.lead?.company || `${contract.lead?.first_name || ""} ${contract.lead?.last_name || ""}`.trim();

  const statement = summary.billing_statement;
  const isDraft = statement?.status === "draft";

  // Unbilled bookings: posted_to_bill bookings for this period
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
            {/* Unbilled bookings indicator on the collapsed row */}
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

          {/* ── Unbilled Bookings (pending next statement) ── */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <h4 className="text-xs font-semibold text-muted-foreground uppercase">
                  Unbilled Bookings
                </h4>
                {hasUnbilledBookings && (
                  <Badge className="text-xs bg-orange-100 text-orange-700 border-orange-200">
                    {unbilledBookings.length} pending
                  </Badge>
                )}
              </div>
              {/* Statement status chip */}
              {statement ? (
                isDraft ? (
                  <div className="flex items-center gap-2">
                    <span className="flex items-center gap-1 text-xs text-yellow-700 bg-yellow-50 border border-yellow-200 rounded px-2 py-0.5">
                      <Clock className="h-3 w-3" />
                      Draft {statement.statement_number}
                    </span>
                    {!isLocked && onFinalize && (
                      <Button
                        size="sm"
                        className="h-7 text-xs bg-teal-600 hover:bg-teal-700 text-white"
                        onClick={(e) => { e.stopPropagation(); handleFinalize(); }}
                        disabled={finalizing}
                      >
                        {finalizing ? (
                          <><span className="mr-1 h-3 w-3 rounded-full border-2 border-white border-r-transparent animate-spin inline-block" />Finalizing…</>
                        ) : (
                          <><CheckCircle className="h-3 w-3 mr-1" />Finalize Bill</>
                        )}
                      </Button>
                    )}
                  </div>
                ) : (
                  <span className="flex items-center gap-1 text-xs text-green-700 bg-green-50 border border-green-200 rounded px-2 py-0.5">
                    <CheckCircle className="h-3 w-3" />
                    {statement.status === "finalized" ? "Finalized" : "Exported"} — {statement.statement_number}
                  </span>
                )
              ) : (
                <span className="flex items-center gap-1 text-xs text-muted-foreground bg-muted rounded px-2 py-0.5">
                  <Calendar className="h-3 w-3" />
                  Auto-generates ~28th
                </span>
              )}
            </div>

            {hasUnbilledBookings ? (
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
                {/* Context note */}
                {isDraft && (
                  <div className="bg-yellow-50 border-t border-yellow-100 px-3 py-2 text-xs text-yellow-700 flex items-center gap-1.5">
                    <CheckCircle className="h-3 w-3 flex-shrink-0" />
                    These bookings are already included in the draft statement. Finalize the bill when ready.
                  </div>
                )}
                {!statement && (
                  <div className="bg-blue-50 border-t border-blue-100 px-3 py-2 text-xs text-blue-700 flex items-center gap-1.5">
                    <Calendar className="h-3 w-3 flex-shrink-0" />
                    These will be automatically included when the monthly statement is generated (~28th).
                  </div>
                )}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground px-2">
                No unbilled bookings for this period
              </p>
            )}
          </div>

          {/* Recurring charge */}
          <div>
            <h4 className="text-xs font-semibold text-muted-foreground uppercase mb-2">Recurring Charge</h4>
            <p className="text-sm">
              Monthly Membership: <strong>{formatCurrency(summary.recurring_amount)}</strong>
            </p>
          </div>

          {/* Facility Usage */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <h4 className="text-xs font-semibold text-muted-foreground uppercase">Facility Usage</h4>
              {!isLocked && (
                <Button variant="outline" size="sm" onClick={() => setShowAddFacility(true)}>
                  <Plus className="h-3 w-3 mr-1" />
                  Add Facility
                </Button>
              )}
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

          {/* Payments */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <h4 className="text-xs font-semibold text-muted-foreground uppercase">Payments Received</h4>
              <Button variant="outline" size="sm" onClick={() => setShowAddPayment(true)}>
                <IndianRupee className="h-3 w-3 mr-1" />
                Record Payment
              </Button>
            </div>
            {summary.payments.length > 0 ? (
              <div className="space-y-1">
                {summary.payments.map((p) => (
                  <div key={p.id} className="flex items-center justify-between text-sm px-2 py-1 rounded hover:bg-accent/50">
                    <div className="flex items-center gap-2">
                      <span className="text-muted-foreground">{p.payment_number}</span>
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
            ) : (
              <p className="text-sm text-muted-foreground px-2">No payments recorded</p>
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
      <AddContractFacilityDialog
        open={showAddFacility}
        onOpenChange={setShowAddFacility}
        onSuccess={onRefresh}
        contractId={contract.id}
      />

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
