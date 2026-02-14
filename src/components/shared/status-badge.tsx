import { Badge } from "@/components/ui/badge";
import {
  LEAD_STATUS_LABELS,
  LEAD_STATUS_COLORS,
  TASK_STATUS_LABELS,
  TASK_STATUS_COLORS,
  TASK_PRIORITY_LABELS,
  TASK_PRIORITY_COLORS,
} from "@/lib/constants";
import { cn } from "@/lib/utils";

interface StatusBadgeProps {
  type: "lead_status" | "task_status" | "task_priority";
  value: string;
  className?: string;
}

const CONFIG = {
  lead_status: { labels: LEAD_STATUS_LABELS, colors: LEAD_STATUS_COLORS },
  task_status: { labels: TASK_STATUS_LABELS, colors: TASK_STATUS_COLORS },
  task_priority: { labels: TASK_PRIORITY_LABELS, colors: TASK_PRIORITY_COLORS },
};

export function StatusBadge({ type, value, className }: StatusBadgeProps) {
  const { labels, colors } = CONFIG[type];
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
  if (rating === "none") return null;
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
