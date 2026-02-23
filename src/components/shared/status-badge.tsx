import { Badge } from "@/components/ui/badge";
import {
  LEAD_STATUS_LABELS,
  LEAD_STATUS_COLORS,
  TASK_STATUS_LABELS,
  TASK_STATUS_COLORS,
  TASK_PRIORITY_LABELS,
  TASK_PRIORITY_COLORS,
  AGGREGATOR_STATUS_LABELS,
  AGGREGATOR_STATUS_COLORS,
  CASE_STATUS_LABELS,
  CASE_STATUS_COLORS,
  CASE_DOC_STATUS_LABELS,
  CASE_DOC_STATUS_COLORS,
  COMPLIANCE_STATUS_LABELS,
  COMPLIANCE_STATUS_COLORS,
  AGREEMENT_STATUS_LABELS,
  AGREEMENT_STATUS_COLORS,
  AGG_INVOICE_STATUS_LABELS,
  AGG_INVOICE_STATUS_COLORS,
  VO_PURPOSE_LABELS,
  VO_PURPOSE_COLORS,
} from "@/lib/constants";
import { cn } from "@/lib/utils";

interface StatusBadgeProps {
  type:
    | "lead_status"
    | "task_status"
    | "task_priority"
    | "aggregator_status"
    | "case_status"
    | "case_doc_status"
    | "compliance_status"
    | "agreement_status"
    | "agg_invoice_status"
    | "vo_purpose";
  value: string;
  className?: string;
}

const CONFIG: Record<string, { labels: Record<string, string>; colors: Record<string, string> }> = {
  lead_status: { labels: LEAD_STATUS_LABELS, colors: LEAD_STATUS_COLORS },
  task_status: { labels: TASK_STATUS_LABELS, colors: TASK_STATUS_COLORS },
  task_priority: { labels: TASK_PRIORITY_LABELS, colors: TASK_PRIORITY_COLORS },
  aggregator_status: { labels: AGGREGATOR_STATUS_LABELS, colors: AGGREGATOR_STATUS_COLORS },
  case_status: { labels: CASE_STATUS_LABELS, colors: CASE_STATUS_COLORS },
  case_doc_status: { labels: CASE_DOC_STATUS_LABELS, colors: CASE_DOC_STATUS_COLORS },
  compliance_status: { labels: COMPLIANCE_STATUS_LABELS, colors: COMPLIANCE_STATUS_COLORS },
  agreement_status: { labels: AGREEMENT_STATUS_LABELS, colors: AGREEMENT_STATUS_COLORS },
  agg_invoice_status: { labels: AGG_INVOICE_STATUS_LABELS, colors: AGG_INVOICE_STATUS_COLORS },
  vo_purpose: { labels: VO_PURPOSE_LABELS, colors: VO_PURPOSE_COLORS },
};

export function StatusBadge({ type, value, className }: StatusBadgeProps) {
  const config = CONFIG[type];
  if (!config) return <Badge variant="secondary">{value}</Badge>;
  const { labels, colors } = config;
  return (
    <Badge
      variant="secondary"
      className={cn(colors[value] || "bg-gray-100 text-gray-800", className)}
    >
      {labels[value] || value}
    </Badge>
  );
}

interface RatingBadgeProps {
  rating: string;
  className?: string;
}

const RATING_COLORS: Record<string, string> = {
  hot: "bg-red-100 text-red-700",
  warm: "bg-orange-100 text-orange-700",
  cold: "bg-blue-100 text-blue-700",
  none: "bg-gray-100 text-gray-500",
};

export function RatingBadge({ rating, className }: RatingBadgeProps) {
  if (!rating || rating === "none") return null;
  return (
    <Badge
      variant="secondary"
      className={cn(
        RATING_COLORS[rating] || "bg-gray-100 text-gray-500",
        className
      )}
    >
      {rating.charAt(0).toUpperCase() + rating.slice(1)}
    </Badge>
  );
}
