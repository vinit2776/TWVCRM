"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { Bell, Check, CheckCheck, Wrench, MessageCircle, UserCheck, ArrowRightLeft } from "lucide-react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { createClient } from "@/lib/supabase/client";

interface Notification {
  id: string;
  type: string;
  title: string;
  body: string;
  url: string | null;
  entity_type: string | null;
  entity_id: string | null;
  read_at: string | null;
  created_at: string;
}

function timeAgo(iso: string): string {
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function typeIcon(type: string) {
  switch (type) {
    case "facility_created":
      return <Wrench className="h-3.5 w-3.5 text-blue-500 shrink-0" />;
    case "facility_comment":
      return <MessageCircle className="h-3.5 w-3.5 text-green-600 shrink-0" />;
    case "facility_assigned":
      return <UserCheck className="h-3.5 w-3.5 text-purple-500 shrink-0" />;
    case "facility_status_changed":
      return <ArrowRightLeft className="h-3.5 w-3.5 text-amber-500 shrink-0" />;
    default:
      return <Bell className="h-3.5 w-3.5 text-muted-foreground shrink-0" />;
  }
}

function NotificationItem({
  notification,
  onClose,
  onMarkRead,
}: {
  notification: Notification;
  onClose: () => void;
  onMarkRead: (id: string) => void;
}) {
  const router = useRouter();
  const isUnread = !notification.read_at;

  function handleClick() {
    if (isUnread) onMarkRead(notification.id);
    onClose();
    if (notification.url) router.push(notification.url);
  }

  return (
    <button
      onClick={handleClick}
      className={`w-full flex items-start gap-2.5 px-3 py-2.5 text-left transition-colors rounded-md ${
        isUnread
          ? "bg-blue-50/60 hover:bg-blue-50 dark:bg-blue-950/20 dark:hover:bg-blue-950/30"
          : "hover:bg-muted"
      }`}
    >
      <div className="mt-0.5">{typeIcon(notification.type)}</div>
      <div className="min-w-0 flex-1">
        <p className={`text-sm leading-tight ${isUnread ? "font-semibold" : "font-medium text-muted-foreground"}`}>
          {notification.title}
        </p>
        <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">
          {notification.body}
        </p>
        <p className="text-[10px] text-muted-foreground/70 mt-1">
          {timeAgo(notification.created_at)}
        </p>
      </div>
      {isUnread && (
        <span className="mt-1.5 h-2 w-2 rounded-full bg-blue-500 shrink-0" />
      )}
    </button>
  );
}

export function InAppNotificationBell() {
  const [open, setOpen] = useState(false);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [userId, setUserId] = useState<string | null>(null);
  const fetched = useRef(false);

  const fetchNotifications = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/notifications?limit=30");
      if (res.ok) {
        const json = await res.json();
        setNotifications(json.data ?? []);
        setUnreadCount(json.unreadCount ?? 0);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  // Get user ID for realtime subscription
  useEffect(() => {
    const supabase = createClient();
    supabase.auth.getUser().then(async ({ data: { user } }) => {
      if (!user) return;
      const { data: dbUser } = await supabase
        .from("users")
        .select("id")
        .eq("auth_id", user.id)
        .single();
      if (dbUser) setUserId(dbUser.id);
    });
  }, []);

  // Initial fetch
  useEffect(() => {
    if (fetched.current) return;
    fetched.current = true;
    fetchNotifications();
  }, [fetchNotifications]);

  // Supabase Realtime: listen for new notifications for this user
  useEffect(() => {
    if (!userId) return;

    const supabase = createClient();
    const channel = supabase
      .channel("in-app-notifications")
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "notifications",
          filter: `user_id=eq.${userId}`,
        },
        (payload) => {
          const newNotif = payload.new as Notification;
          setNotifications((prev) => [newNotif, ...prev].slice(0, 50));
          setUnreadCount((prev) => prev + 1);
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [userId]);

  async function markRead(id: string) {
    // Optimistic update
    setNotifications((prev) =>
      prev.map((n) => (n.id === id ? { ...n, read_at: new Date().toISOString() } : n))
    );
    setUnreadCount((prev) => Math.max(0, prev - 1));

    await fetch("/api/notifications", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "read", id }),
    });
  }

  async function markAllRead() {
    // Optimistic update
    const now = new Date().toISOString();
    setNotifications((prev) => prev.map((n) => ({ ...n, read_at: n.read_at ?? now })));
    setUnreadCount(0);

    await fetch("/api/notifications", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "read_all" }),
    });
  }

  function handleOpen(val: boolean) {
    setOpen(val);
    if (val) fetchNotifications();
  }

  return (
    <DropdownMenu open={open} onOpenChange={handleOpen}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="relative" title="Notifications">
          <Bell className="h-4 w-4" />
          {unreadCount > 0 && (
            <span className="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-blue-600 px-0.5 text-[10px] font-bold text-white leading-none">
              {unreadCount > 99 ? "99+" : unreadCount}
            </span>
          )}
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="w-96 p-0" sideOffset={8}>
        {/* Header */}
        <div className="flex items-center justify-between px-3 py-2.5 border-b">
          <div className="flex items-center gap-2">
            <p className="text-sm font-semibold">Notifications</p>
            {unreadCount > 0 && (
              <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-blue-600 px-1.5 text-[10px] font-bold text-white">
                {unreadCount}
              </span>
            )}
          </div>
          {unreadCount > 0 && (
            <button
              onClick={markAllRead}
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
              title="Mark all as read"
            >
              <CheckCheck className="h-3.5 w-3.5" />
              Mark all read
            </button>
          )}
        </div>

        {/* Notification list */}
        <div className="max-h-[420px] overflow-y-auto">
          {loading && notifications.length === 0 ? (
            <div className="px-3 py-8 text-center">
              <div className="h-5 w-5 mx-auto mb-2 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />
              <p className="text-xs text-muted-foreground">Loading...</p>
            </div>
          ) : notifications.length === 0 ? (
            <div className="px-3 py-8 text-center">
              <Check className="h-8 w-8 mx-auto mb-2 text-muted-foreground/30" />
              <p className="text-sm text-muted-foreground">All caught up!</p>
              <p className="text-xs text-muted-foreground/60 mt-0.5">No notifications yet</p>
            </div>
          ) : (
            <div className="py-1 space-y-0.5">
              {notifications.map((n) => (
                <NotificationItem
                  key={n.id}
                  notification={n}
                  onClose={() => setOpen(false)}
                  onMarkRead={markRead}
                />
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        {notifications.length > 0 && (
          <div className="px-3 py-2 border-t text-center">
            <p className="text-xs text-muted-foreground/60">
              Showing {notifications.length} most recent
            </p>
          </div>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
