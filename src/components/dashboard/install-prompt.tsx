"use client";

import { Download, Share, X } from "lucide-react";
import { useInstallPrompt } from "@/hooks/use-install-prompt";

/**
 * One-time banner encouraging users to install the PWA.
 * On iOS shows manual "Add to Home Screen" instructions since
 * beforeinstallprompt is not supported and push notifications
 * require the app to be installed as a PWA.
 */
export function InstallPrompt() {
  const { canPrompt, isIos, install, dismiss } = useInstallPrompt();

  if (!canPrompt) return null;

  return (
    <div className="flex items-center gap-3 px-4 py-2 bg-primary/5 border-b text-sm">
      {isIos ? (
        <>
          <Share className="h-4 w-4 text-primary shrink-0" />
          <span className="flex-1 text-muted-foreground">
            To receive notifications, tap{" "}
            <Share className="inline h-3.5 w-3.5 -mt-0.5" /> then{" "}
            <strong>&quot;Add to Home Screen&quot;</strong>.
          </span>
        </>
      ) : (
        <>
          <Download className="h-4 w-4 text-primary shrink-0" />
          <span className="flex-1 text-muted-foreground">
            Install TWV CRM for quick access, offline support and push notifications.
          </span>
          <button
            onClick={install}
            className="shrink-0 rounded-md bg-primary text-primary-foreground px-3 py-1 text-xs font-semibold hover:bg-primary/90 transition-colors"
          >
            Install
          </button>
        </>
      )}
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
