"use client";

import { WifiOff } from "lucide-react";

export default function OfflinePage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="text-center space-y-4">
        <WifiOff className="mx-auto h-16 w-16 text-muted-foreground" />
        <h1 className="text-2xl font-semibold text-foreground">
          You&apos;re offline
        </h1>
        <p className="text-muted-foreground">
          Check your internet connection and try again.
        </p>
        <button
          onClick={() => window.location.reload()}
          className="rounded-md bg-primary px-6 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90 transition-colors"
        >
          Try Again
        </button>
      </div>
    </div>
  );
}
