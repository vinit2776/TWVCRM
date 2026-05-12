"use client";

import { useEffect, useState } from "react";
import { BellRing, X, Smartphone, Share, Plus } from "lucide-react";
import { usePushNotifications } from "@/hooks/use-push-notifications";

const IOS_DISMISS_KEY = "twv_push_ios_dismissed";

function isIos(): boolean {
  if (typeof navigator === "undefined") return false;
  return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia("(display-mode: standalone)").matches ||
    ("standalone" in navigator && (navigator as unknown as { standalone: boolean }).standalone === true);
}

/**
 * Two-mode prompt encouraging users to enable Web Push notifications.
 *
 * • Android / desktop / installed PWA on iOS:
 *   Standard "Enable notifications" banner (thin header strip on desktop,
 *   floating bottom card on mobile so it's hard to miss).
 *
 * • iOS Safari, NOT installed to Home Screen:
 *   Web Push won't work until the user installs the PWA. Show a separate
 *   "Add to Home Screen first" guide with the iOS share icons instead of
 *   a useless "Enable" button.
 */
export function PushNotificationPrompt() {
  const { canPrompt, loading, subscribe, dismiss, isSupported, mounted } = usePushNotifications();

  const [iosNeedsInstall, setIosNeedsInstall] = useState(false);
  const [iosDismissed, setIosDismissed] = useState(true); // start dismissed to avoid hydration flash

  useEffect(() => {
    if (!mounted) return;
    if (isIos() && !isStandalone()) {
      setIosNeedsInstall(true);
      setIosDismissed(localStorage.getItem(IOS_DISMISS_KEY) === "1");
    }
  }, [mounted]);

  const dismissIos = () => {
    localStorage.setItem(IOS_DISMISS_KEY, "1");
    setIosDismissed(true);
  };

  // Case 1 — iOS Safari, not installed → guide to install first
  if (iosNeedsInstall && !iosDismissed) {
    return (
      <div className="fixed bottom-20 left-2 right-2 z-40 md:static md:bottom-auto md:left-auto md:right-auto md:z-auto">
        <div className="rounded-lg md:rounded-none border md:border-x-0 md:border-t-0 border-amber-300 bg-amber-50 px-4 py-3 text-sm flex items-start gap-3 shadow-lg md:shadow-none">
          <Smartphone className="h-5 w-5 text-amber-700 shrink-0 mt-0.5" />
          <div className="flex-1 text-amber-900">
            <div className="font-medium">Install TWV CRM to enable notifications</div>
            <div className="text-xs mt-0.5 flex items-center gap-1 flex-wrap">
              On iPhone: tap
              <Share className="inline h-3.5 w-3.5" aria-label="Share" />
              <span className="font-medium">Share</span>
              <span className="text-amber-700">→</span>
              <Plus className="inline h-3.5 w-3.5" aria-label="Add" />
              <span className="font-medium">Add to Home Screen</span>
            </div>
          </div>
          <button
            onClick={dismissIos}
            className="shrink-0 text-amber-700 hover:text-amber-900 transition-colors"
            aria-label="Dismiss"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>
    );
  }

  // Case 2 — standard enable prompt
  if (!canPrompt || !isSupported) return null;

  return (
    <>
      {/* Desktop / tablet: thin strip under the header */}
      <div className="hidden md:flex items-center gap-3 px-4 py-2 bg-muted/60 border-b text-sm">
        <BellRing className="h-4 w-4 text-primary shrink-0" />
        <span className="flex-1 text-muted-foreground">
          Enable notifications to get real-time alerts for tickets, bookings and enquiries.
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

      {/* Mobile: floating bottom card — harder to miss, sits above the tab bar */}
      <div className="md:hidden fixed bottom-20 left-2 right-2 z-40">
        <div className="rounded-lg border bg-card px-3 py-3 shadow-lg flex items-start gap-3">
          <BellRing className="h-5 w-5 text-primary shrink-0 mt-0.5" />
          <div className="flex-1 text-sm">
            <div className="font-medium">Get real-time alerts</div>
            <div className="text-xs text-muted-foreground">
              Tickets, bookings, enquiries — straight to your phone.
            </div>
          </div>
          <div className="flex flex-col gap-1.5 shrink-0">
            <button
              onClick={subscribe}
              disabled={loading}
              className="rounded-md bg-primary text-primary-foreground px-3 py-1.5 text-xs font-semibold hover:bg-primary/90 disabled:opacity-50"
            >
              {loading ? "…" : "Enable"}
            </button>
            <button
              onClick={dismiss}
              className="text-[10px] text-muted-foreground hover:text-foreground"
            >
              Not now
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
