"use client";

import {
  Phone,
  Users,
  FileText,
  Mail,
  MapPin,
  Clock,
  CalendarCheck,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { useActivities } from "@/hooks/use-activities";
import { Skeleton } from "@/components/shared/loading-skeleton";
import { formatDate, formatDuration, getInitials } from "@/lib/utils";
import {
  ACTIVITY_TYPE_LABELS,
  CALL_OUTCOME_LABELS,
} from "@/lib/constants";
import type { Activity } from "@/types";

const ACTIVITY_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  call: Phone,
  meeting: Users,
  note: FileText,
  email: Mail,
  tour: MapPin,
};

const ACTIVITY_COLORS: Record<string, string> = {
  call: "bg-blue-100 text-blue-600",
  meeting: "bg-purple-100 text-purple-600",
  note: "bg-gray-100 text-gray-600",
  email: "bg-green-100 text-green-600",
  tour: "bg-orange-100 text-orange-600",
};

function ActivityItem({ activity }: { activity: Activity }) {
  const Icon = ACTIVITY_ICONS[activity.type] || FileText;
  const colorClass = ACTIVITY_COLORS[activity.type] || "bg-gray-100 text-gray-600";

  return (
    <div className="flex gap-3">
      {/* Icon */}
      <div className="flex flex-col items-center">
        <div className={`rounded-full p-2 ${colorClass}`}>
          <Icon className="h-4 w-4" />
        </div>
        <div className="flex-1 w-px bg-border mt-2" />
      </div>

      {/* Content */}
      <div className="flex-1 pb-6">
        <div className="flex items-start justify-between gap-2">
          <div>
            <div className="flex items-center gap-2">
              <Badge variant="outline" className="text-xs">
                {ACTIVITY_TYPE_LABELS[activity.type]}
              </Badge>
              {activity.subject && (
                <span className="font-medium text-sm">{activity.subject}</span>
              )}
            </div>
            {activity.description && (
              <p className="text-sm text-muted-foreground mt-1 whitespace-pre-wrap">
                {activity.description}
              </p>
            )}

            {/* Call-specific info */}
            {activity.type === "call" && (
              <div className="flex items-center gap-3 mt-2 text-xs text-muted-foreground">
                {activity.call_outcome && (
                  <span className="flex items-center gap-1">
                    <Phone className="h-3 w-3" />
                    {CALL_OUTCOME_LABELS[activity.call_outcome]}
                  </span>
                )}
                {activity.call_duration_seconds != null &&
                  activity.call_duration_seconds > 0 && (
                    <span className="flex items-center gap-1">
                      <Clock className="h-3 w-3" />
                      {formatDuration(activity.call_duration_seconds)}
                    </span>
                  )}
              </div>
            )}

            {/* Meeting-specific info */}
            {activity.type === "meeting" && activity.meeting_location && (
              <p className="text-xs text-muted-foreground mt-1 flex items-center gap-1">
                <MapPin className="h-3 w-3" />
                {activity.meeting_location}
              </p>
            )}

            {/* Follow-up info */}
            {activity.follow_up_date && (
              <div className="flex items-center gap-1 mt-2 text-xs">
                <CalendarCheck className="h-3 w-3" />
                <span
                  className={
                    activity.is_follow_up_done
                      ? "text-green-600"
                      : "text-orange-600"
                  }
                >
                  Follow-up: {formatDate(activity.follow_up_date)}
                  {activity.is_follow_up_done ? " (Done)" : ""}
                </span>
              </div>
            )}
          </div>

          {/* Timestamp & creator */}
          <div className="text-right text-xs text-muted-foreground shrink-0">
            <p>{formatDate(activity.created_at)}</p>
            {activity.creator && (
              <p className="mt-0.5">{activity.creator.full_name}</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

interface ActivityTimelineProps {
  leadId: string;
  onRefresh?: () => void;
}

export function ActivityTimeline({ leadId }: ActivityTimelineProps) {
  const { data: activities, loading, error } = useActivities(leadId);

  if (loading) {
    return (
      <div className="space-y-4">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="flex gap-3">
            <Skeleton className="h-8 w-8 rounded-full" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-4 w-full" />
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <p className="text-sm text-destructive text-center py-8">
        Failed to load activities. Please try again.
      </p>
    );
  }

  if (!activities || activities.length === 0) {
    return (
      <p className="text-sm text-muted-foreground text-center py-8">
        No activities yet. Log your first interaction.
      </p>
    );
  }

  return (
    <div>
      {(activities ?? []).map((activity) => (
        <ActivityItem key={activity.id} activity={activity} />
      ))}
    </div>
  );
}
