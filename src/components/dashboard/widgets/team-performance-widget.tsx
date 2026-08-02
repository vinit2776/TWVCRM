"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { Users, Activity, CheckSquare, Loader2, Inbox } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { USER_ROLE_LABELS } from "@/lib/constants";

interface TeamMember {
  user_id: string;
  full_name: string;
  role: string;
  activities_this_week: number;
  tasks_completed_this_week: number;
}

interface TeamPerformanceWidgetProps {
  locationFilter: string | null;
}

export function TeamPerformanceWidget({ locationFilter }: TeamPerformanceWidgetProps) {
  const [data, setData] = useState<TeamMember[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (locationFilter) params.set("location_id", locationFilter);
      const res = await fetch(`/api/dashboard/team?${params}`);
      const json = await res.json();
      setData(json.data ?? []);
    } catch {
      setData([]);
    } finally {
      setLoading(false);
    }
  }, [locationFilter]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Users className="h-4 w-4 text-muted-foreground" />
          Team Activity This Week
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        {loading ? (
          <div className="flex items-center justify-center py-6">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : data.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-6 text-center">
            <Inbox className="h-8 w-8 mb-2 text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">No team data</p>
          </div>
        ) : (
          <div className="space-y-1">
            {/* Header row */}
            <div className="grid grid-cols-[1fr_auto_auto] gap-2 px-1 pb-1 border-b">
              <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">
                Member
              </span>
              <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide flex items-center gap-1 justify-end">
                <Activity className="h-3 w-3" /> Activities
              </span>
              <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide flex items-center gap-1 justify-end">
                <CheckSquare className="h-3 w-3" /> Tasks
              </span>
            </div>
            <div className="max-h-72 overflow-y-auto -mx-1 px-1">
            {data.map((member) => (
              <Link
                key={member.user_id}
                href={`/team/${member.user_id}/activity`}
                className="grid grid-cols-[1fr_auto_auto] gap-2 items-center rounded-md px-1 py-2 hover:bg-muted/40 transition-colors"
                title="View full activity storyboard"
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium truncate">{member.full_name}</p>
                  <p className="text-[11px] text-muted-foreground truncate">
                    {USER_ROLE_LABELS[member.role] ?? member.role}
                  </p>
                </div>
                <span className="text-sm font-semibold text-blue-600 text-right min-w-[2rem]">
                  {member.activities_this_week}
                </span>
                <span className="text-sm font-semibold text-green-600 text-right min-w-[2rem]">
                  {member.tasks_completed_this_week}
                </span>
              </Link>
            ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
