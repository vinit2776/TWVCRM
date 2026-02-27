"use client";

import { useState, useEffect, useRef } from "react";
import {
  Phone,
  Users,
  FileText,
  Mail,
  MapPin,
  Clock,
  CalendarCheck,
  CalendarClock,
  ClipboardList,
  UserCheck,
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
import { ActivityForm } from "@/components/activities/activity-form";

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

interface ActivityItemProps {
  activity: Activity;
  leadId: string;
  onActionComplete: () => void;
  /** When set to this activity's id, scroll to and briefly highlight the row */
  highlightId?: string;
}

function ActivityItem({ activity, leadId, onActionComplete, highlightId }: ActivityItemProps) {
  const Icon = ACTIVITY_ICONS[activity.type] || FileText;
  const colorClass = ACTIVITY_COLORS[activity.type] || "bg-gray-100 text-gray-600";

  const [acting, setActing] = useState(false);
  const [isRescheduling, setIsRescheduling] = useState(false);
  const [newDate, setNewDate] = useState("");
  const [highlighted, setHighlighted] = useState(false);
  const [logActivityOpen, setLogActivityOpen] = useState(false);
  const rowRef = useRef<HTMLDivElement>(null);

  // Scroll to & flash-highlight this row when the URL targets it
  useEffect(() => {
    if (highlightId === activity.id && rowRef.current) {
      rowRef.current.scrollIntoView({ behavior: "smooth", block: "center" });
      setHighlighted(true);
      const t = setTimeout(() => setHighlighted(false), 3000);
      return () => clearTimeout(t);
    }
  }, [highlightId, activity.id]);

  const hasPendingFollowUp = activity.follow_up_date && !activity.is_follow_up_done;

  // Called after ActivityForm successfully logs the new activity —
  // auto-closes the original follow-up and refreshes the timeline.
  const handleLogAndClose = async () => {
    try {
      await fetch(`/api/activities/${activity.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "close" }),
      });
    } catch {
      // Non-fatal — new activity was already logged successfully
    }
    onActionComplete();
  };

  const handleReschedule = async () => {
    if (!newDate) return;
    setActing(true);
    try {
      const res = await fetch(`/api/activities/${activity.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "reschedule", follow_up_date: newDate }),
      });
      if (res.ok) {
        setIsRescheduling(false);
        setNewDate("");
        onActionComplete();
      }
    } finally {
      setActing(false);
    }
  };

  return (
    <div
      ref={rowRef}
      className={`flex gap-3 rounded-md transition-colors duration-500 ${
        highlighted ? "bg-orange-50 -mx-3 px-3" : ""
      }`}
    >
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
          <div className="flex-1 min-w-0">
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
              <div className="mt-2 space-y-1 text-xs">
                {/* Date row + action buttons */}
                <div className="flex items-center gap-2 flex-wrap">
                  <div className="flex items-center gap-1">
                    <CalendarCheck className="h-3 w-3 shrink-0" />
                    <span
                      className={
                        activity.is_follow_up_done
                          ? "text-green-600"
                          : "text-orange-600 font-medium"
                      }
                    >
                      Follow-up: {formatDate(activity.follow_up_date)}
                      {activity.is_follow_up_done ? " (Done)" : ""}
                    </span>
                  </div>

                  {/* Inline action buttons — only shown for pending follow-ups */}
                  {hasPendingFollowUp && (
                    <div className="flex items-center gap-1">
                      {/* Log Activity — captures what was done and auto-closes the follow-up */}
                      <button
                        onClick={() => setLogActivityOpen(true)}
                        className="flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px] font-medium text-green-700 bg-green-50 border border-green-200 hover:bg-green-100 transition-colors"
                        title="Log what was done and close this follow-up"
                      >
                        <ClipboardList className="h-2.5 w-2.5" />
                        Log Activity
                      </button>

                      {/* Reschedule toggle */}
                      <button
                        onClick={() => {
                          if (isRescheduling) {
                            setIsRescheduling(false);
                            setNewDate("");
                          } else {
                            setNewDate(activity.follow_up_date!.split("T")[0]);
                            setIsRescheduling(true);
                          }
                        }}
                        disabled={acting}
                        className="flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px] font-medium text-slate-600 bg-slate-50 border border-slate-200 hover:bg-slate-100 transition-colors disabled:opacity-40"
                        title="Reschedule follow-up"
                      >
                        <CalendarClock className="h-2.5 w-2.5" />
                        Reschedule
                      </button>
                    </div>
                  )}
                </div>

                {/* Inline date picker when rescheduling */}
                {isRescheduling && (
                  <div className="flex items-center gap-2 pl-4 pt-0.5">
                    <input
                      type="date"
                      value={newDate}
                      onChange={(e) => setNewDate(e.target.value)}
                      className="text-xs border rounded px-2 py-0.5 bg-background focus:outline-none focus:ring-1 focus:ring-primary"
                      min={new Date().toISOString().split("T")[0]}
                    />
                    <button
                      onClick={handleReschedule}
                      disabled={!newDate || acting}
                      className="text-xs font-medium text-primary hover:underline disabled:opacity-40"
                    >
                      Confirm
                    </button>
                    <button
                      onClick={() => { setIsRescheduling(false); setNewDate(""); }}
                      className="text-xs text-muted-foreground hover:text-foreground"
                    >
                      Cancel
                    </button>
                  </div>
                )}

                {/* Actioned-by line */}
                {activity.follow_up_actioned_at && activity.follow_up_actor && (
                  <div className="flex items-center gap-1 text-muted-foreground pl-0.5">
                    <UserCheck className="h-3 w-3 shrink-0" />
                    <span>
                      {activity.is_follow_up_done ? "Closed" : "Rescheduled"} by{" "}
                      <span className="font-medium">
                        {activity.follow_up_actor.full_name}
                      </span>{" "}
                      on {formatDate(activity.follow_up_actioned_at)}
                    </span>
                  </div>
                )}
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

      {/* Log Activity dialog — opened when rep acts on a pending follow-up */}
      <ActivityForm
        leadId={leadId}
        open={logActivityOpen}
        onOpenChange={setLogActivityOpen}
        onSuccess={handleLogAndClose}
      />
    </div>
  );
}

interface ActivityTimelineProps {
  leadId: string;
  onRefresh?: () => void;
  /** Activity ID to scroll to and highlight on mount */
  highlightId?: string;
}

export function ActivityTimeline({ leadId, highlightId }: ActivityTimelineProps) {
  const { data: activities, loading, error, refetch } = useActivities(leadId);

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
        <ActivityItem
          key={activity.id}
          activity={activity}
          leadId={leadId}
          onActionComplete={refetch}
          highlightId={highlightId}
        />
      ))}
    </div>
  );
}
