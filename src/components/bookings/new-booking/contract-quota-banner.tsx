"use client";

/**
 * ContractQuotaBanner
 *
 * Shown in the new-booking form when the customer type is "contract_holder"
 * and a contract is selected. Fetches the contract's active facility quotas
 * and displays the current-month usage / available / balance so the staff can
 * see at a glance whether the booking will be free or chargeable.
 */

import { useEffect, useState } from "react";
import { Loader2, ShieldCheck, AlertTriangle, Info } from "lucide-react";
import { formatCurrency } from "@/lib/utils";

interface FacilityQuota {
  id: string;
  name: string;
  unit: string;
  free_quota: number;
  cost_per_unit: number;
  hours_used_this_month: number;
}

interface Props {
  contractId: string;
  /** Booking duration in hours — used to preview the post-booking balance. */
  durationHours: number;
  /** booking_date string ("YYYY-MM-DD") — determines which month to read usage from. */
  bookingDate: string;
}

export function ContractQuotaBanner({ contractId, durationHours, bookingDate }: Props) {
  const [facilities, setFacilities] = useState<FacilityQuota[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!contractId) { setFacilities([]); return; }
    setLoading(true);
    fetch(`/api/contracts/${contractId}/facilities`)
      .then((r) => r.json())
      .then((j) => setFacilities(j.data || []))
      .catch(() => setFacilities([]))
      .finally(() => setLoading(false));
  }, [contractId]);

  // Only show hour-based quotas (conference room type)
  const HOUR_UNITS = ["hr", "hrs", "hour", "hours", "h"];
  const hourFacilities = facilities.filter((f) => HOUR_UNITS.includes(f.unit.toLowerCase()));

  if (!contractId) return null;

  // Determine the month label from bookingDate
  const monthLabel = bookingDate
    ? new Date(bookingDate + "T12:00:00").toLocaleString("en-IN", { month: "long", year: "numeric" })
    : new Date().toLocaleString("en-IN", { month: "long", year: "numeric" });

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground px-3 py-2 border rounded-lg bg-muted/20">
        <Loader2 className="h-3 w-3 animate-spin" />
        Checking quota…
      </div>
    );
  }

  if (hourFacilities.length === 0) return null;

  return (
    <div className="space-y-2">
      {hourFacilities.map((f) => {
        const quota = Number(f.free_quota);
        const used = Number(f.hours_used_this_month ?? 0);
        const usedAfter = used + durationHours;
        const freeRemaining = Math.max(0, quota - used);
        const overageThisBooking = Math.max(0, durationHours - freeRemaining);
        const isFree = overageThisBooking === 0;
        const balanceAfter = Math.max(0, quota - usedAfter);
        const pctAfter = quota > 0 ? Math.min(100, (usedAfter / quota) * 100) : 0;
        const willExceed = usedAfter > quota;

        return (
          <div
            key={f.id}
            className={`rounded-lg border px-3 py-2.5 text-xs ${
              isFree
                ? "border-green-200 bg-green-50"
                : willExceed
                ? "border-amber-200 bg-amber-50"
                : "border-blue-200 bg-blue-50"
            }`}
          >
            <div className="flex items-start gap-2">
              <div className="mt-0.5 shrink-0">
                {isFree
                  ? <ShieldCheck className="h-3.5 w-3.5 text-green-600" />
                  : <AlertTriangle className="h-3.5 w-3.5 text-amber-600" />
                }
              </div>
              <div className="flex-1 min-w-0">
                <div className="font-medium text-foreground mb-1">
                  {f.name} quota — {monthLabel}
                </div>

                {/* Usage bar */}
                {quota > 0 && (
                  <div className="mb-1.5">
                    <div className="h-1.5 rounded-full bg-white/70 overflow-hidden w-full">
                      <div
                        className={`h-full rounded-full transition-all ${
                          willExceed ? "bg-amber-500" : pctAfter > 80 ? "bg-amber-400" : "bg-green-500"
                        }`}
                        style={{ width: `${Math.min(100, pctAfter)}%` }}
                      />
                    </div>
                  </div>
                )}

                {/* Stats row */}
                <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px]">
                  <span>
                    <span className="text-muted-foreground">Quota: </span>
                    <span className="font-medium">{quota} {f.unit}</span>
                  </span>
                  <span>
                    <span className="text-muted-foreground">Used so far: </span>
                    <span className="font-medium">{used} {f.unit}</span>
                  </span>
                  {durationHours > 0 && (
                    <span>
                      <span className="text-muted-foreground">This booking: </span>
                      <span className="font-medium">{durationHours} {f.unit}</span>
                    </span>
                  )}
                  <span>
                    <span className="text-muted-foreground">After booking: </span>
                    <span className={`font-medium ${willExceed ? "text-amber-700" : "text-green-700"}`}>
                      {willExceed
                        ? `${(usedAfter - quota).toFixed(1)} ${f.unit} over quota`
                        : `${balanceAfter.toFixed(balanceAfter % 1 === 0 ? 0 : 1)} ${f.unit} remaining`}
                    </span>
                  </span>
                </div>

                {/* Charge preview */}
                {durationHours > 0 && (
                  <div className={`mt-1 font-medium ${isFree ? "text-green-700" : "text-amber-700"}`}>
                    {isFree
                      ? `✓ Within quota — this booking is free`
                      : `${formatCurrency(overageThisBooking * f.cost_per_unit)} overage charge (${overageThisBooking} ${f.unit} × ${formatCurrency(f.cost_per_unit)}/${f.unit})`
                    }
                  </div>
                )}
              </div>
            </div>
          </div>
        );
      })}
      {hourFacilities.length === 0 && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground px-3 py-2 border rounded-lg">
          <Info className="h-3 w-3" />
          No hourly facility quota configured — standard room rate applies
        </div>
      )}
    </div>
  );
}
