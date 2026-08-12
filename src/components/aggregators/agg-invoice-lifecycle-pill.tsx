import { FileText, Send, CheckCircle2, AlertTriangle, XCircle } from "lucide-react";
import type { AggInvoiceStatus } from "@/types";

/**
 * Compact lifecycle pill for an aggregator_invoices row — mirrors the
 * icon+label pattern of BillingLifecycleStatus (src/components/billing/)
 * but for the simpler postpaid-aggregator invoice lifecycle:
 *   Draft → Sent → Paid (or Overdue as a branch, Cancelled as a terminal).
 */

interface StageConfig {
  label: string;
  pill: string;
  iconColor: string;
  Icon: React.ElementType;
}

const STAGE_CONFIG: Record<AggInvoiceStatus, StageConfig> = {
  draft: {
    label: "Draft",
    pill: "bg-gray-100 text-gray-600 border border-gray-200",
    iconColor: "text-gray-400",
    Icon: FileText,
  },
  sent: {
    label: "Sent — awaiting payment",
    pill: "bg-blue-50 text-blue-700 border border-blue-200",
    iconColor: "text-blue-500",
    Icon: Send,
  },
  overdue: {
    label: "Overdue",
    pill: "bg-red-50 text-red-700 border border-red-200",
    iconColor: "text-red-500",
    Icon: AlertTriangle,
  },
  paid: {
    label: "Paid",
    pill: "bg-green-50 text-green-700 border border-green-200",
    iconColor: "text-green-500",
    Icon: CheckCircle2,
  },
  cancelled: {
    label: "Cancelled",
    pill: "bg-gray-100 text-gray-500 border border-gray-200",
    iconColor: "text-gray-400",
    Icon: XCircle,
  },
};

export function AggInvoiceLifecyclePill({ status }: { status: AggInvoiceStatus }) {
  const config = STAGE_CONFIG[status];
  const { Icon } = config;
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium whitespace-nowrap ${config.pill}`}>
      <Icon className={`h-3.5 w-3.5 ${config.iconColor}`} />
      {config.label}
    </span>
  );
}
