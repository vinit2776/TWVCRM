"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import {
  Phone,
  Users,
  FileText,
  Mail,
  MapPin,
  ChevronLeft,
  ChevronRight,
  Search,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { EmptyState } from "@/components/shared/empty-state";
import { TableSkeleton } from "@/components/shared/loading-skeleton";
import {
  ACTIVITY_TYPES,
  ACTIVITY_TYPE_LABELS,
  CALL_OUTCOME_LABELS,
} from "@/lib/constants";
import { formatDate, formatDuration } from "@/lib/utils";
import type { Activity } from "@/types";

const ACTIVITY_ICONS: Record<
  string,
  React.ComponentType<{ className?: string }>
> = {
  call: Phone,
  meeting: Users,
  note: FileText,
  email: Mail,
  tour: MapPin,
};

type DatePreset = "today" | "week" | "month" | "all";

const DATE_PRESET_LABELS: Record<DatePreset, string> = {
  today: "Today",
  week: "This Week",
  month: "This Month",
  all: "All Time",
};

function getDateRange(preset: DatePreset): { from: string | null; to: string | null } {
  const now = new Date();
  if (preset === "today") {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    const end = new Date(now);
    end.setHours(23, 59, 59, 999);
    return { from: start.toISOString(), to: end.toISOString() };
  }
  if (preset === "week") {
    const start = new Date(now);
    // Monday of current week
    start.setDate(now.getDate() - ((now.getDay() + 6) % 7));
    start.setHours(0, 0, 0, 0);
    return { from: start.toISOString(), to: null };
  }
  if (preset === "month") {
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    return { from: start.toISOString(), to: null };
  }
  return { from: null, to: null };
}

export default function ActivitiesPage() {
  const [activities, setActivities] = useState<(Activity & { lead?: { id: string; first_name: string; last_name: string; company?: string } })[]>([]);
  const [pagination, setPagination] = useState({
    page: 1,
    limit: 25,
    total: 0,
    totalPages: 0,
  });
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);

  // Filters — date preset is primary, default: This Month
  const [datePreset, setDatePreset] = useState<DatePreset>("month");
  const [typeFilter, setTypeFilter] = useState("");
  const [search, setSearch] = useState("");

  const fetchActivities = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams();
    params.set("page", String(page));
    if (typeFilter) params.set("type", typeFilter);
    if (search.trim()) params.set("search", search.trim());
    const { from, to } = getDateRange(datePreset);
    if (from) params.set("date_from", from);
    if (to) params.set("date_to", to);

    const res = await fetch(`/api/activities?${params.toString()}`);
    if (res.ok) {
      const json = await res.json();
      setActivities(json.data || []);
      setPagination(json.pagination);
    }
    setLoading(false);
  }, [page, typeFilter, search, datePreset]);

  useEffect(() => {
    fetchActivities();
  }, [fetchActivities]);

  // Reset to page 1 when filters change
  useEffect(() => {
    setPage(1);
  }, [typeFilter, datePreset, search]);

  return (
    <div className="space-y-4">
      {/* Header + Filters */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold">Activities</h1>
            <p className="text-sm text-muted-foreground">
              {pagination.total} {pagination.total === 1 ? "activity" : "activities"}
            </p>
          </div>
        </div>

        {/* Filter bar */}
        <div className="flex flex-wrap gap-2 items-center">
          {/* Date preset pills */}
          {(["today", "week", "month", "all"] as DatePreset[]).map((preset) => (
            <Button
              key={preset}
              variant={datePreset === preset ? "default" : "outline"}
              size="sm"
              onClick={() => setDatePreset(preset)}
            >
              {DATE_PRESET_LABELS[preset]}
            </Button>
          ))}

          {/* Vertical divider */}
          <div className="h-6 w-px bg-border hidden sm:block mx-1" />

          {/* Type filter */}
          <Select
            value={typeFilter || "all"}
            onValueChange={(val) => setTypeFilter(val === "all" ? "" : val)}
          >
            <SelectTrigger className="w-[140px] h-8">
              <SelectValue placeholder="All Types" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Types</SelectItem>
              {ACTIVITY_TYPES.map((t) => (
                <SelectItem key={t} value={t}>
                  {ACTIVITY_TYPE_LABELS[t]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {/* Subject search */}
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
            <Input
              placeholder="Search subject…"
              className="pl-8 h-8 w-[200px]"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        </div>
      </div>

      {/* Table */}
      {loading ? (
        <TableSkeleton rows={8} />
      ) : activities.length === 0 ? (
        <EmptyState
          icon={FileText}
          title="No activities found"
          description={
            datePreset !== "all"
              ? `No activities for ${DATE_PRESET_LABELS[datePreset].toLowerCase()}. Try expanding the date range.`
              : "Log activities from lead detail pages."
          }
        />
      ) : (
        <div className="rounded-md border overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/50">
                <th className="px-4 py-3 text-left font-medium">Type</th>
                <th className="px-4 py-3 text-left font-medium">Subject</th>
                <th className="px-4 py-3 text-left font-medium hidden md:table-cell">
                  Lead
                </th>
                <th className="px-4 py-3 text-left font-medium hidden lg:table-cell">
                  Details
                </th>
                <th className="px-4 py-3 text-left font-medium hidden md:table-cell">
                  By
                </th>
                <th className="px-4 py-3 text-left font-medium">Date</th>
              </tr>
            </thead>
            <tbody>
              {activities.map((activity) => {
                const Icon = ACTIVITY_ICONS[activity.type] || FileText;
                return (
                  <tr
                    key={activity.id}
                    className="border-b hover:bg-muted/30 transition-colors"
                  >
                    <td className="px-4 py-3">
                      <Badge variant="outline" className="gap-1">
                        <Icon className="h-3 w-3" />
                        {ACTIVITY_TYPE_LABELS[activity.type]}
                      </Badge>
                    </td>
                    <td className="px-4 py-3">
                      {activity.subject || (
                        <span className="text-muted-foreground">-</span>
                      )}
                    </td>
                    <td className="px-4 py-3 hidden md:table-cell">
                      {activity.lead ? (
                        <Link
                          href={`/leads/${activity.lead.id}`}
                          className="text-primary hover:underline"
                        >
                          {activity.lead.first_name} {activity.lead.last_name}
                        </Link>
                      ) : (
                        "-"
                      )}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground hidden lg:table-cell">
                      {activity.type === "call" && activity.call_outcome && (
                        <span className="flex items-center gap-1">
                          <Phone className="h-3 w-3" />
                          {CALL_OUTCOME_LABELS[activity.call_outcome]}
                          {activity.call_duration_seconds
                            ? ` (${formatDuration(activity.call_duration_seconds)})`
                            : ""}
                        </span>
                      )}
                      {activity.type === "meeting" &&
                        activity.meeting_location && (
                          <span className="flex items-center gap-1">
                            <MapPin className="h-3 w-3" />
                            {activity.meeting_location}
                          </span>
                        )}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground hidden md:table-cell">
                      {activity.creator?.full_name || "-"}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {formatDate(activity.created_at)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Pagination */}
      {pagination.totalPages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">
            Page {pagination.page} of {pagination.totalPages}
          </p>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={page <= 1}
              onClick={() => setPage(page - 1)}
            >
              <ChevronLeft className="h-4 w-4" />
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={page >= pagination.totalPages}
              onClick={() => setPage(page + 1)}
            >
              Next
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
