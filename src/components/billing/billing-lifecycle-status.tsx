"use client";

import {
  FileText, CheckCircle2, Send, CreditCard, Receipt, BookCheck,
  XCircle, Clock, AlertCircle, AlertTriangle,
} from "lucide-react";

/**
 * BillingLifecycleStatus — status badge showing where a billing statement
 * is in its lifecycle and what the next action is.
 *
 * Lifecycle stages:
 *   Draft       → Needs finalizing
 *   Finalized   → Send proforma invoice
 *   Proforma    → Awaiting payment
 *   Paid        → Generate GST invoice
 *   Invoiced    → Accounted
 *   Complete    → Done
 *   Voided
 */

interface LifecycleProps {
  status: string;
  emailed_at?: string | null;
  razorpay_payment_link_url?: string | null;
  payment_status?: string | null;
  accounted?: boolean | null;
  finalized_at?: string | null;
  gst_invoice_number?: string | null;
  proforma_sent_at?: string | null;
  /** Set when the PI was cancelled early and a GST invoice was issued before payment */
  pi_cancelled_at?: string | null;
  /** compact = badge only; full = badge + next-action hint below */
  variant?: "compact" | "full";
}

type Stage =
  | "voided"
  | "draft"
  | "finalized"
  | "proforma_sent"
  | "partially_paid"
  | "paid"
  | "gst_sent_unpaid"
  | "gst_override_unpaid"
  | "invoiced"
  | "complete";

interface StageConfig {
  label: string;
  next: string | null;
  /** Tailwind classes for pill bg + text */
  pill: string;
  /** Tailwind class for icon color */
  iconColor: string;
  Icon: React.ElementType;
}

const STAGE_CONFIG: Record<Stage, StageConfig> = {
  voided: {
    label: "Voided",
    next: null,
    pill: "bg-red-100 text-red-700 border border-red-200",
    iconColor: "text-red-500",
    Icon: XCircle,
  },
  draft: {
    label: "Draft",
    next: "Finalize to proceed",
    pill: "bg-gray-100 text-gray-600 border border-gray-200",
    iconColor: "text-gray-400",
    Icon: FileText,
  },
  finalized: {
    label: "Finalized",
    next: "Send proforma invoice",
    pill: "bg-amber-50 text-amber-700 border border-amber-200",
    iconColor: "text-amber-500",
    Icon: AlertCircle,
  },
  proforma_sent: {
    label: "Proforma Sent",
    next: "Awaiting payment",
    pill: "bg-blue-50 text-blue-700 border border-blue-200",
    iconColor: "text-blue-500",
    Icon: Send,
  },
  partially_paid: {
    label: "Partially Paid",
    next: "Balance payment pending",
    pill: "bg-orange-50 text-orange-700 border border-orange-200",
    iconColor: "text-orange-500",
    Icon: CreditCard,
  },
  paid: {
    label: "Payment Received",
    next: "Generate GST invoice",
    pill: "bg-violet-50 text-violet-700 border border-violet-200",
    iconColor: "text-violet-500",
    Icon: CreditCard,
  },
  gst_sent_unpaid: {
    label: "GST Sent — Unpaid",
    next: "Collect payment",
    pill: "bg-orange-50 text-orange-700 border border-orange-200",
    iconColor: "text-orange-500",
    Icon: AlertCircle,
  },
  gst_override_unpaid: {
    label: "Tax Invoice — Pending",
    next: "PI cancelled · collect payment",
    pill: "bg-amber-50 text-amber-800 border border-amber-300",
    iconColor: "text-amber-600",
    Icon: AlertTriangle,
  },
  invoiced: {
    label: "GST Invoice Sent",
    next: "Mark as accounted",
    pill: "bg-teal-50 text-teal-700 border border-teal-200",
    iconColor: "text-teal-500",
    Icon: Receipt,
  },
  complete: {
    label: "Accounted",
    next: null,
    pill: "bg-green-50 text-green-700 border border-green-200",
    iconColor: "text-green-500",
    Icon: BookCheck,
  },
};

function resolveStage(props: LifecycleProps): Stage {
  const {
    status,
    payment_status,
    accounted,
    gst_invoice_number,
    proforma_sent_at,
    pi_cancelled_at,
  } = props;

  if (status === "voided") return "voided";

  const isFinalized = status === "finalized" || status === "exported";
  const hasGstInvoice = !!gst_invoice_number;
  const hasProforma = !!proforma_sent_at;
  const isPaid = payment_status === "paid";
  const isPartiallyPaid = payment_status === "partially_paid";
  const isAccounted = !!accounted;
  const isGstOverride = !!pi_cancelled_at; // PI was cancelled, GST issued early

  if (!isFinalized) return "draft";
  if (isAccounted && hasGstInvoice) return "complete";
  // If GST invoice exists, check whether payment was also received
  if (hasGstInvoice && isPaid) return "invoiced";
  // GST issued early (override) — still waiting on payment
  if (hasGstInvoice && isGstOverride) return "gst_override_unpaid";
  if (hasGstInvoice) return "gst_sent_unpaid"; // GST sent post-payment but unpaid (edge case)
  if (isPaid) return "paid";
  if (isPartiallyPaid) return "partially_paid";
  if (hasProforma) return "proforma_sent";
  return "finalized";
}

export function BillingLifecycleStatus(props: LifecycleProps) {
  const { variant = "compact" } = props;
  const stage = resolveStage(props);
  const config = STAGE_CONFIG[stage];
  const { Icon, pill, iconColor, label, next } = config;

  return (
    <div className="flex flex-col gap-0.5 min-w-0">
      {/* Main badge */}
      <span className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-full text-xs font-medium whitespace-nowrap ${pill}`}>
        <Icon className={`h-3 w-3 shrink-0 ${iconColor}`} />
        {label}
      </span>

      {/* Next-action hint — shown in full variant, or always when there's a next action */}
      {next && (
        <span className="text-[10px] text-muted-foreground pl-1 flex items-center gap-1 whitespace-nowrap">
          <Clock className="h-2.5 w-2.5 shrink-0" />
          {next}
        </span>
      )}
    </div>
  );
}
