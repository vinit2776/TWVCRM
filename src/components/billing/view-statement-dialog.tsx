"use client";

import React, { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

import { Skeleton } from "@/components/shared/loading-skeleton";
import { Loader2, CheckCircle, Upload, Plus, X, Send, FileCheck, Ban, RotateCcw, AlertTriangle } from "lucide-react";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import { formatDate, formatCurrency } from "@/lib/utils";
import { BillingLifecycleStatus } from "@/components/billing/billing-lifecycle-status";
import { TallyStatusBadge } from "@/components/billing/tally-status-badge";
import { ConvertToGstEarlyDialog } from "@/components/billing/convert-to-gst-early-dialog";

interface UsageCharge {
  id: string;
  description: string;
  quantity: number;
  unit_price: number;
  total: number;
  charge_date: string;
  status: string;
  is_waived?: boolean;
  waived_at?: string | null;
  waive_reason?: string | null;
  waived_by_user?: { full_name: string } | null;
}

interface FacilityCharge {
  id: string;
  name: string;
  unit: string;
  quantity_used: number;
  free_quota_applied: number;
  billable_quantity: number;
  unit_price: number;
  total_charge: number;
}

interface ServiceCharge {
  id: string;
  service_name: string;
  quantity_used: number;
  quota: number;
  overage: number;
  rate: number;
  amount: number;
}

interface BookingCharge {
  id: string;
  booking_number: string;
  date: string;
  space: string;
  time: string;
  duration: string;
  amount: number;
  is_free: boolean;
}

interface Statement {
  id: string;
  statement_number: string;
  status: string;
  period_start: string;
  period_end: string;
  fixed_amount: number;
  usage_amount: number;
  service_usage_amount?: number;
  booking_usage_amount?: number;
  subtotal: number;
  tax_percentage: number;
  tax_amount: number;
  total_amount: number;
  prepaid_month?: number;
  prepaid_year?: number;
  // Lifecycle fields
  emailed_at?: string | null;
  razorpay_payment_link_url?: string | null;
  payment_status?: string | null;
  accounted?: boolean | null;
  finalized_at?: string | null;
  gst_invoice_number?: string | null;
  proforma_sent_at?: string | null;
  pi_cancelled_at?: string | null;
  due_date?: string | null;
  notes?: string;
  // Tally state (surfaced via TallyStatusBadge)
  issuance_channel?: string | null;
  lifecycle_stage?: string | null;
  tally_invoice_number?: string | null;
  tally_irn?: string | null;
  tally_credit_note_number?: string | null;
  tally_last_error?: string | null;
  tally_delivered_at?: string | null;
  contract?: { id: string; contract_number: string; title?: string } | null;
  booking?: { id: string; booking_number: string; booking_date: string; guest_name?: string } | null;
  lead?: { first_name: string; last_name: string; company?: string; email?: string } | null;
  usage_charges?: UsageCharge[];
  facility_charges?: FacilityCharge[];
  service_charges?: ServiceCharge[];
  booking_charges?: BookingCharge[];
}


const ADD_CHARGE_ROLES = ["admin", "manager", "accounts"];
const WAIVE_ROLES = ["admin", "manager"];

interface ViewStatementDialogProps {
  statementId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onStatusChange: () => void;
  /** Current user's role — drives visibility of "Add charge" on draft statements */
  userRole?: string | null;
}

export function ViewStatementDialog({
  statementId,
  open,
  onOpenChange,
  onStatusChange,
  userRole,
}: ViewStatementDialogProps) {
  const [statement, setStatement] = useState<Statement | null>(null);
  const [loading, setLoading] = useState(false);
  const [actioning, setActioning] = useState(false);
  const [sendingProforma, setSendingProforma] = useState(false);
  const [generatingGst, setGeneratingGst] = useState(false);
  const [revertingToDraft, setRevertingToDraft] = useState(false);
  const [retryingTally, setRetryingTally] = useState(false);
  const [showConvertToGst, setShowConvertToGst] = useState(false);

  // Waive-charge state — tracks which charge row has the waive form open
  const [waivedChargeId, setWaivedChargeId] = useState<string | null>(null);
  const [waiveReason, setWaiveReason] = useState("");
  const [waivedChargeLoading, setWaivedChargeLoading] = useState<string | null>(null);

  // ── Inline "Add charge" form state ────────────────────────────────
  const [showAddCharge, setShowAddCharge] = useState(false);
  const [addingCharge, setAddingCharge] = useState(false);
  const [chargeDesc, setChargeDesc] = useState("");
  const [chargeQty, setChargeQty] = useState<number>(1);
  const [chargePrice, setChargePrice] = useState<number>(0);
  // GST rate is locked to the statement's tax_percentage for consistency
  const chargeGstRate = Number(statement?.tax_percentage ?? 18);
  const [chargeDate, setChargeDate] = useState(
    new Date().toISOString().split("T")[0]
  );

  const chargeSubtotal = chargeQty * chargePrice;
  const chargeGstAmt = parseFloat((chargeSubtotal * chargeGstRate / 100).toFixed(2));
  const chargeTotal = parseFloat((chargeSubtotal + chargeGstAmt).toFixed(2));

  const canAddCharge =
    statement?.status === "draft" &&
    !!userRole &&
    ADD_CHARGE_ROLES.includes(userRole);

  const resetChargeForm = () => {
    setChargeDesc("");
    setChargeQty(1);
    setChargePrice(0);
    setChargeDate(new Date().toISOString().split("T")[0]);
    setShowAddCharge(false);
  };

  const handleAddCharge = async () => {
    if (!statementId) return;
    if (!chargeDesc.trim()) { toast.error("Description is required"); return; }
    if (chargeQty <= 0) { toast.error("Quantity must be positive"); return; }
    if (chargePrice <= 0) { toast.error("Unit price must be positive"); return; }

    setAddingCharge(true);
    try {
      const res = await fetch(`/api/billing-statements/${statementId}/add-charge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          description: chargeDesc.trim(),
          quantity: chargeQty,
          unit_price: chargePrice,
          gst_rate: chargeGstRate,
          charge_date: chargeDate,
        }),
      });
      if (res.ok) {
        toast.success("Charge added to statement");
        resetChargeForm();
        onStatusChange(); // refresh parent list
        // Refresh statement in-place so totals update
        const refreshed = await fetch(`/api/billing-statements/${statementId}`);
        if (refreshed.ok) {
          const json = await refreshed.json();
          setStatement(json.data || null);
        }
      } else {
        const err = await res.json().catch(() => null);
        toast.error(err?.error || "Failed to add charge");
      }
    } catch {
      toast.error("Something went wrong");
    } finally {
      setAddingCharge(false);
    }
  };

  useEffect(() => {
    if (!open || !statementId) {
      setStatement(null);
      return;
    }
    setLoading(true);
    fetch(`/api/billing-statements/${statementId}`)
      .then((res) => res.json())
      .then((json) => setStatement(json.data || null))
      .catch(() => toast.error("Failed to load statement"))
      .finally(() => setLoading(false));
  }, [open, statementId]);

  const handleStatusTransition = async (newStatus: "finalized" | "exported") => {
    if (!statementId) return;
    setActioning(true);
    try {
      const res = await fetch(`/api/billing-statements/${statementId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: newStatus }),
      });
      if (res.ok) {
        toast.success(newStatus === "finalized" ? "Statement finalized" : "Statement exported");
        onStatusChange();
        // Refresh statement in dialog
        const refreshed = await fetch(`/api/billing-statements/${statementId}`);
        if (refreshed.ok) {
          const json = await refreshed.json();
          setStatement(json.data || null);
        }
      } else {
        const err = await res.json().catch(() => null);
        toast.error(err?.error || `Failed to ${newStatus === "finalized" ? "finalize" : "export"} statement`);
      }
    } catch {
      toast.error("Something went wrong");
    } finally {
      setActioning(false);
    }
  };

  const handleSendProforma = async () => {
    if (!statementId) return;
    setSendingProforma(true);
    try {
      const res = await fetch(`/api/billing-statements/${statementId}/send-proforma`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}),
      });
      const json = await res.json();
      if (res.ok) {
        toast.success(json.emailedTo ? `Proforma sent to ${json.emailedTo}` : "Proforma generated (no email on file)");
        onStatusChange();
        const refreshed = await fetch(`/api/billing-statements/${statementId}`);
        if (refreshed.ok) { const j = await refreshed.json(); setStatement(j.data || null); }
      } else {
        toast.error(json.error || "Failed to send proforma");
      }
    } catch { toast.error("Something went wrong"); }
    setSendingProforma(false);
  };

  const handleGenerateGstInvoice = async () => {
    if (!statementId) return;
    setGeneratingGst(true);
    try {
      const res = await fetch(`/api/billing-statements/${statementId}/generate-gst-invoice`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}),
      });
      const json = await res.json();
      if (res.ok) {
        toast.success(json.emailedTo ? `GST invoice ${json.invoiceNumber} sent to ${json.emailedTo}` : `GST invoice ${json.invoiceNumber} generated`);
        onStatusChange();
        const refreshed = await fetch(`/api/billing-statements/${statementId}`);
        if (refreshed.ok) { const j = await refreshed.json(); setStatement(j.data || null); }
      } else {
        toast.error(json.error || "Failed to generate GST invoice");
      }
    } catch { toast.error("Something went wrong"); }
    setGeneratingGst(false);
  };

  const handleTallyRetry = async () => {
    if (!statementId) return;
    setRetryingTally(true);
    try {
      const res = await fetch(`/api/billing-statements/${statementId}/tally-retry`, {
        method: "POST", headers: { "Content-Type": "application/json" },
      });
      const json = await res.json();
      if (res.ok) {
        toast.success(json.message || "Tally sync re-queued");
        onStatusChange();
        const refreshed = await fetch(`/api/billing-statements/${statementId}`);
        if (refreshed.ok) { const j = await refreshed.json(); setStatement(j.data || null); }
      } else {
        toast.error(json.error || "Failed to retry Tally sync");
      }
    } catch { toast.error("Something went wrong"); }
    setRetryingTally(false);
  };

  const canWaive =
    statement?.status === "draft" &&
    !!userRole &&
    WAIVE_ROLES.includes(userRole);

  const canRevertToDraft =
    statement?.status === "finalized" &&
    !!userRole &&
    WAIVE_ROLES.includes(userRole);

  const handleWaiveCharge = async (chargeId: string, waive: boolean) => {
    if (!statementId) return;
    if (waive && !waiveReason.trim()) {
      toast.error("Please enter a reason before waiving");
      return;
    }
    setWaivedChargeLoading(chargeId);
    try {
      const res = await fetch(`/api/billing-statements/${statementId}/waive-charge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ charge_id: chargeId, waive, reason: waiveReason.trim() }),
      });
      const json = await res.json();
      if (res.ok) {
        toast.success(waive ? "Charge waived" : "Waiver removed");
        setWaivedChargeId(null);
        setWaiveReason("");
        onStatusChange();
        const refreshed = await fetch(`/api/billing-statements/${statementId}`);
        if (refreshed.ok) {
          const j = await refreshed.json();
          setStatement(j.data || null);
        }
      } else {
        toast.error(json.error || "Failed to update charge");
      }
    } catch {
      toast.error("Something went wrong");
    } finally {
      setWaivedChargeLoading(null);
    }
  };

  const handleRevertToDraft = async () => {
    if (!statementId) return;
    setRevertingToDraft(true);
    try {
      const res = await fetch(`/api/billing-statements/${statementId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "revert_to_draft" }),
      });
      const json = await res.json();
      if (res.ok) {
        toast.success("Statement reverted to draft — edits are now open");
        onStatusChange();
        const refreshed = await fetch(`/api/billing-statements/${statementId}`);
        if (refreshed.ok) {
          const j = await refreshed.json();
          setStatement(j.data || null);
        }
      } else {
        toast.error(json.error || "Failed to revert statement");
      }
    } catch {
      toast.error("Something went wrong");
    } finally {
      setRevertingToDraft(false);
    }
  };

  const customerName = statement?.lead
    ? statement.lead.company || `${statement.lead.first_name} ${statement.lead.last_name}`
    : statement?.booking?.guest_name || null;

  const reference = statement?.contract?.contract_number
    ? `Contract ${statement.contract.contract_number}`
    : statement?.booking?.booking_number
    ? `Booking ${statement.booking.booking_number}`
    : "—";

  return (
    <>
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {loading ? "Loading..." : statement ? `Statement ${statement.statement_number}` : "Statement"}
          </DialogTitle>
        </DialogHeader>

        {loading ? (
          <div className="space-y-3 py-2">
            {[...Array(5)].map((_, i) => (
              <Skeleton key={i} className="h-5 w-full" />
            ))}
          </div>
        ) : statement ? (
          <div className="space-y-5">
            {/* Tally state (only for Tally-issued statements; renders null otherwise) */}
            <TallyStatusBadge
              variant="full"
              issuance_channel={statement.issuance_channel}
              lifecycle_stage={statement.lifecycle_stage}
              tally_invoice_number={statement.tally_invoice_number}
              tally_irn={statement.tally_irn}
              tally_credit_note_number={statement.tally_credit_note_number}
              tally_last_error={statement.tally_last_error}
              tally_delivered_at={statement.tally_delivered_at}
              onRetry={handleTallyRetry}
              retrying={retryingTally}
            />

            {/* Header info */}
            <div className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
              <div>
                <p className="text-muted-foreground text-xs mb-0.5">Lifecycle</p>
                <BillingLifecycleStatus
                  status={statement.status}
                  emailed_at={statement.emailed_at}
                  razorpay_payment_link_url={statement.razorpay_payment_link_url}
                  payment_status={statement.payment_status}
                  accounted={statement.accounted}
                  finalized_at={statement.finalized_at}
                  gst_invoice_number={statement.gst_invoice_number}
                  variant="full"
                />
              </div>
              <div>
                <p className="text-muted-foreground text-xs mb-0.5">Reference</p>
                <p className="font-mono font-medium">{reference}</p>
              </div>
              <div>
                <p className="text-muted-foreground text-xs mb-0.5">Customer</p>
                <p className="font-medium">{customerName || "—"}</p>
              </div>
              <div>
                <p className="text-muted-foreground text-xs mb-0.5">Billing Period</p>
                <p>{formatDate(statement.period_start)} – {formatDate(statement.period_end)}</p>
              </div>
            </div>

            {/* Amounts summary */}
            {(() => {
              const hasPrepaid = statement.prepaid_month && statement.fixed_amount > 0;
              const prepaidLabel = hasPrepaid
                ? `Prepaid Rent — ${new Date(statement.prepaid_year || 0, (statement.prepaid_month || 1) - 1).toLocaleDateString("en-IN", { month: "long", year: "numeric" })}`
                : statement.contract ? "Monthly Membership Fee" : "Booking Amount";

              const bookingAmt = Number(statement.booking_usage_amount || 0);
              const usageAmt = Number(statement.usage_amount || 0);
              const serviceAmt = Number(statement.service_usage_amount || 0);

              return (
                <div className="rounded-md border bg-muted/30 p-4 space-y-2 text-sm">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">{prepaidLabel}</span>
                    <span>{formatCurrency(statement.fixed_amount)}</span>
                  </div>
                  {bookingAmt > 0 && (
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">
                        Meeting Room Usage ({statement.booking_charges?.length || 0} booking{(statement.booking_charges?.length || 0) !== 1 ? "s" : ""})
                      </span>
                      <span>{formatCurrency(bookingAmt)}</span>
                    </div>
                  )}
                  {usageAmt > 0 && (
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">
                        Additional Charges ({(statement.usage_charges?.length ?? 0) + (statement.facility_charges?.length ?? 0)} item{((statement.usage_charges?.length ?? 0) + (statement.facility_charges?.length ?? 0)) !== 1 ? "s" : ""})
                      </span>
                      <span>{formatCurrency(usageAmt)}</span>
                    </div>
                  )}
                  {serviceAmt > 0 && (
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">
                        Service Usage ({statement.service_charges?.length || 0} service{(statement.service_charges?.length || 0) !== 1 ? "s" : ""})
                      </span>
                      <span>{formatCurrency(serviceAmt)}</span>
                    </div>
                  )}
                  <div className="flex justify-between border-t pt-2">
                    <span className="text-muted-foreground">Subtotal</span>
                    <span>{formatCurrency(statement.subtotal)}</span>
                  </div>
                  {statement.tax_percentage > 0 && (
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">GST ({statement.tax_percentage}%)</span>
                      <span>{formatCurrency(statement.tax_amount)}</span>
                    </div>
                  )}
                  <div className="border-t pt-2 flex justify-between font-semibold">
                    <span>Total</span>
                    <span>{formatCurrency(statement.total_amount)}</span>
                  </div>
                </div>
              );
            })()}

            {/* Booking charges table (auto-rolled contract bookings) */}
            {(statement.booking_charges?.length ?? 0) > 0 && (
              <div>
                <h4 className="text-sm font-semibold mb-2">Meeting Room Bookings</h4>
                <div className="rounded-md border overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b bg-muted/50">
                        <th className="px-3 py-2 text-left font-medium">Booking</th>
                        <th className="px-3 py-2 text-left font-medium">Space</th>
                        <th className="px-3 py-2 text-left font-medium">Time</th>
                        <th className="px-3 py-2 text-right font-medium">Amount</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(statement.booking_charges ?? []).map((bc) => (
                        <tr key={bc.id} className={`border-b last:border-0${bc.is_free ? " bg-green-50/30" : ""}`}>
                          <td className="px-3 py-2">
                            <div className="font-mono text-xs">{bc.booking_number}</div>
                            <div className="text-xs text-muted-foreground">{formatDate(bc.date)}</div>
                          </td>
                          <td className="px-3 py-2">{bc.space}</td>
                          <td className="px-3 py-2">
                            <div>{bc.time}</div>
                            <div className="text-xs text-muted-foreground">{bc.duration}</div>
                          </td>
                          <td className="px-3 py-2 text-right font-medium">
                            {bc.is_free ? (
                              <span className="text-green-700 text-xs">Free quota</span>
                            ) : (
                              formatCurrency(bc.amount)
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* Usage charges table (ad-hoc + facility) */}
            {((statement.usage_charges?.length ?? 0) > 0 || (statement.facility_charges?.length ?? 0) > 0) && (
              <div>
                <h4 className="text-sm font-semibold mb-2">Ad-hoc &amp; Facility Charges</h4>
                <div className="rounded-md border overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b bg-muted/50">
                        <th className="px-3 py-2 text-left font-medium">Description</th>
                        <th className="px-3 py-2 text-right font-medium">Qty</th>
                        <th className="px-3 py-2 text-right font-medium">Rate</th>
                        <th className="px-3 py-2 text-right font-medium">Total</th>
                        {canWaive && <th className="px-3 py-2 text-right font-medium w-24"></th>}
                      </tr>
                    </thead>
                    <tbody>
                      {(statement.usage_charges ?? []).map((charge) => (
                        <React.Fragment key={charge.id}>
                          <tr
                            className={`border-b ${charge.is_waived ? "bg-red-50/40" : ""}`}
                          >
                            <td className="px-3 py-2">
                              <div className={`font-medium ${charge.is_waived ? "line-through text-muted-foreground" : ""}`}>
                                {charge.description}
                              </div>
                              <div className="text-xs text-muted-foreground">{formatDate(charge.charge_date)}</div>
                              {charge.is_waived && charge.waived_by_user && (
                                <div className="text-xs text-red-600 mt-0.5">
                                  Waived by {charge.waived_by_user.full_name}
                                  {charge.waive_reason ? ` — "${charge.waive_reason}"` : ""}
                                </div>
                              )}
                            </td>
                            <td className={`px-3 py-2 text-right ${charge.is_waived ? "text-muted-foreground line-through" : ""}`}>
                              {charge.quantity}
                            </td>
                            <td className={`px-3 py-2 text-right ${charge.is_waived ? "text-muted-foreground line-through" : ""}`}>
                              {formatCurrency(charge.unit_price)}
                            </td>
                            <td className={`px-3 py-2 text-right font-medium ${charge.is_waived ? "text-muted-foreground line-through" : ""}`}>
                              {formatCurrency(charge.total)}
                            </td>
                            {canWaive && (
                              <td className="px-3 py-2 text-right">
                                {charge.is_waived ? (
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    className="h-7 text-xs text-muted-foreground hover:text-foreground"
                                    disabled={waivedChargeLoading === charge.id}
                                    onClick={() => handleWaiveCharge(charge.id, false)}
                                  >
                                    {waivedChargeLoading === charge.id ? (
                                      <Loader2 className="h-3 w-3 animate-spin" />
                                    ) : (
                                      "Un-waive"
                                    )}
                                  </Button>
                                ) : (
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    className="h-7 text-xs text-red-600 hover:text-red-700 hover:bg-red-50"
                                    onClick={() => {
                                      setWaivedChargeId(charge.id);
                                      setWaiveReason("");
                                    }}
                                  >
                                    <Ban className="h-3 w-3 mr-1" />
                                    Waive
                                  </Button>
                                )}
                              </td>
                            )}
                          </tr>
                          {/* Inline waive reason form */}
                          {canWaive && waivedChargeId === charge.id && !charge.is_waived && (
                            <tr key={`${charge.id}-waive-form`} className="bg-red-50/60 border-b">
                              <td colSpan={canWaive ? 5 : 4} className="px-3 py-3">
                                <div className="flex flex-col gap-2">
                                  <p className="text-xs font-medium text-red-700">
                                    Reason for waiving &ldquo;{charge.description}&rdquo; <span className="text-destructive">*</span>
                                  </p>
                                  <Textarea
                                    placeholder="e.g., Customer complained, goodwill gesture, data entry error…"
                                    value={waiveReason}
                                    onChange={(e) => setWaiveReason(e.target.value)}
                                    className="h-16 text-sm resize-none"
                                    autoFocus
                                  />
                                  <div className="flex gap-2">
                                    <Button
                                      size="sm"
                                      className="h-7 bg-red-600 hover:bg-red-700 text-white text-xs"
                                      disabled={!waiveReason.trim() || waivedChargeLoading === charge.id}
                                      onClick={() => handleWaiveCharge(charge.id, true)}
                                    >
                                      {waivedChargeLoading === charge.id ? (
                                        <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                                      ) : (
                                        <Ban className="h-3 w-3 mr-1" />
                                      )}
                                      Confirm Waive
                                    </Button>
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      className="h-7 text-xs"
                                      onClick={() => { setWaivedChargeId(null); setWaiveReason(""); }}
                                    >
                                      Cancel
                                    </Button>
                                  </div>
                                </div>
                              </td>
                            </tr>
                          )}
                        </React.Fragment>
                      ))}
                      {(statement.facility_charges ?? []).map((fc) => (
                        <tr key={fc.id} className="border-b last:border-0 bg-blue-50/30">
                          <td className="px-3 py-2">
                            <div className="font-medium">{fc.name} — Overage</div>
                            <div className="text-xs text-muted-foreground">
                              {fc.quantity_used} {fc.unit} used · {fc.free_quota_applied} free · {fc.billable_quantity} chargeable
                            </div>
                          </td>
                          <td className="px-3 py-2 text-right">{fc.billable_quantity}</td>
                          <td className="px-3 py-2 text-right">{formatCurrency(fc.unit_price)}</td>
                          <td className="px-3 py-2 text-right font-medium">{formatCurrency(fc.total_charge)}</td>
                          {canWaive && <td className="px-3 py-2" />}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* Service charges table (printer/service overages) */}
            {(statement.service_charges?.length ?? 0) > 0 && (
              <div>
                <h4 className="text-sm font-semibold mb-2">Service Usage</h4>
                <div className="rounded-md border overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b bg-muted/50">
                        <th className="px-3 py-2 text-left font-medium">Service</th>
                        <th className="px-3 py-2 text-right font-medium">Used</th>
                        <th className="px-3 py-2 text-right font-medium">Quota</th>
                        <th className="px-3 py-2 text-right font-medium">Overage</th>
                        <th className="px-3 py-2 text-right font-medium">Amount</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(statement.service_charges ?? []).map((sc) => (
                        <tr key={sc.id} className="border-b last:border-0 bg-purple-50/30">
                          <td className="px-3 py-2 font-medium">{sc.service_name}</td>
                          <td className="px-3 py-2 text-right">{sc.quantity_used}</td>
                          <td className="px-3 py-2 text-right text-muted-foreground">{sc.quota}</td>
                          <td className="px-3 py-2 text-right">
                            {sc.overage > 0 ? (
                              <span>{sc.overage} × {formatCurrency(sc.rate)}</span>
                            ) : (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </td>
                          <td className="px-3 py-2 text-right font-medium">{formatCurrency(sc.amount)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* ── Add charge (draft only, role-gated) ─────────────── */}
            {canAddCharge && !showAddCharge && (
              <Button
                variant="outline"
                size="sm"
                className="w-full border-dashed"
                onClick={() => setShowAddCharge(true)}
              >
                <Plus className="mr-2 h-4 w-4" />
                Add Charge
              </Button>
            )}

            {canAddCharge && showAddCharge && (
              <div className="rounded-md border border-primary/30 bg-primary/5 p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <h4 className="text-sm font-semibold">New Charge</h4>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6"
                    onClick={resetChargeForm}
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </div>

                <div className="space-y-1">
                  <Label htmlFor="stmt-charge-desc" className="text-xs">
                    Description <span className="text-destructive">*</span>
                  </Label>
                  <Input
                    id="stmt-charge-desc"
                    value={chargeDesc}
                    onChange={(e) => setChargeDesc(e.target.value)}
                    placeholder="e.g., Cafeteria charges, Overtime, Damage..."
                    className="h-8 text-sm"
                  />
                </div>

                <div className="grid grid-cols-3 gap-3">
                  <div className="space-y-1">
                    <Label htmlFor="stmt-charge-qty" className="text-xs">Qty</Label>
                    <Input
                      id="stmt-charge-qty"
                      type="number"
                      min={0.01}
                      step="any"
                      value={chargeQty}
                      onChange={(e) => setChargeQty(parseFloat(e.target.value) || 0)}
                      className="h-8 text-sm"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="stmt-charge-price" className="text-xs">Unit Price</Label>
                    <Input
                      id="stmt-charge-price"
                      type="number"
                      min={0.01}
                      step="any"
                      value={chargePrice}
                      onChange={(e) => setChargePrice(parseFloat(e.target.value) || 0)}
                      className="h-8 text-sm"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">GST %</Label>
                    <div className="rounded-md border bg-muted px-2.5 py-1.5 text-sm tabular-nums">
                      {chargeGstRate}%
                    </div>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <Label htmlFor="stmt-charge-date" className="text-xs">Charge Date</Label>
                    <Input
                      id="stmt-charge-date"
                      type="date"
                      value={chargeDate}
                      onChange={(e) => setChargeDate(e.target.value)}
                      className="h-8 text-sm"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">Total (incl. GST)</Label>
                    <div className="rounded-md border bg-background px-2.5 py-1.5 text-sm font-semibold">
                      {formatCurrency(chargeTotal)}
                      {chargeGstAmt > 0 && (
                        <span className="text-xs text-muted-foreground font-normal ml-1">
                          ({formatCurrency(chargeSubtotal)} + {formatCurrency(chargeGstAmt)} GST)
                        </span>
                      )}
                    </div>
                  </div>
                </div>

                <Button
                  size="sm"
                  onClick={handleAddCharge}
                  disabled={addingCharge || !chargeDesc.trim() || chargeQty <= 0 || chargePrice <= 0}
                  className="w-full"
                >
                  {addingCharge ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <Plus className="mr-2 h-4 w-4" />
                  )}
                  Add to Statement
                </Button>
              </div>
            )}

            {/* Notes */}
            {statement.notes && (
              <div>
                <p className="text-xs text-muted-foreground mb-1">Notes</p>
                <p className="text-sm">{statement.notes}</p>
              </div>
            )}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground py-4 text-center">Statement not found.</p>
        )}

        <DialogFooter className="gap-2 flex-wrap">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          {/* Revert to Draft — admin/manager only, finalized statements */}
          {canRevertToDraft && (
            <Button
              variant="outline"
              className="border-amber-400 text-amber-700 hover:bg-amber-50"
              onClick={handleRevertToDraft}
              disabled={revertingToDraft}
            >
              {revertingToDraft ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <RotateCcw className="mr-2 h-4 w-4" />
              )}
              Revert to Draft
            </Button>
          )}
          {statement?.status === "draft" && (
            <Button onClick={() => handleStatusTransition("finalized")} disabled={actioning}>
              {actioning ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <CheckCircle className="mr-2 h-4 w-4" />}
              Finalize
            </Button>
          )}
          {/* Finalized: Send proforma (or resend) — only when PI not yet cancelled */}
          {(statement?.status === "finalized" || statement?.status === "exported") && !statement?.gst_invoice_number && !statement?.pi_cancelled_at && userRole && ["admin", "manager", "accounts"].includes(userRole) && (
            <Button onClick={handleSendProforma} disabled={sendingProforma} variant={statement?.proforma_sent_at ? "outline" : "default"}>
              {sendingProforma ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Send className="mr-2 h-4 w-4" />}
              {statement?.proforma_sent_at ? "Resend Proforma" : "Send Proforma + Payment Link"}
            </Button>
          )}
          {/* Early GST override — admin/manager, finalized, unpaid, no GST yet */}
          {statement?.status === "finalized" && !statement?.gst_invoice_number && !statement?.pi_cancelled_at && statement?.payment_status !== "paid" && userRole && ["admin", "manager"].includes(userRole) && (
            <Button
              variant="outline"
              className="border-amber-400 text-amber-700 hover:bg-amber-50"
              onClick={() => setShowConvertToGst(true)}
            >
              <AlertTriangle className="mr-2 h-4 w-4" />
              Issue GST Invoice (Override)
            </Button>
          )}
          {/* Payment received offline: Generate GST invoice */}
          {(statement?.status === "finalized" || statement?.status === "exported") && !statement?.gst_invoice_number && (statement?.payment_status === "paid" || statement?.payment_status === "partially_paid") && userRole && ["admin", "manager", "accounts"].includes(userRole) && (
            <Button onClick={handleGenerateGstInvoice} disabled={generatingGst} className="bg-green-700 hover:bg-green-800">
              {generatingGst ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <FileCheck className="mr-2 h-4 w-4" />}
              Generate &amp; Send GST Invoice
            </Button>
          )}
          {/* GST invoice already generated: show number */}
          {statement?.gst_invoice_number && (
            <div className="flex items-center gap-2 text-sm text-green-700 font-medium">
              <FileCheck className="h-4 w-4" />
              {statement.gst_invoice_number}
              {statement?.pi_cancelled_at && (
                <span className="text-xs text-amber-600 font-normal">(Early override)</span>
              )}
            </div>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>

    {/* Early GST override confirmation dialog */}
    {statement && (
      <ConvertToGstEarlyDialog
        open={showConvertToGst}
        onOpenChange={setShowConvertToGst}
        statementId={statement.id}
        statementNumber={statement.statement_number}
        customerName={
          statement.lead?.company ||
          `${statement.lead?.first_name || ""} ${statement.lead?.last_name || ""}`.trim() ||
          "Customer"
        }
        customerEmail={statement.lead?.email}
        periodLabel={new Date(statement.period_start + "T00:00:00").toLocaleDateString("en-IN", {
          timeZone: "Asia/Kolkata", month: "short", year: "numeric",
        })}
        totalAmount={statement.total_amount}
        hasExistingPaymentLink={!!statement.razorpay_payment_link_url}
        onSuccess={() => { onStatusChange(); onOpenChange(false); }}
      />
    )}
    </>
  );
}
