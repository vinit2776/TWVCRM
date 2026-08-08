"use client";

/**
 * OvertimeChargeBanner — persistent (reload-surviving) notice for a
 * pending contract-holder overtime usage_charge on this booking.
 *
 * Replaces the old 15-second toast + auto-opened CollectPaymentDialog,
 * which was wired to booking.total_amount_with_gst — always ₹0 for
 * contract holders, so it had nothing collectible behind it and the
 * overrun was simply lost once the toast disappeared.
 *
 * Visibility is derived by the parent from the booking's already-fetched
 * usage charges (charge_type "overtime", status "pending"), not from any
 * fetch of its own — so it's correct on first load and after a hard
 * reload, not just right after checkout.
 */

import { useState } from "react";
import dynamic from "next/dynamic";
import { AlertTriangle, ShieldCheck, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { formatCurrency } from "@/lib/utils";
import { toast } from "sonner";

const WaiverRequestDialog = dynamic(
  () => import("@/components/bookings/waiver-request-dialog").then((m) => m.WaiverRequestDialog),
  { ssr: false }
);

export interface OvertimeUsageCharge {
  id: string;
  description: string;
  total_with_gst: number;
}

interface OvertimeChargeBannerProps {
  bookingId: string;
  overtimeCharge: OvertimeUsageCharge | null;
  userRole: string | null;
  onWaived: () => void;
}

export function OvertimeChargeBanner({
  bookingId,
  overtimeCharge,
  userRole,
  onWaived,
}: OvertimeChargeBannerProps) {
  const [waiving, setWaiving] = useState(false);
  const [waiveReason, setWaiveReason] = useState("");
  const [showReasonField, setShowReasonField] = useState(false);
  const [requestDialogOpen, setRequestDialogOpen] = useState(false);

  if (!overtimeCharge) return null;

  const canWaiveDirectly = userRole === "admin" || userRole === "manager";
  // Same submit-eligible roles as the waiver-request POST endpoint.
  const canRequestWaiver = ["floor_manager", "manager", "admin"].includes(userRole || "");

  const submitWaive = async () => {
    if (!waiveReason.trim()) {
      toast.error("A reason is required to waive this charge");
      return;
    }
    setWaiving(true);
    try {
      const res = await fetch(`/api/usage-charges/${overtimeCharge.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "waived", waive_reason: waiveReason.trim() }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to waive charge");
      toast.success("Overtime charge waived");
      setShowReasonField(false);
      setWaiveReason("");
      onWaived();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to waive charge");
    } finally {
      setWaiving(false);
    }
  };

  return (
    <div className="rounded-md border-l-4 border-amber-300 bg-amber-50 px-3 py-2.5 text-amber-900">
      <div className="flex items-start gap-2">
        <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5 text-amber-600" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium">
            Overtime charge posted: {formatCurrency(overtimeCharge.total_with_gst)}
          </p>
          <p className="text-xs text-amber-700 mt-0.5">{overtimeCharge.description}</p>
          <p className="text-xs text-amber-700 mt-0.5">
            Added to the member&apos;s account for the next monthly bill.
          </p>

          {showReasonField ? (
            <div className="mt-2 space-y-1.5">
              <Textarea
                value={waiveReason}
                onChange={(e) => setWaiveReason(e.target.value)}
                placeholder="Reason for waiving this charge..."
                rows={2}
                className="bg-white text-sm"
              />
              <div className="flex gap-2">
                <Button size="sm" onClick={submitWaive} disabled={waiving}>
                  {waiving && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
                  Confirm Waive
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => { setShowReasonField(false); setWaiveReason(""); }}
                  disabled={waiving}
                >
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <div className="mt-2 flex gap-2">
              {canWaiveDirectly && (
                <Button
                  size="sm"
                  variant="outline"
                  className="border-amber-300 text-amber-700 hover:bg-amber-100"
                  onClick={() => setShowReasonField(true)}
                >
                  Waive
                </Button>
              )}
              {!canWaiveDirectly && canRequestWaiver && (
                <Button
                  size="sm"
                  variant="outline"
                  className="border-amber-300 text-amber-700 hover:bg-amber-100"
                  onClick={() => setRequestDialogOpen(true)}
                >
                  <ShieldCheck className="mr-1 h-3.5 w-3.5" />
                  Request Waiver
                </Button>
              )}
            </div>
          )}
        </div>
      </div>

      {requestDialogOpen && (
        <WaiverRequestDialog
          open={requestDialogOpen}
          onOpenChange={setRequestDialogOpen}
          bookingId={bookingId}
          usageChargeId={overtimeCharge.id}
          waiverType="overtime"
          waiverAmount={overtimeCharge.total_with_gst}
          onApproved={onWaived}
        />
      )}
    </div>
  );
}
