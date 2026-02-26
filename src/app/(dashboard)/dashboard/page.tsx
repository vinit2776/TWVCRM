"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import {
  Users,
  CheckSquare,
  Activity,
  TrendingUp,
  Clock,
  AlertTriangle,
  Phone,
  FileText,
  Mail,
  MapPin,
  Bell,
  RefreshCw,
  Zap,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/shared/loading-skeleton";
import { LocationSelector } from "@/components/shared/location-selector";
import { ACTIVITY_TYPE_LABELS } from "@/lib/constants";
import { formatDate } from "@/lib/utils";
import { useEnquiryNotifications } from "@/providers/enquiry-notifications-provider";
import { FollowupsWidget } from "@/components/dashboard/followups-widget";
import type { DashboardStats } from "@/types";

const NOTES_LS_KEY = "twv_last_seen_notes";
// Default: show notes from the last 7 days on first visit
function getDefaultLastSeen() {
  const d = new Date();
  d.setDate(d.getDate() - 7);
  return d.toISOString();
}

const ACTIVITY_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  call: Phone, meeting: Users, note: FileText, email: Mail, tour: MapPin,
};

function timeAgo(iso: string): string {
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

export default function DashboardPage() {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [locationFilter, setLocationFilter] = useState<string | null>(null);
  const [lastSeenNotes, setLastSeenNotes] = useState<string>(() => {
    if (typeof window === "undefined") return getDefaultLastSeen();
    return localStorage.getItem(NOTES_LS_KEY) ?? getDefaultLastSeen();
  });

  // Live enquiry data from shared context (real-time, no extra fetch)
  const {
    newLeadCount,
    reEnquiryCount,
    recentItems,
    markReEnquiriesSeen,
  } = useEnquiryNotifications();

  const newLeadItems = recentItems.filter((i) => i.type === "lead");
  const reEnquiryItems = recentItems.filter((i) => i.type === "activity");
  const hasLiveEnquiries = newLeadCount > 0 || reEnquiryCount > 0;

  const fetchStats = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams();
    if (locationFilter) params.set("location_id", locationFilter);
    const res = await fetch(`/api/dashboard?${params}`);
    if (res.ok) {
      const json = await res.json();
      setStats(json.data);
    }
    setLoading(false);
  }, [locationFilter]);

  useEffect(() => {
    fetchStats();
  }, [fetchStats]);

  if (loading) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-bold">Dashboard</h1>
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Card key={i}><CardContent className="pt-6"><Skeleton className="h-20" /></CardContent></Card>
          ))}
        </div>
      </div>
    );
  }

  if (!stats) return null;

  const unreadNotes = stats.recent_notes.filter(
    (n) => n.created_at > lastSeenNotes
  );

  function markNotesSeen() {
    const now = new Date().toISOString();
    localStorage.setItem(NOTES_LS_KEY, now);
    setLastSeenNotes(now);
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <h1 className="text-2xl font-bold">Dashboard</h1>
        <LocationSelector
          value={locationFilter}
          onValueChange={setLocationFilter}
          includeAllOption
          placeholder="All Locations"
        />
      </div>

      {/* ── Live Enquiries Widget ── */}
      {hasLiveEnquiries && (
        <Card className="border-2 border-emerald-400 bg-emerald-50/50 dark:bg-emerald-950/20">
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                {/* Pulsing live indicator */}
                <span className="relative flex h-2.5 w-2.5">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                  <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-500" />
                </span>
                <CardTitle className="text-base text-emerald-800 dark:text-emerald-200">
                  Live Enquiries
                </CardTitle>
                <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-emerald-500 px-1.5 text-[10px] font-bold text-white">
                  {newLeadCount + reEnquiryCount}
                </span>
              </div>
              <Link
                href="/leads?status=new"
                className="text-xs font-medium text-emerald-700 hover:underline underline-offset-2"
              >
                All New Leads →
              </Link>
            </div>
          </CardHeader>
          <CardContent className="pt-0">
            <div className="space-y-3">
              {/* New enquiries section */}
              {newLeadItems.length > 0 && (
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-emerald-700 mb-1.5 flex items-center gap-1">
                    <Bell className="h-3 w-3" />
                    New Enquiries ({newLeadCount})
                  </p>
                  <div className="space-y-1">
                    {newLeadItems.slice(0, 4).map((item) => (
                      <Link
                        key={item.leadId}
                        href={`/leads/${item.leadId}`}
                        className="flex items-center justify-between rounded-md px-3 py-2 bg-white/80 hover:bg-white transition-colors border border-emerald-100 group"
                      >
                        <div className="min-w-0">
                          <p className="text-sm font-medium truncate group-hover:text-emerald-700 transition-colors">
                            {item.name}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {item.source} · {timeAgo(item.time)}
                          </p>
                        </div>
                        <span className="text-xs text-emerald-600 font-medium shrink-0 ml-2">→</span>
                      </Link>
                    ))}
                    {newLeadCount > 4 && (
                      <p className="text-xs text-emerald-700 text-center pt-1">
                        +{newLeadCount - 4} more
                      </p>
                    )}
                  </div>
                </div>
              )}

              {/* Re-enquiries section */}
              {reEnquiryItems.length > 0 && (
                <div className={newLeadItems.length > 0 ? "border-t border-emerald-200 pt-3" : ""}>
                  <div className="flex items-center justify-between mb-1.5">
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-amber-700 flex items-center gap-1">
                      <RefreshCw className="h-3 w-3" />
                      Re-Enquiries ({reEnquiryCount})
                    </p>
                    {reEnquiryCount > 0 && (
                      <button
                        onClick={markReEnquiriesSeen}
                        className="text-[10px] text-muted-foreground hover:text-foreground transition-colors hover:underline underline-offset-2"
                      >
                        Mark seen
                      </button>
                    )}
                  </div>
                  <div className="space-y-1">
                    {reEnquiryItems.slice(0, 4).map((item, idx) => (
                      <Link
                        key={item.leadId + "-" + idx}
                        href={`/leads/${item.leadId}`}
                        className="flex items-center justify-between rounded-md px-3 py-2 bg-amber-50/80 hover:bg-amber-50 transition-colors border border-amber-100 group"
                      >
                        <div className="min-w-0">
                          <p className="text-sm font-medium truncate group-hover:text-amber-700 transition-colors">
                            {item.name}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {item.source} · {timeAgo(item.time)}
                          </p>
                        </div>
                        <span className="text-xs text-amber-600 font-medium shrink-0 ml-2">→</span>
                      </Link>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Empty live enquiries placeholder (subtle) */}
      {!hasLiveEnquiries && (
        <div className="flex items-center gap-2 px-4 py-2.5 rounded-lg border border-dashed border-muted-foreground/20 text-muted-foreground/60">
          <Zap className="h-4 w-4" />
          <p className="text-xs">No pending new enquiries — you&apos;re all caught up!</p>
        </div>
      )}

      {/* Stat Cards */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Total Leads</CardTitle>
            <Users className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.conversion.total_leads}</div>
            <p className="text-xs text-muted-foreground">
              {stats.conversion.won} won, {stats.conversion.lost} lost
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Conversion Rate</CardTitle>
            <TrendingUp className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.conversion.rate}%</div>
            <p className="text-xs text-muted-foreground">leads won vs total</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Tasks Due Today</CardTitle>
            <CheckSquare className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.tasks_due_today}</div>
            {stats.tasks_overdue > 0 && (
              <p className="text-xs text-red-600 flex items-center gap-1">
                <AlertTriangle className="h-3 w-3" />
                {stats.tasks_overdue} overdue
              </p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Pending Follow-ups</CardTitle>
            <Clock className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.pending_follow_ups}</div>
            <p className="text-xs text-muted-foreground">scheduled follow-ups</p>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
        {/* Follow-ups */}
        <FollowupsWidget locationFilter={locationFilter} />

        {/* Recent Activities */}
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

        {/* Unread Notes */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <div className="flex items-center gap-2">
              <CardTitle className="text-base">Unread Notes</CardTitle>
              {unreadNotes.length > 0 && (
                <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-amber-500 px-1 text-[10px] font-bold text-white">
                  {unreadNotes.length}
                </span>
              )}
            </div>
            {unreadNotes.length > 0 && (
              <button
                onClick={markNotesSeen}
                className="text-xs text-muted-foreground hover:text-foreground transition-colors hover:underline underline-offset-2"
              >
                Mark all seen
              </button>
            )}
          </CardHeader>
          <CardContent>
            {unreadNotes.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-6 text-center">
                <FileText className="h-8 w-8 mb-2 text-muted-foreground/40" />
                <p className="text-sm text-muted-foreground">No unread notes</p>
              </div>
            ) : (
              <div className="space-y-3">
                {unreadNotes.slice(0, 5).map((note) => (
                  <Link
                    key={note.id}
                    href={`/leads/${note.lead_id}`}
                    className="flex items-start gap-3 rounded-md p-2 -mx-2 hover:bg-muted/50 transition-colors group"
                  >
                    <div className="rounded-full bg-amber-100 p-1.5 shrink-0 mt-0.5">
                      <FileText className="h-3 w-3 text-amber-600" />
                    </div>
                    <div className="flex-1 min-w-0">
                      {note.lead && (
                        <p className="text-sm font-medium truncate group-hover:underline underline-offset-2">
                          {note.lead.first_name} {note.lead.last_name}
                        </p>
                      )}
                      {note.subject && (
                        <p className="text-xs text-muted-foreground truncate">
                          {note.subject}
                        </p>
                      )}
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {formatDate(note.created_at)}
                      </p>
                    </div>
                  </Link>
                ))}
                {unreadNotes.length > 5 && (
                  <p className="text-xs text-muted-foreground text-center pt-1">
                    +{unreadNotes.length - 5} more
                  </p>
                )}
              </div>
            )}
            <div className="mt-3 pt-3 border-t">
              <Link
                href="/activities?type=note"
                className="text-xs text-primary hover:underline underline-offset-2"
              >
                View all notes →
              </Link>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
