"use client";

import { useEffect } from "react";

/**
 * Registers the service worker for offline caching and push notifications.
 * Safe to call alongside use-push-notifications (registering the same SW URL is a no-op).
 */
export function useServiceWorker() {
  useEffect(() => {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch((err) => {
        console.error("SW registration failed:", err);
      });
    }
  }, []);
}
