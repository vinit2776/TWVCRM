"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import {
  UserPlus,
  Loader2,
  Inbox,
  Phone,
  Users,
  FileText,
  Mail,
  MapPin,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusBadge, RatingBadge } from "@/components/shared/status-badge";

interface RecentLead {
  id: string;
  first_name: string;
  last_name: string;
  company: string | null;
  status: string;
  source: string;
  rating: string;
  created_at: string;
  assigned_user: { full_name: string } | null;
  last_activity: {
    type: string;
    creator_name: string;
    created_at: string;
  } | null;
}

const ACTIVITY_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  call: Phone,
  meeting: Users,
  note: FileText,
  email: Mail,
  tour: MapPin,
};

function timeAgo(iso: string): string {
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

interface RecentLeadsWidgetProps {
  locationFilter: string | null;
}

export function RecentLeadsWidget({ locationFilter }: RecentLeadsWidgetProps) {
  const [data, setData] = useState<RecentLead[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (locationFilter) params.set("location_id", locationFilter);
      const res = await fetch(`/api/dashboard/recent-leads?${params}`);
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
      <CardHeader className="flex flex-row items-center justify-between pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <UserPlus className="h-4 w-4 text-muted-foreground" />
          Recent Leads
        </CardTitle>
        <Link href="/leads" className="text-xs text-primary hover:underline">
          View all
        </Link>
      </CardHeader>
      <CardContent className="pt-0">
        {loading ? (
          <div className="flex items-center justify-center py-6">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : data.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-6 text-center">
            <Inbox className="h-8 w-8 mb-2 text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">No leads yet</p>
          </div>
        ) : (
          <div className="space-y-1">
            {data.map((lead) => {
              const ActivityIcon = lead.last_activity
                ? ACTIVITY_ICONS[lead.last_activity.type]
                : null;
              return (
                <div
                  key={lead.id}
                  className="flex items-start gap-3 rounded-md px-2 py-2 hover:bg-muted/40 transition-colors"
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <Link
                        href={`/leads/${lead.id}`}
                        className="text-sm font-medium hover:underline underline-offset-2 truncate"
                      >
                        {lead.first_name} {lead.last_name}
                      </Link>
                      <StatusBadge type="lead_status" value={lead.status} className="text-[10px] px-1.5 py-0" />
                      <RatingBadge rating={lead.rating} className="text-[10px] px-1.5 py-0" />
                    </div>
                    {lead.company && (
                      <p className="text-xs text-muted-foreground truncate">{lead.company}</p>
                    )}
                    <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground">
                      <span>{timeAgo(lead.created_at)}</span>
                      {lead.assigned_user && (
                        <span className="truncate">
                          → {lead.assigned_user.full_name}
                        </span>
                      )}
                      {lead.last_activity && (
                        <span className="flex items-center gap-1 truncate">
                          {ActivityIcon && <ActivityIcon className="h-3 w-3 shrink-0" />}
                          {lead.last_activity.creator_name}, {timeAgo(lead.last_activity.created_at)}
                        </span>
                      )}
                    </div>
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
