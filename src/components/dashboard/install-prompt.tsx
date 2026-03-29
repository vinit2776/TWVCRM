"use client";

import { Download, X } from "lucide-react";
import { useInstallPrompt } from "@/hooks/use-install-prompt";

/**
 * One-time banner encouraging users to install the PWA.
 * Follows the same pattern as PushNotificationPrompt.
 * Only shows when the browser fires `beforeinstallprompt` and the user hasn't dismissed.
 */
export function InstallPrompt() {
  const { canPrompt, install, dismiss } = useInstallPrompt();

  if (!canPrompt) return null;

  return (
    <div className="flex items-center gap-3 px-4 py-2 bg-primary/5 border-b text-sm">
      <Download className="h-4 w-4 text-primary shrink-0" />
      <span className="flex-1 text-muted-foreground">
        Install TWV CRM for quick access and offline support.
      </span>
      <button
        onClick={install}
        className="shrink-0 rounded-md bg-primary text-primary-foreground px-3 py-1 text-xs font-semibold hover:bg-primary/90 transition-colors"
      >
        Install
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
