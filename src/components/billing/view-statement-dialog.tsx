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
import { Badge } from "@/components/ui/badge";

import { Skeleton } from "@/components/shared/loading-skeleton";
import { Loader2, CheckCircle, Upload, Plus, X, Send, FileCheck, Ban, RotateCcw, AlertTriangle, Trash2, IndianRupee, ExternalLink, Bell, Clock, Copy, Download, Mail } from "lucide-react";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import { formatDate, formatCurrency } from "@/lib/utils";
import { computeSettlement } from "@/lib/settlement";
import { BillingLifecycleStatus } from "@/components/billing/billing-lifecycle-status";
import { TallyStatusBadge } from "@/components/billing/tally-status-badge";
import { BillingModeTag } from "@/components/billing/billing-mode-tag";
import { ConvertToGstEarlyDialog } from "@/components/billing/convert-to-gst-early-dialog";
import { CreditNoteUploadDialog } from "@/components/billing/credit-note-upload-dialog";
import { StatementLifecyclePanel } from "@/components/accounting/statement-lifecycle";
import { StatementTimeline } from "@/components/accounting/statement-timeline";
import { CommunicationSentDialog } from "@/components/communications/communication-sent-dialog";
import { RecentCommunicationsCard } from "@/components/communications/recent-communications-card";
import type { CommunicationLogEntry } from "@/types";

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

interface ReminderRecord {
  id: string;
  stage_index: number;
  stage_label: string;
  channel: string;
  recipient: string;
  status: string;
  error?: string | null;
  triggered_by: string;
  sent_at: string;
  triggered_by_user?: { full_name: string } | null;
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
  reminder_count?: number | null;
  voided_at?: string | null;
  /** Set when this draft was created by voiding an earlier statement. */
  voided_statement_id?: string | null;
  // Tally state (surfaced via TallyStatusBadge)
  issuance_channel?: string | null;
  lifecycle_stage?: string | null;
  tally_invoice_number?: string | null;
  tally_irn?: string | null;
  tally_credit_note_number?: string | null;
  tally_last_error?: string | null;
  tally_delivered_at?: string | null;
  contract?: { id: string; contract_number: string; title?: string; billing_mode?: string | null } | null;
  booking?: { id: string; booking_number: string; booking_date: string; guest_name?: string } | null;
  lead?: { first_name: string; last_name: string; company?: string; email?: string } | null;
  usage_charges?: UsageCharge[];
  facility_charges?: FacilityCharge[];
  service_charges?: ServiceCharge[];
  booking_charges?: BookingCharge[];
  billing_payments?: Array<{
    id: string;
    amount: number;
    tds_amount?: number | null;
    payment_date: string;
    payment_mode: string;
    payment_reference?: string | null;
    razorpay_payment_id?: string | null;
    recorded_by_user?: { full_name: string } | null;
  }> | null;
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
  /** Called when user clicks Record Payment — opens payment dialog in parent */
  onRecordPayment?: (statementId: string, balanceDue: number) => void;
}

