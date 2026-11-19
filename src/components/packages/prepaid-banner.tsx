"use client";

import { PackageTip } from "@/components/packages/package-tips";
import { Ticket, AlertTriangle, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatCurrency } from "@/lib/utils";
import { istDateString } from "@/lib/prepaid";
import type { PrepaidPurchase } from "@/types";

interface PrepaidBannerProps {
  purchase: PrepaidPurchase;
  usePrepaid: boolean;
  onToggle: (use: boolean) => void;
  /** Booking duration in hours — used to compute coverage */
  durationHours?: number;
  /** Effective hourly rate — used to compute topup amount */
  effectiveRate?: number;
}

export function PrepaidBanner({
  purchase,
  usePrepaid,
  onToggle,
  durationHours = 0,
  effectiveRate = 0,
}: PrepaidBannerProps) {
  const creditsRemaining = purchase.credits_remaining ?? 0;
  const creditType = purchase.credit_type;
  const lowBalance = creditsRemaining / Number(purchase.total_credits) < 0.2;

  // Compute coverage
  let coveredHours = 0;
  let topupAmount = 0;
  let topupHours = 0;
  if (creditType === "hours" && durationHours > 0) {
    coveredHours = Math.min(durationHours, creditsRemaining);
    topupHours = Math.max(0, durationHours - coveredHours);
    // The package covers its hours including GST; the extra hours are billed at the list rate plus GST
    topupAmount = topupHours * effectiveRate * 1.18;
  }
  const isFullyCovered = creditType === "days" || creditType === "bookings" || (creditType === "hours" && topupAmount === 0);

  const expiryDate = new Date(purchase.expires_at + "T00:00:00").toLocaleDateString("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "numeric",
    month: "short",
    year: "numeric",
  });
  const daysLeft = Math.round(
    (new Date(purchase.expires_at + "T00:00:00Z").getTime() - new Date(istDateString() + "T00:00:00Z").getTime()) / 86_400_000,
  );
  const locationNames = (purchase.locations ?? []).map((l) => l.location?.name).filter(Boolean) as string[];
  const windowHours = purchase.cancellation_window_hours;

  const packageName = (purchase.package as { name?: string } | undefined)?.name || "Prepaid Package";
  const creditsLabel =
    creditType === "hours"
      ? `${creditsRemaining} hr${creditsRemaining !== 1 ? "s" : ""} remaining`
      : creditType === "bookings"
      ? `${creditsRemaining} booking slot${creditsRemaining !== 1 ? "s" : ""} remaining`
      : `${creditsRemaining} day pass${creditsRemaining !== 1 ? "es" : ""} remaining`;

  return (
    <div className="space-y-2">
    <div
      className={`rounded-lg border p-3 flex flex-col sm:flex-row sm:items-center gap-3 ${
        usePrepaid
          ? lowBalance
            ? "bg-amber-50 border-amber-200"
            : "bg-green-50 border-green-200"
          : "bg-muted/40 border-border"
      }`}
    >
      <div className="flex items-start gap-2 flex-1 min-w-0">
        {lowBalance ? (
          <AlertTriangle className="h-4 w-4 text-amber-500 mt-0.5 shrink-0" />
        ) : (
          <Ticket className="h-4 w-4 text-green-600 mt-0.5 shrink-0" />
        )}
        <div className="min-w-0">
          <p className={`text-sm font-semibold ${usePrepaid ? (lowBalance ? "text-amber-800" : "text-green-800") : "text-foreground"}`}>
            {packageName}
          </p>
          <p className={`text-xs ${usePrepaid ? (lowBalance ? "text-amber-700" : "text-green-700") : "text-muted-foreground"}`}>
            {creditsLabel} · Expires {expiryDate} ({daysLeft === 0 ? "today" : `${daysLeft} day${daysLeft !== 1 ? "s" : ""} left`})
          </p>
          {locationNames.length > 0 && (
            <p className="text-xs text-muted-foreground">Valid at {locationNames.join(", ")}</p>
          )}
          <p className="text-xs text-muted-foreground">
            {windowHours == null
              ? "Credits are not restored if the booking is cancelled"
              : `Credits restored if cancelled at least ${windowHours} hr${Number(windowHours) !== 1 ? "s" : ""} before start`}
          </p>
          {usePrepaid && durationHours > 0 && creditType === "hours" && (
            <p className={`text-xs mt-0.5 ${isFullyCovered ? "text-green-700" : "text-amber-700"}`}>
              {isFullyCovered
                ? `Fully covered by package (${coveredHours}hr deducted)`
                : `${coveredHours}hr covered · Top-up: ${formatCurrency(topupAmount)} (${topupHours}hr)`}
            </p>
          )}
          {usePrepaid && creditType === "days" && (
            <p className="text-xs mt-0.5 text-green-700">1 day pass will be deducted · Fully covered</p>
          )}
          {usePrepaid && creditType === "bookings" && (
            <p className="text-xs mt-0.5 text-green-700">1 booking slot will be deducted · Fully covered</p>
          )}
        </div>
      </div>

      <div className="flex items-center gap-2 shrink-0">
        {usePrepaid ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="text-xs h-7"
            onClick={() => onToggle(false)}
          >
            <X className="h-3 w-3 mr-1" />
            Skip — charge normally
          </Button>
        ) : (
          <Button
            type="button"
            size="sm"
            className="text-xs h-7"
            onClick={() => onToggle(true)}
          >
            <Ticket className="h-3 w-3 mr-1" />
            Apply package
          </Button>
        )}
      </div>
    </div>
      <PackageTip>The hours are taken from the package. GST on them was paid when the package was sold, so there is nothing to collect for covered hours.</PackageTip>
    </div>
  );
}
