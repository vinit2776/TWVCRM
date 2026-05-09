"use client";

import { useCallback, useEffect, useState } from "react";

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

const DISMISSED_KEY = "twv_install_dismissed";

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
 * Captures the browser's `beforeinstallprompt` event and exposes
 * an imperative `install()` function + visibility state for a custom banner.
 * On iOS (where beforeinstallprompt never fires) shows a manual guide instead.
 */
export function useInstallPrompt() {
  const [deferredPrompt, setDeferredPrompt] =
    useState<BeforeInstallPromptEvent | null>(null);
  const [isInstalled, setIsInstalled] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [showIosGuide, setShowIosGuide] = useState(false);

  useEffect(() => {
    if (isStandalone()) {
      setIsInstalled(true);
      return;
    }

    if (localStorage.getItem(DISMISSED_KEY) === "true") {
      setDismissed(true);
      return;
    }

    // iOS never fires beforeinstallprompt — show manual guide
    if (isIos()) {
      setShowIosGuide(true);
      return;
    }

    const onBeforeInstall = (e: Event) => {
      e.preventDefault();
      setDeferredPrompt(e as BeforeInstallPromptEvent);
    };

    const onAppInstalled = () => {
      setIsInstalled(true);
      setDeferredPrompt(null);
    };

    window.addEventListener("beforeinstallprompt", onBeforeInstall);
    window.addEventListener("appinstalled", onAppInstalled);

    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstall);
      window.removeEventListener("appinstalled", onAppInstalled);
    };
  }, []);

  const install = useCallback(async () => {
    if (!deferredPrompt) return;
    await deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    if (outcome === "accepted") {
      setIsInstalled(true);
    }
    setDeferredPrompt(null);
  }, [deferredPrompt]);

  const dismiss = useCallback(() => {
    localStorage.setItem(DISMISSED_KEY, "true");
    setDismissed(true);
    setDeferredPrompt(null);
    setShowIosGuide(false);
  }, []);

  const canPrompt = (!isInstalled && !dismissed) && (!!deferredPrompt || showIosGuide);

  return { canPrompt, isInstalled, isIos: showIosGuide, install, dismiss };
}