export function ViewStatementDialog({
  statementId,
  open,
  onOpenChange,
  onStatusChange,
  userRole,
  onRecordPayment,
}: ViewStatementDialogProps) {
  const [statement, setStatement] = useState<Statement | null>(null);
  const [loading, setLoading] = useState(false);
  const [actioning, setActioning] = useState(false);
  const [sendingProforma, setSendingProforma] = useState(false);
  const [generatingGst, setGeneratingGst] = useState(false);
  const [revertingToDraft, setRevertingToDraft] = useState(false);
  const [retryingTally, setRetryingTally] = useState(false);
  const [showConvertToGst, setShowConvertToGst] = useState(false);
  const [gstModeReady, setGstModeReady] = useState<boolean | null>(null); // null = loading
  const [showCreditNoteCancel, setShowCreditNoteCancel] = useState(false);

  // Reminder state
  const [sendingReminder, setSendingReminder] = useState(false);
  const [showReminderHistory, setShowReminderHistory] = useState(false);
  const [reminderHistory, setReminderHistory] = useState<ReminderRecord[]>([]);
  const [reminderHistoryLoading, setReminderHistoryLoading] = useState(false);

  // Resend GST email state
  const [resendingGstEmail, setResendingGstEmail] = useState(false);

  // Post-send confirmation modal + inline card refresh trigger
  const [sentEntry, setSentEntry] = useState<CommunicationLogEntry | null>(null);
  const [showSentDialog, setShowSentDialog] = useState(false);
  const [commsRefreshKey, setCommsRefreshKey] = useState(0);

  // Re-issue payment link state
  const [reissuingLink, setReissuingLink] = useState(false);
  const [showResendChoice, setShowResendChoice] = useState(false);

  // Void / Cancel-Tally state
  const [showVoidConfirm, setShowVoidConfirm] = useState(false);
  const [voidReason, setVoidReason] = useState("");
  const [voidSubmitting, setVoidSubmitting] = useState(false);

  // Discard-draft state
  const [showDiscardConfirm, setShowDiscardConfirm] = useState(false);
  const [discardReason, setDiscardReason] = useState("");
  const [discardSubmitting, setDiscardSubmitting] = useState(false);

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

  useEffect(() => {
    if (!open) return;
    fetch("/api/settings/public")
      .then((res) => res.json())
      .then((json: { data?: Record<string, string> }) => {
        const crm = json.data?.["crm_gst_enabled"] === "true";
        const tally = json.data?.["tally_sync_enabled"] === "true";
        setGstModeReady(crm || tally);
      })
      .catch(() => setGstModeReady(true)); // fail open — don't block UI on settings error
  }, [open]);

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
    setShowResendChoice(false);
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
        if (json.commLogEntry) {
          setSentEntry(json.commLogEntry);
          setShowSentDialog(true);
          setCommsRefreshKey((k) => k + 1);
        }
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

  const handleVoidStatement = async () => {
    if (!statementId || !voidReason.trim()) return;
    setVoidSubmitting(true);
    try {
      const res = await fetch(`/api/billing-statements/${statementId}/void`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ void_reason: voidReason.trim() }),
      });
      const json = await res.json();
      if (res.ok) {
        toast.success(json.message || "Statement voided and replacement draft created");
        setShowVoidConfirm(false);
        setVoidReason("");
        onStatusChange();
        onOpenChange(false);
        return;
      }
      // Tally-issued invoice — plain void isn't allowed, cancellation needs a
      // real credit note (see credit-note-upload-dialog.tsx).
      if (json.issuance_channel === "tally") {
        setShowVoidConfirm(false);
        setShowCreditNoteCancel(true);
      } else {
        toast.error(json.error || "Failed to void statement");
      }
    } catch {
      toast.error("Something went wrong");
    } finally {
      setVoidSubmitting(false);
    }
  };

  const canVoid =
    !!statement &&
    ["finalized", "exported"].includes(statement.status) &&
    userRole === "admin";

  // Discard is void's draft-stage counterpart: the client has never seen a
  // draft, so this is an internal cleanup rather than a cancellation, and it
  // sits with everyone who runs billing rather than admin alone.
  const canDiscard =
    !!statement &&
    statement.status === "draft" &&
    ["admin", "manager", "accounts"].includes(userRole ?? "");

  const handleDiscardStatement = async () => {
    if (!statementId || !discardReason.trim()) return;
    setDiscardSubmitting(true);
    try {
      const res = await fetch(`/api/billing-statements/${statementId}/discard`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ discard_reason: discardReason.trim() }),
      });
      const json = await res.json();
      if (res.ok) {
        toast.success(json.message || "Draft discarded");
        setShowDiscardConfirm(false);
        setDiscardReason("");
        onStatusChange();
        onOpenChange(false);
      } else {
        toast.error(json.error || "Failed to discard draft");
      }
    } catch {
      toast.error("Something went wrong");
    } finally {
      setDiscardSubmitting(false);
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

  const handleSendReminder = async () => {
    if (!statement) return;
    setSendingReminder(true);
    try {
      const res = await fetch(`/api/billing-statements/${statement.id}/send-reminder`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed");
      const channels = [json.emailSent && "email", json.whatsAppSent && "WhatsApp"].filter(Boolean).join(" + ");
      toast.success(`${json.toneLabel} sent via ${channels || "no channel"}`);
      onStatusChange();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to send reminder");
    } finally {
      setSendingReminder(false);
    }
  };

  const handleLoadReminderHistory = async () => {
    if (!statement) return;
    setShowReminderHistory(true);
    setReminderHistoryLoading(true);
    setReminderHistory([]);
    try {
      const res = await fetch(`/api/billing-statements/${statement.id}/send-reminder`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed");
      setReminderHistory(json.history || []);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to load history");
    } finally {
      setReminderHistoryLoading(false);
    }
  };

  const handleResendGstEmail = async () => {
    if (!statement?.lead?.email) {
      toast.error("No email address on file for this customer");
      return;
    }
    setResendingGstEmail(true);
    try {
      const res = await fetch(`/api/billing-statements/${statement.id}/gst-invoice-email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ recipients: [statement.lead.email] }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed");
      toast.success("GST invoice email resent");
      onStatusChange();
      if (json.commLogEntry) {
        setSentEntry(json.commLogEntry);
        setShowSentDialog(true);
        setCommsRefreshKey((k) => k + 1);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to resend GST email");
    } finally {
      setResendingGstEmail(false);
    }
  };

  const handleReissuePaymentLink = async () => {
    if (!statementId) return;
    setShowResendChoice(false);
    setReissuingLink(true);
    try {
      const res = await fetch(`/api/billing-statements/${statementId}/reissue-payment-link`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to re-issue payment link");
      toast.success(
        json.emailedTo
          ? `Fresh payment link sent to ${json.emailedTo}`
          : "Fresh payment link created (no email on file — copy the link manually)",
      );
      onStatusChange();
      const refreshed = await fetch(`/api/billing-statements/${statementId}`);
      if (refreshed.ok) { const j = await refreshed.json(); setStatement(j.data || null); }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to re-issue payment link");
    } finally {
      setReissuingLink(false);
    }
  };

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
            {/* Universal handoff lifecycle (visible on every statement,
                regardless of tally_handoff_v2 state — the panel reads from
                /api/accounting/inbox?id=… and gracefully degrades). */}
            <StatementLifecyclePanel statementId={statement.id} />

            {/* Collapsible chronological history — fetches timeline events
                only when the user expands the disclosure. */}
            <details className="rounded border bg-background -mt-2">
              <summary className="cursor-pointer select-none px-3 py-2 text-xs font-medium text-muted-foreground hover:text-foreground">
                Show timeline
              </summary>
              <div className="px-3 pb-3">
                <StatementTimeline statementId={statement.id} maxHeight="280px" />
              </div>
            </details>

            {/* Recent communications — persistent, always-visible record of
                every email/WhatsApp/SMS sent for this statement, with content
                and attachment. The always-visible counterpart to the
                post-send confirmation modal. */}
            <div>
              <p className="text-xs font-medium text-muted-foreground mb-1.5">Recent Communications</p>
              <RecentCommunicationsCard
                entityType="billing_statement"
                entityId={statement.id}
                refreshKey={commsRefreshKey}
              />
            </div>

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
                <div className="flex items-center gap-2 flex-wrap">
                  <p className="font-mono font-medium">{reference}</p>
                  <BillingModeTag mode={statement.contract?.billing_mode} />
                </div>
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
                <div className="rounded-lg overflow-hidden border border-l-4 border-l-slate-400 border-gray-200">
                  <div className="px-4 py-2.5 bg-slate-50 border-b border-slate-100">
                    <h4 className="text-sm font-semibold text-slate-700">Billing Summary</h4>
                  </div>
                  <div className="p-4 space-y-2 text-sm">
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
                </div>
              );
            })()}

            {/* Payment history — shown on finalized/exported statements */}
            {(statement.status === "finalized" || statement.status === "exported") && (() => {
              const payments = statement.billing_payments || [];
              const { totalPaid: totalReceived, balanceDue } = computeSettlement(statement.total_amount, payments);
              const isFullyPaid = statement.payment_status === "paid";

              return (
                <div className="rounded-lg overflow-hidden border border-l-4 border-l-emerald-400 border-gray-200">
                  <div className="flex items-center justify-between px-4 py-2.5 bg-emerald-50 border-b border-emerald-100">
                    <h4 className="text-sm font-semibold text-emerald-800">Payments Received</h4>
                    {!isFullyPaid && onRecordPayment && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 text-xs border-emerald-300 text-emerald-700 hover:bg-emerald-100"
                        onClick={() => onRecordPayment(statement.id, balanceDue)}
                      >
                        <IndianRupee className="h-3 w-3 mr-1" />
                        Record Payment
                      </Button>
                    )}
                    {isFullyPaid && (
                      <span className="text-xs text-emerald-700 bg-emerald-100 border border-emerald-200 rounded px-2 py-0.5">
                        ✓ Fully paid
                      </span>
                    )}
                  </div>
                  <div className="p-4 space-y-2">
                  {!isFullyPaid && statement.razorpay_payment_link_url && (
                    <div className="flex items-center gap-2 rounded-md border border-teal-200 bg-teal-50 px-3 py-2">
                      <span className="text-xs text-teal-700 flex-1 truncate">Payment link</span>
                      <a
                        href={statement.razorpay_payment_link_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs text-teal-700 hover:text-teal-900 underline"
                        title="Open payment link"
                      >
                        <ExternalLink className="h-3.5 w-3.5" />
                      </a>
                      <button
                        className="text-xs text-teal-700 hover:text-teal-900"
                        title="Copy payment link"
                        onClick={() => {
                          navigator.clipboard.writeText(statement.razorpay_payment_link_url!);
                          toast.success("Payment link copied");
                        }}
                      >
                        <Copy className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  )}

                  {payments.length > 0 ? (
                    <div className="rounded-md border divide-y text-sm">
                      {payments.map((p) => {
                        const isRazorpay = p.payment_mode === "razorpay" || !!p.razorpay_payment_id;
                        const modeLabel = isRazorpay ? "Razorpay" : (p.payment_mode?.toUpperCase() || "—");
                        const settled = Number(p.amount) + Number(p.tds_amount || 0);
                        return (
                          <div key={p.id} className="flex items-center justify-between px-3 py-2">
                            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                              <span className="text-xs text-muted-foreground">{formatDate(p.payment_date)}</span>
                              <Badge variant="outline" className={`text-xs ${isRazorpay ? "border-violet-300 text-violet-700 bg-violet-50" : ""}`}>
                                {modeLabel}
                              </Badge>
                              {p.razorpay_payment_id ? (
                                <a
                                  href={`https://dashboard.razorpay.com/app/payments/${p.razorpay_payment_id}`}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="inline-flex items-center gap-0.5 text-xs text-violet-700 hover:text-violet-900 underline font-mono"
                                >
                                  {p.razorpay_payment_id}
                                  <ExternalLink className="h-2.5 w-2.5" />
                                </a>
                              ) : p.payment_reference ? (
                                <span className="text-xs text-muted-foreground font-mono">Ref: {p.payment_reference}</span>
                              ) : null}
                              {(p.tds_amount || 0) > 0 && (
                                <span className="text-xs text-muted-foreground">TDS: {formatCurrency(p.tds_amount!)}</span>
                              )}
                              {p.recorded_by_user?.full_name ? (
                                <span className="text-xs text-muted-foreground">· {p.recorded_by_user.full_name}</span>
                              ) : isRazorpay ? (
                                <span className="text-xs text-muted-foreground italic">· via gateway</span>
                              ) : null}
                            </div>
                            <div className="flex flex-col items-end ml-2 flex-shrink-0">
                              <span className="font-medium text-green-700">{formatCurrency(p.amount)}</span>
                              {(p.tds_amount || 0) > 0 && (
                                <span className="text-[10px] text-muted-foreground">settled {formatCurrency(settled)}</span>
                              )}
                            </div>
                          </div>
                        );
                      })}
                      <div className="flex justify-between items-center px-3 py-2 bg-muted/30 text-xs">
                        <span className="text-muted-foreground">Total received</span>
                        <span className="font-medium text-green-700">{formatCurrency(totalReceived)}</span>
                      </div>
                      {balanceDue > 0 && (
                        <div className="flex justify-between items-center px-3 py-2 bg-amber-50 text-xs">
                          <span className="font-medium text-amber-700">Balance due</span>
                          <span className="font-semibold text-amber-700">{formatCurrency(balanceDue)}</span>
                        </div>
                      )}
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground">No payments recorded yet.</p>
                  )}

                  {!isFullyPaid && balanceDue > 0 && (
                    <p className="text-xs text-amber-600">
                      Outstanding: {formatCurrency(balanceDue)} of {formatCurrency(statement.total_amount)}
                    </p>
                  )}
                  </div>
                </div>
              );
            })()}

            {/* Booking charges table (auto-rolled contract bookings) */}
            {(statement.booking_charges?.length ?? 0) > 0 && (
              <div className="rounded-lg overflow-hidden border border-l-4 border-l-sky-400 border-gray-200">
                <div className="px-4 py-2.5 bg-sky-50 border-b border-sky-100">
                  <h4 className="text-sm font-semibold text-sky-800">Meeting Room Bookings</h4>
                </div>
                <div className="overflow-x-auto">
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
              <div className="rounded-lg overflow-hidden border border-l-4 border-l-amber-400 border-gray-200">
                <div className="px-4 py-2.5 bg-amber-50 border-b border-amber-100">
                  <h4 className="text-sm font-semibold text-amber-800">Ad-hoc &amp; Facility Charges</h4>
                </div>
                <div className="overflow-x-auto">
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
              <div className="rounded-lg overflow-hidden border border-l-4 border-l-violet-400 border-gray-200">
                <div className="px-4 py-2.5 bg-violet-50 border-b border-violet-100">
                  <h4 className="text-sm font-semibold text-violet-800">Service Usage</h4>
                </div>
                <div className="overflow-x-auto">
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
          {/* Record Payment — finalized/exported, not yet fully paid */}
          {(statement?.status === "finalized" || statement?.status === "exported") && statement?.payment_status !== "paid" && onRecordPayment && (() => {
            const balanceDue = computeSettlement(statement.total_amount, statement.billing_payments).balanceDue;
            return (
              <Button
                variant="default"
                className="bg-teal-700 hover:bg-teal-800"
                onClick={() => onRecordPayment(statement.id, balanceDue)}
              >
                <IndianRupee className="mr-2 h-4 w-4" />
                Record Payment{balanceDue > 0 ? ` — ${formatCurrency(balanceDue)} due` : ""}
              </Button>
            );
          })()}
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
          {/* Finalized: Send / Resend proforma — only when PI not yet cancelled */}
          {(statement?.status === "finalized" || statement?.status === "exported") && !statement?.gst_invoice_number && !statement?.pi_cancelled_at && statement?.contract?.billing_mode !== "gst_direct" && userRole && ["admin", "manager", "accounts"].includes(userRole) && !showResendChoice && (
            <Button
              onClick={() => {
                // First send: go directly. Resend: offer link-renewal choice.
                if (statement?.proforma_sent_at && statement?.razorpay_payment_link_url && statement?.payment_status !== "paid") {
                  setShowResendChoice(true);
                } else {
                  handleSendProforma();
                }
              }}
              disabled={sendingProforma || reissuingLink}
              variant={statement?.proforma_sent_at ? "outline" : "default"}
            >
              {(sendingProforma || reissuingLink) ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Send className="mr-2 h-4 w-4" />}
              {statement?.proforma_sent_at ? "Resend Proforma" : "Send Proforma + Payment Link"}
            </Button>
          )}
          {/* Inline resend-choice panel — appears when Resend Proforma is clicked and a link already exists */}
          {(statement?.status === "finalized" || statement?.status === "exported") && !statement?.gst_invoice_number && !statement?.pi_cancelled_at && statement?.contract?.billing_mode !== "gst_direct" && showResendChoice && userRole && ["admin", "manager", "accounts"].includes(userRole) && (
            <div className="flex w-full flex-col gap-2 rounded-md border border-blue-200 bg-blue-50 p-3">
              <p className="text-sm font-medium text-blue-800">
                A payment link was previously sent. How would you like to resend?
              </p>
              <p className="text-xs text-blue-600">
                If the customer&apos;s link has expired, generate a fresh one — it cancels the old link and emails a new invoice with a new 15-day payment link.
              </p>
              <div className="flex gap-2 pt-1">
                <Button
                  size="sm"
                  variant="outline"
                  className="flex-1 border-slate-300 text-slate-700 hover:bg-slate-100"
                  onClick={handleSendProforma}
                  disabled={sendingProforma || reissuingLink}
                >
                  {sendingProforma ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <Send className="mr-1 h-3 w-3" />}
                  Resend with existing link
                </Button>
                <Button
                  size="sm"
                  className="flex-1 bg-blue-700 hover:bg-blue-800 text-white"
                  onClick={handleReissuePaymentLink}
                  disabled={sendingProforma || reissuingLink}
                >
                  {reissuingLink ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <RotateCcw className="mr-1 h-3 w-3" />}
                  Resend with new payment link
                </Button>
              </div>
              <button
                className="text-xs text-blue-500 hover:underline text-left"
                onClick={() => setShowResendChoice(false)}
              >
                Cancel
              </button>
            </div>
          )}
          {/* Send Reminder — finalized/exported, not yet paid, proforma already sent, not voided */}
          {(statement?.status === "finalized" || statement?.status === "exported") && statement?.payment_status !== "paid" && !!statement?.proforma_sent_at && !statement?.voided_at && userRole && ["admin", "manager", "accounts"].includes(userRole) && (
            <div className="flex gap-1">
              <Button
                variant="outline"
                className="border-amber-300 text-amber-700 hover:bg-amber-50"
                onClick={handleSendReminder}
                disabled={sendingReminder}
              >
                {sendingReminder ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Bell className="mr-2 h-4 w-4" />}
                Send Reminder
                {(statement?.reminder_count ?? 0) > 0 && (
                  <span className="ml-1.5 text-[10px] bg-amber-100 text-amber-800 rounded-full px-1.5 py-0.5 font-semibold">
                    {statement!.reminder_count}
                  </span>
                )}
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="text-amber-600 hover:bg-amber-50"
                title="View reminder history"
                onClick={handleLoadReminderHistory}
              >
                <Clock className="h-4 w-4" />
              </Button>
            </div>
          )}
          {/* Early GST override — admin/manager, finalized, unpaid, no GST yet */}
          {statement?.status === "finalized" && !statement?.gst_invoice_number && !statement?.pi_cancelled_at && statement?.payment_status !== "paid" && statement?.contract?.billing_mode !== "gst_direct" && userRole && ["admin", "manager"].includes(userRole) && (
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
            <Button
              onClick={handleGenerateGstInvoice}
              disabled={generatingGst || gstModeReady === false}
              title={gstModeReady === false ? "GST invoicing is on standby — activate CRM GST or Tally Sync from Admin → Tally Sync" : undefined}
              className="bg-green-700 hover:bg-green-800 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {generatingGst ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <FileCheck className="mr-2 h-4 w-4" />}
              Generate &amp; Send GST Invoice
            </Button>
          )}
          {/* GST invoice already generated: show number + download + resend */}
          {statement?.gst_invoice_number && (
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex items-center gap-1.5 text-sm text-green-700 font-medium">
                <FileCheck className="h-4 w-4" />
                {statement.gst_invoice_number}
                {statement?.pi_cancelled_at && (
                  <span className="text-xs text-amber-600 font-normal">(Early override)</span>
                )}
              </div>
              <a
                href={`/api/billing-statements/${statement.id}/gst-invoice-pdf`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-xs text-green-700 border border-green-300 rounded px-2 py-1 hover:bg-green-50"
                title="Download GST invoice PDF"
              >
                <Download className="h-3 w-3" />
                PDF
              </a>
              {statement?.lead?.email && userRole && ["admin", "manager", "accounts"].includes(userRole) && (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs border-green-300 text-green-700 hover:bg-green-50"
                  onClick={handleResendGstEmail}
                  disabled={resendingGstEmail}
                  title="Resend GST invoice email"
                >
                  {resendingGstEmail ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <Mail className="h-3 w-3 mr-1" />}
                  Resend Email
                </Button>
              )}
            </div>
          )}
          {/* Void / Cancel — admin only, finalized or exported statements */}
          {canVoid && !showVoidConfirm && (
            <Button
              variant="outline"
              className="border-red-300 text-red-600 hover:bg-red-50"
              onClick={() => setShowVoidConfirm(true)}
            >
              <Trash2 className="mr-2 h-4 w-4" />
              {statement?.issuance_channel === "tally" ? "Cancel Invoice" : "Void & Re-issue"}
            </Button>
          )}
          {canVoid && showVoidConfirm && (
            <div className="flex w-full flex-col gap-2 rounded-md border border-red-200 bg-red-50 p-3">
              <p className="text-sm font-medium text-red-700">
                {statement?.issuance_channel === "tally"
                  ? "This will queue a Credit Note in Tally. The invoice voids once Tally confirms."
                  : "This will void the statement and create a fresh draft for correction."}
              </p>
              <Textarea
                placeholder="Reason for void / cancellation (required)"
                value={voidReason}
                onChange={(e) => setVoidReason(e.target.value)}
                className="text-sm"
                rows={2}
              />
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="flex-1"
                  onClick={() => { setShowVoidConfirm(false); setVoidReason(""); }}
                  disabled={voidSubmitting}
                >
                  Cancel
                </Button>
                <Button
                  size="sm"
                  className="flex-1 bg-red-600 hover:bg-red-700 text-white"
                  onClick={handleVoidStatement}
                  disabled={voidSubmitting || !voidReason.trim()}
                >
                  {voidSubmitting ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <Trash2 className="mr-2 h-4 w-4" />
                  )}
                  {statement?.issuance_channel === "tally" ? "Confirm Cancel" : "Void & Create Draft"}
                </Button>
              </div>
            </div>
          )}
          {/* Discard — drafts only, admin/manager/accounts */}
          {canDiscard && !showDiscardConfirm && (
            <Button
              variant="outline"
              className="border-red-300 text-red-600 hover:bg-red-50"
              onClick={() => setShowDiscardConfirm(true)}
            >
              <Trash2 className="mr-2 h-4 w-4" />
              Discard Draft
            </Button>
          )}
          {canDiscard && showDiscardConfirm && (
            <div className="flex w-full flex-col gap-2 rounded-md border border-red-200 bg-red-50 p-3">
              <p className="text-sm font-medium text-red-700">
                {statement?.voided_statement_id
                  ? "This replacement draft will be discarded. The voided original stays voided, and this period becomes free to regenerate."
                  : "This draft will be discarded and the period freed up, so billing can regenerate it from scratch."}
              </p>
              <p className="text-xs text-red-600">
                Usage charges, bookings and service usage on this draft go back to unbilled — they will be picked up by whatever bills this period next.
              </p>
              <Textarea
                placeholder="Reason for discarding (required)"
                value={discardReason}
                onChange={(e) => setDiscardReason(e.target.value)}
                className="text-sm"
                rows={2}
              />
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="flex-1"
                  onClick={() => { setShowDiscardConfirm(false); setDiscardReason(""); }}
                  disabled={discardSubmitting}
                >
                  Cancel
                </Button>
                <Button
                  size="sm"
                  className="flex-1 bg-red-600 hover:bg-red-700 text-white"
                  onClick={handleDiscardStatement}
                  disabled={discardSubmitting || !discardReason.trim()}
                >
                  {discardSubmitting ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <Trash2 className="mr-2 h-4 w-4" />
                  )}
                  Discard Draft
                </Button>
              </div>
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

    {/* Credit-note cancellation dialog — Tally-issued invoices only */}
    {statement && showCreditNoteCancel && (
      <CreditNoteUploadDialog
        statement={{
          id: statement.id,
          statement_number: statement.statement_number,
          tally_invoice_number: statement.tally_invoice_number ?? null,
          total_amount: statement.total_amount,
          payment_status: statement.payment_status ?? "unpaid",
        }}
        onCancelled={() => {
          setShowCreditNoteCancel(false);
          setVoidReason("");
          onStatusChange();
          onOpenChange(false);
        }}
        onClose={() => setShowCreditNoteCancel(false)}
      />
    )}

    {/* Reminder history dialog */}
    <Dialog open={showReminderHistory} onOpenChange={(o) => !o && setShowReminderHistory(false)}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Reminder history — {statement?.statement_number}</DialogTitle>
        </DialogHeader>
        {reminderHistoryLoading ? (
          <div className="p-6 text-center text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin inline mr-2" /> Loading…
          </div>
        ) : reminderHistory.length === 0 ? (
          <div className="p-6 text-center text-muted-foreground">No reminders sent yet for this statement.</div>
        ) : (
          <div className="max-h-[400px] overflow-y-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-xs uppercase text-gray-600 border-b sticky top-0">
                <tr>
                  <th className="px-3 py-2 text-left">Sent</th>
                  <th className="px-3 py-2 text-left">Stage</th>
                  <th className="px-3 py-2 text-left">Channel</th>
                  <th className="px-3 py-2 text-left">Recipient</th>
                  <th className="px-3 py-2 text-left">Status</th>
                  <th className="px-3 py-2 text-left">By</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {reminderHistory.map((h) => (
                  <tr key={h.id}>
                    <td className="px-3 py-2 whitespace-nowrap text-xs">
                      {new Date(h.sent_at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" })}
                    </td>
                    <td className="px-3 py-2 text-xs">{h.stage_label}</td>
                    <td className="px-3 py-2 text-xs uppercase">{h.channel}</td>
                    <td className="px-3 py-2 text-xs">{h.recipient}</td>
                    <td className="px-3 py-2">
                      {h.status === "sent" ? (
                        <Badge className="bg-emerald-100 text-emerald-800 border-emerald-300 text-[10px]">SENT</Badge>
                      ) : (
                        <Badge className="bg-red-100 text-red-800 border-red-300 text-[10px]" title={h.error || ""}>FAILED</Badge>
                      )}
                    </td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">
                      {h.triggered_by === "cron" ? "Cron" : (h.triggered_by_user?.full_name || "Manual")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={() => setShowReminderHistory(false)}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <CommunicationSentDialog
      entry={sentEntry}
      open={showSentDialog}
      onOpenChange={setShowSentDialog}
    />
    </>
  );
}
