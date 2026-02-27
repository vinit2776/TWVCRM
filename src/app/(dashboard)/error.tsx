"use client";

import { useEffect } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Error boundary for all dashboard routes.
 * Renders within the dashboard layout (sidebar + header remain visible).
 * If the layout itself fails, the root src/app/error.tsx catches it.
 */
export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[Dashboard Error]", error);
  }, [error]);

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 py-16 px-4 text-center">
      <AlertTriangle className="h-10 w-10 text-destructive" />
      <div>
        <h2 className="text-xl font-semibold text-destructive mb-1">Something went wrong</h2>
        <p className="text-sm text-muted-foreground max-w-md">
          An unexpected error occurred on this page. Try refreshing, or contact support if the problem persists.
        </p>
        {error.message && (
          <p className="mt-2 text-xs font-mono text-muted-foreground/70 max-w-md break-all">
            {error.message}
          </p>
        )}
      </div>
      <Button onClick={reset} variant="outline" size="sm">
        <RefreshCw className="mr-2 h-4 w-4" />
        Try again
      </Button>
    </div>
  );
}
