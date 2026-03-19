"use client";

import Link from "next/link";
import { Phone, Users, FileText, Mail, MapPin, Activity } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ACTIVITY_TYPE_LABELS } from "@/lib/constants";
import { formatDate } from "@/lib/utils";
import type { DashboardStats } from "@/types";

const ACTIVITY_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  call: Phone,
  meeting: Users,
  note: FileText,
  email: Mail,
  tour: MapPin,
};

interface RecentActivitiesWidgetProps {
  stats: DashboardStats;
}

export function RecentActivitiesWidget({ stats }: RecentActivitiesWidgetProps) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-base">Recent Activities</CardTitle>
        <Link href="/activities" className="text-xs text-primary hover:underline">
          View all
        </Link>
      </CardHeader>
      <CardContent>
        {stats.recent_activities.length === 0 ? (
          <p className="text-sm text-muted-foreground">No activities yet</p>
        ) : (
          <div className="space-y-3">
            {stats.recent_activities.slice(0, 5).map((activity) => {
              const Icon = ACTIVITY_ICONS[activity.type] || Activity;
              return (
                <div key={activity.id} className="flex items-start gap-3">
                  <div className="rounded-full bg-muted p-1.5">
                    <Icon className="h-3 w-3" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <Badge variant="outline" className="text-xs shrink-0">
                        {ACTIVITY_TYPE_LABELS[activity.type]}
                      </Badge>
                      {activity.lead && (
                        <Link
                          href={`/leads/${activity.lead_id}`}
                          className="text-sm font-medium hover:underline underline-offset-2 truncate"
                        >
                          {activity.lead.first_name} {activity.lead.last_name}
                        </Link>
                      )}
                      {activity.subject && (
                        <span className="text-xs text-muted-foreground truncate">
                          — {activity.subject}
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {formatDate(activity.created_at)}
                      {activity.creator ? ` by ${activity.creator.full_name}` : ""}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
