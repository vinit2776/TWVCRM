"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { Check, CalendarClock, CalendarCheck, Phone, Users, FileText, Mail, MapPin, RefreshCw } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ACTIVITY_TYPE_LABELS } from "@/lib/constants";

interface FollowUpItem {
  id: string;
  follow_up_date: string;
  follow_up_notes?: string;
  type: string;
  subject?: string;
  lead_id: string;
  lead?: { id: string; first_name: string; last_name: string } | null;
}

const ACTIVITY_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  call: Phone,
  meeting: Users,
  note: FileText,
  email: Mail,
  tour: MapPin,
};

function followUpLabel(dateStr: string): { text: string; cls: string } {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const due = new Date(dateStr);
  due.setHours(0, 0, 0, 0);
  const days = Math.round((due.getTime() - today.getTime()) / 86_400_000);

  if (days < 0)
    return {
      text: `${Math.abs(days)}d overdue`,
      cls: "text-red-600 bg-red-50 border border-red-200",
    };
  if (days === 0)
    return { text: "Today", cls: "text-amber-600 bg-amber-50 border border-amber-200" };
  if (days === 1)
    return { text: "Tomorrow", cls: "text-slate-600 bg-slate-100 border border-slate-200" };
  return { text: `In ${days}d`, cls: "text-slate-500 bg-slate-50 border border-slate-200" };
}

interface FollowupsWidgetProps {
  locationFilter: string | null;
}

export function FollowupsWidget({ locationFilter }: FollowupsWidgetProps) {
  const [items, setItems] = useState<FollowUpItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [reschedulingId, setReschedulingId] = useState<string | null>(null);
  const [newDate, setNewDate] = useState<string>("");
  const [acting, setActing] = useState<string | null>(null);

  const fetchFollowUps = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (locationFilter) params.set("location_id", locationFilter);
      const res = await fetch(`/api/followups?${params}`);
      if (res.ok) {
        const json = await res.json();
        setItems(json.data ?? []);
      }
    } finally {
      setLoading(false);
    }
  }, [locationFilter]);

  useEffect(() => {
    fetchFollowUps();
  }, [fetchFollowUps]);

  const handleClose = async (id: string) => {
    setActing(id);
    // Optimistic remove
    setItems((prev) => prev.filter((i) => i.id !== id));
    try {
      await fetch(`/api/activities/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "close" }),
      });
    } catch {
      // On error, silently refetch to restore state
      fetchFollowUps();
    } finally {
      setActing(null);
    }
  };

  const handleReschedule = async (id: string) => {
    if (!newDate) return;
    setActing(id);
    try {
      const res = await fetch(`/api/activities/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "reschedule", follow_up_date: newDate }),
      });
      if (res.ok) {
        setItems((prev) =>
          prev.map((i) => (i.id === id ? { ...i, follow_up_date: newDate } : i))
        );
        setReschedulingId(null);
        setNewDate("");
      }
    } finally {
      setActing(null);
    }
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-3">
        <div className="flex items-center gap-2">
          <CardTitle className="text-base">Follow-ups</CardTitle>
          {items.length > 0 && (
            <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-orange-500 px-1 text-[10px] font-bold text-white">
              {items.length}
            </span>
          )}
        </div>
        <button
          onClick={fetchFollowUps}
          className="text-muted-foreground hover:text-foreground transition-colors"
          title="Refresh"
        >
          <RefreshCw className="h-3.5 w-3.5" />
        </button>
      </CardHeader>

      <CardContent className="pt-0">
        {loading ? (
          <div className="space-y-3">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-12 rounded-md bg-muted animate-pulse" />
            ))}
          </div>
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-6 text-center">
            <CalendarCheck className="h-8 w-8 mb-2 text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">All caught up — no pending follow-ups</p>
          </div>
        ) : (
          <div className="space-y-2">
            {items.map((item) => {
              const { text: dateText, cls: dateCls } = followUpLabel(item.follow_up_date);
              const Icon = ACTIVITY_ICONS[item.type] || FileText;
              const isRescheduling = reschedulingId === item.id;

              return (
                <div
                  key={item.id}
                  className="rounded-md border bg-card p-2.5 text-sm transition-colors hover:bg-muted/30"
                >
                  {/* Main row */}
                  <div className="flex items-start gap-2">
                    {/* Activity type icon */}
                    <div className="rounded-full bg-muted p-1 shrink-0 mt-0.5">
                      <Icon className="h-3 w-3 text-muted-foreground" />
                    </div>

                    {/* Lead + notes */}
                    <div className="flex-1 min-w-0">
                      {item.lead ? (
                        <Link
                          href={`/leads/${item.lead_id}?tab=activities&highlight=${item.id}`}
                          className="font-medium hover:underline underline-offset-2 truncate block"
                        >
                          {item.lead.first_name} {item.lead.last_name}
                        </Link>
                      ) : (
                        <span className="font-medium text-muted-foreground truncate block">
                          Unknown lead
                        </span>
                      )}
                      <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
                        <Badge variant="outline" className="text-[10px] py-0 px-1 h-4">
                          {ACTIVITY_TYPE_LABELS[item.type] ?? item.type}
                        </Badge>
                        {item.follow_up_notes && (
                          <span className="text-xs text-muted-foreground truncate max-w-[140px]">
                            {item.follow_up_notes}
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Date badge + actions */}
                    <div className="flex items-center gap-1 shrink-0 ml-auto">
                      <span className={`text-[10px] font-medium rounded-full px-2 py-0.5 ${dateCls}`}>
                        {dateText}
                      </span>

                      {/* Close (Done) */}
                      <button
                        onClick={() => handleClose(item.id)}
                        disabled={acting === item.id}
                        className="rounded-full p-1 text-green-600 hover:bg-green-50 transition-colors disabled:opacity-40"
                        title="Mark as done"
                      >
                        <Check className="h-3.5 w-3.5" />
                      </button>

                      {/* Reschedule */}
                      <button
                        onClick={() => {
                          if (isRescheduling) {
                            setReschedulingId(null);
                            setNewDate("");
                          } else {
                            // Pre-fill with current date (YYYY-MM-DD)
                            setNewDate(item.follow_up_date.split("T")[0]);
                            setReschedulingId(item.id);
                          }
                        }}
                        disabled={acting === item.id}
                        className="rounded-full p-1 text-slate-500 hover:bg-slate-100 transition-colors disabled:opacity-40"
                        title="Reschedule"
                      >
                        <CalendarClock className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>

                  {/* Reschedule inline date picker */}
                  {isRescheduling && (
                    <div className="mt-2 flex items-center gap-2 pl-7">
                      <input
                        type="date"
                        value={newDate}
                        onChange={(e) => setNewDate(e.target.value)}
                        className="text-xs border rounded px-2 py-1 bg-background focus:outline-none focus:ring-1 focus:ring-primary"
                        min={new Date().toISOString().split("T")[0]}
                      />
                      <button
                        onClick={() => handleReschedule(item.id)}
                        disabled={!newDate || acting === item.id}
                        className="text-xs font-medium text-primary hover:underline disabled:opacity-40"
                      >
                        Confirm
                      </button>
                      <button
                        onClick={() => { setReschedulingId(null); setNewDate(""); }}
                        className="text-xs text-muted-foreground hover:text-foreground"
                      >
                        Cancel
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
