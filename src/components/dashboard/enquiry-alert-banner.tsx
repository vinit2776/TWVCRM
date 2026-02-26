"use client";

import { X, Bell, RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEnquiryNotifications } from "@/providers/enquiry-notifications-provider";

/**
 * Full-width dismissable alert banner that appears below the Header
 * when a new form enquiry or re-enquiry arrives in real-time.
 *
 * Shows the most recent alert; stacks count if multiple are queued.
 * Disappears when dismissed or navigated to the lead.
 */
export function EnquiryAlertBanner() {
  const { alertQueue, dismissAlert, dismissAllAlerts } = useEnquiryNotifications();
  const router = useRouter();

  if (alertQueue.length === 0) return null;

  const current = alertQueue[0];
  const isNew = current.type === "lead";
  const extras = alertQueue.length - 1;

  const bgClass = isNew
    ? "bg-emerald-600 hover:bg-emerald-700"
    : "bg-amber-500 hover:bg-amber-600";

  function handleViewLead() {
    dismissAlert(current.alertId);
    router.push(`/leads/${current.leadId}`);
  }

  return (
    <div
      className={`flex items-center gap-3 px-4 py-2.5 text-sm font-medium text-white
        ${isNew ? "bg-emerald-600" : "bg-amber-500"}
        animate-in slide-in-from-top-2 duration-300`}
    >
      {/* Icon */}
      {isNew ? (
        <Bell className="h-4 w-4 shrink-0" />
      ) : (
        <RefreshCw className="h-4 w-4 shrink-0" />
      )}

      {/* Message */}
      <span className="flex-1 truncate">
        {isNew ? "🔔 New enquiry" : "🔁 Re-enquiry"} —{" "}
        <strong>{current.name}</strong> via {current.source}
        {extras > 0 && (
          <span className="ml-2 text-white/75 text-xs font-normal">
            (+{extras} more)
          </span>
        )}
      </span>

      {/* View lead button */}
      <button
        onClick={handleViewLead}
        className={`shrink-0 rounded px-2.5 py-0.5 text-xs font-semibold border border-white/40
          bg-white/15 hover:bg-white/25 transition-colors whitespace-nowrap`}
      >
        View Lead →
      </button>

      {/* Dismiss all (when multiple) */}
      {extras > 0 && (
        <button
          onClick={dismissAllAlerts}
          className="shrink-0 text-white/70 hover:text-white text-xs transition-colors"
          title="Dismiss all"
        >
          Clear all
        </button>
      )}

      {/* Dismiss single */}
      <button
        onClick={() => dismissAlert(current.alertId)}
        className="shrink-0 ml-1 text-white/70 hover:text-white transition-colors"
        aria-label="Dismiss"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
