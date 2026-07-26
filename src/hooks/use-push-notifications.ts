"use client";

import { useState, useEffect, useCallback } from "react";

const LS_KEY = "twv_push_dismissed";

/** Convert a URL-safe base64 VAPID public key to a Uint8Array for the Push API.
 *  Safari requires Uint8Array specifically — ArrayBuffer throws
 *  "The string did not match the expected pattern." */
function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  // Strip any whitespace before measuring: the padding below is length-derived,
  // so a stray newline shifts it and yields a corrupt key.
  const clean = base64String.replace(/\s+/g, "");
  const padding = "=".repeat((4 - (clean.length % 4)) % 4);
  const base64 = (clean + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  const output = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    output[i] = rawData.charCodeAt(i);
  }
  return output as Uint8Array<ArrayBuffer>;
}

/**
 * Manages browser push notification permission and SW registration.
 *
 * Usage:
 *   const { canPrompt, subscribed, loading, subscribe, dismiss } = usePushNotifications();
 *
 * Env vars required:
 *   NEXT_PUBLIC_VAPID_PUBLIC_KEY=<your VAPID public key>
 *   (generate with: npx web-push generate-vapid-keys)
 */
export function usePushNotifications() {
  const [mounted, setMounted]       = useState(false);
  const [permission, setPermission] = useState<NotificationPermission>("default");
  const [subscribed, setSubscribed] = useState(false);
  const [loading, setLoading]       = useState(false);
  const [dismissed, setDismissed]   = useState(false);

  // .trim() — the key was stored in Vercel with a trailing newline. atob() strips
  // whitespace, so this decoded correctly in practice, but the newline still
  // skewed the length-based padding maths in urlBase64ToUint8Array(). Hardening,
  // not a live fix: subscribe() below swallows its errors, so anything that did
  // go wrong here would fail silently.
  const vapidPublicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY?.trim();
  // Evaluated only after mount so server and client agree on the initial render,
  // preventing the React 19 hydration mismatch that made the whole tree non-responsive.
  const isSupported =
    mounted &&
    "Notification" in window &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    !!vapidPublicKey;

  // Signal that we are now running in the browser — gates isSupported above
  useEffect(() => { setMounted(true); }, []);

  useEffect(() => {
    if (!isSupported) return;

    // Check permission + existing subscription
    setPermission(Notification.permission);
    setDismissed(localStorage.getItem(LS_KEY) === "1");

    navigator.serviceWorker.ready.then((reg) => {
      reg.pushManager.getSubscription().then((sub) => {
        setSubscribed(!!sub);
      });
    });

    // Register service worker proactively (so it's ready when needed)
    navigator.serviceWorker.register("/sw.js").catch(() => {
      /* SW may already be registered */
    });

    // Auto-subscribe if permission was previously granted
    if (Notification.permission === "granted") {
      navigator.serviceWorker.ready.then(async (reg) => {
        const existing = await reg.pushManager.getSubscription();
        if (existing) {
          setSubscribed(true);
          return;
        }
        // Re-subscribe (e.g. subscription expired)
        if (vapidPublicKey) {
          try {
            const sub = await reg.pushManager.subscribe({
              userVisibleOnly: true,
              applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
            });
            await fetch("/api/push/subscribe", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(sub.toJSON()),
            });
            setSubscribed(true);
          } catch {
            /* ignore */
          }
        }
      });
    }
  }, [isSupported, vapidPublicKey]);

  /** Ask permission → register SW → subscribe → save to server */
  const subscribe = useCallback(async () => {
    if (!isSupported || !vapidPublicKey) return;
    setLoading(true);
    try {
      const perm = await Notification.requestPermission();
      setPermission(perm);
      if (perm !== "granted") return;

      const reg = await navigator.serviceWorker.register("/sw.js");
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
      });

      await fetch("/api/push/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(sub.toJSON()),
      });

      setSubscribed(true);
    } catch (err) {
      console.error("[usePushNotifications] subscribe failed:", err);
    } finally {
      setLoading(false);
    }
  }, [isSupported, vapidPublicKey]);

  /** Dismiss the "Enable notifications" prompt permanently */
  const dismiss = useCallback(() => {
    localStorage.setItem(LS_KEY, "1");
    setDismissed(true);
  }, []);

  // Whether to show the "Enable notifications" prompt:
  //   • Browser supports it
  //   • VAPID key is configured
  //   • Permission not yet granted/denied
  //   • User hasn't dismissed the prompt
  const canPrompt =
    isSupported &&
    permission === "default" &&
    !subscribed &&
    !dismissed;

  return {
    isSupported,
    mounted,
    permission,
    subscribed,
    loading,
    canPrompt,
    subscribe,
    dismiss,
  };
}
