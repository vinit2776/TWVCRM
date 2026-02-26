"use client";

import { BellRing, X } from "lucide-react";
import { usePushNotifications } from "@/hooks/use-push-notifications";

/**
 * Subtle one-time prompt encouraging users to enable browser push notifications.
 * Only shows when:
 *   - Browser supports Web Push
 *   - NEXT_PUBLIC_VAPID_PUBLIC_KEY is configured
 *   - Permission hasn't been granted yet
 *   - User hasn't dismissed it before
 *
 * Disappears permanently once the user either enables or dismisses.
 */
export function PushNotificationPrompt() {
  const { canPrompt, loading, subscribe, dismiss } = usePushNotifications();

  if (!canPrompt) return null;

  return (
    <div className="flex items-center gap-3 px-4 py-2 bg-muted/60 border-b text-sm">
      <BellRing className="h-4 w-4 text-primary shrink-0" />
      <span className="flex-1 text-muted-foreground">
        Enable browser notifications to get alerted even when this tab is minimised.
      </span>
      <button
        onClick={subscribe}
        disabled={loading}
        className="shrink-0 rounded-md bg-primary text-primary-foreground px-3 py-1 text-xs font-semibold hover:bg-primary/90 transition-colors disabled:opacity-50"
      >
        {loading ? "Enabling…" : "Enable"}
      </button>
      <button
        onClick={dismiss}
        className="shrink-0 text-muted-foreground hover:text-foreground transition-colors"
        aria-label="Dismiss"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
