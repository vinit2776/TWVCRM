"use client";

/**
 * LeadCautionsBanner — surfaces active cautions on a lead.
 *
 * Two render modes:
 *   - mode="profile": full list with dismiss buttons. Used on the
 *     lead profile page. No acknowledgement gate — staff is just
 *     viewing the lead, not committing to anything.
 *   - mode="booking-gate": compact banner used on the new-booking
 *     flow. Danger-severity cautions require explicit "I've seen
 *     this — proceed" acknowledgement before staff can submit.
 *
 * Severity colours, ordering (danger > warning > info), and the
 * danger gate are policy decisions locked with the product owner —
 * see migration 00133 + the cancellation-flow spec.
 */

import { useEffect, useState } from "react";
import { ShieldAlert, X, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { LEAD_CAUTION_SEVERITY_COLORS, LEAD_CAUTION_SEVERITY_LABELS } from "@/lib/constants";
import { formatRelativeDate } from "@/lib/utils";
import { toast } from "sonner";
import type { LeadCaution } from "@/types";

interface Props {
  leadId: string;
  mode: "profile" | "booking-gate";
  /** booking-gate mode only: notifies parent whether staff has acknowledged
      all danger-severity cautions. Parent uses this to enable / disable
      the booking-submit button. */
  onAcknowledgementChange?: (allDangerAcknowledged: boolean) => void;
  /** profile mode only: re-fetched after dismiss to update the list */
  refreshKey?: number;
}

export function LeadCautionsBanner({
  leadId, mode, onAcknowledgementChange, refreshKey,
}: Props) {
  const [cautions, setCautions] = useState<LeadCaution[]>([]);
  const [loading, setLoading] = useState(true);
  const [acknowledged, setAcknowledged] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!leadId) return;
    setLoading(true);
    fetch(`/api/lead-cautions?lead_id=${leadId}`)
      .then((r) => r.json())
      .then((j) => setCautions(j.data || []))
      .catch(() => setCautions([]))
      .finally(() => setLoading(false));
  }, [leadId, refreshKey]);

  // Notify parent whenever the acknowledgement state changes (only in
  // booking-gate mode). All danger cautions must be in the acknowledged
  // set; non-danger don't require acknowledgement.
  useEffect(() => {
    if (mode !== "booking-gate" || !onAcknowledgementChange) return;
    const dangers = cautions.filter((c) => c.severity === "danger");
    const allAcked = dangers.every((c) => acknowledged.has(c.id));
    onAcknowledgementChange(allAcked);
  }, [cautions, acknowledged, mode, onAcknowledgementChange]);

  if (loading || cautions.length === 0) return null;

  const dismiss = async (cautionId: string) => {
    if (!confirm("Dismiss this caution? It'll stop showing on the lead profile and new-booking banners.")) return;
    const res = await fetch(`/api/lead-cautions/${cautionId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ is_active: false }),
    });
    if (res.ok) {
      toast.success("Caution dismissed");
      setCautions((prev) => prev.filter((c) => c.id !== cautionId));
    } else {
      const err = await res.json().catch(() => null);
      toast.error(err?.error || "Failed to dismiss");
    }
  };

  const ack = (cautionId: string) =>
    setAcknowledged((prev) => new Set(prev).add(cautionId));

  // ── Booking-gate compact mode ────────────────────────────────────
  if (mode === "booking-gate") {
    const hasDanger      = cautions.some((c) => c.severity === "danger");
    const hasWarning     = cautions.some((c) => c.severity === "warning");
    const hasUnackedDanger = cautions.some((c) => c.severity === "danger" && !acknowledged.has(c.id));

    // Escalate banner colour: danger → red, warning-only → amber, info-only → blue
    const bannerBorder = hasDanger ? "border-red-500"   : hasWarning ? "border-amber-400"  : "border-blue-400";
    const bannerBg     = hasDanger ? "bg-red-50"        : hasWarning ? "bg-amber-50"        : "bg-blue-50";
    const headingColor = hasDanger ? "text-red-900"     : hasWarning ? "text-amber-900"     : "text-blue-900";
    const iconColor    = hasDanger ? "text-red-600"     : hasWarning ? "text-amber-600"     : "text-blue-600";
    const moreColor    = hasDanger ? "text-red-800"     : "text-amber-800";

    const visible = cautions.slice(0, 3);
    return (
      <div className={`rounded-md border-l-4 ${bannerBorder} ${bannerBg} p-4 space-y-3 shadow-sm`}>
        <div className={`flex items-center gap-2 font-semibold text-sm ${headingColor}`}>
          <ShieldAlert className={`h-5 w-5 ${iconColor}`} />
          <span>
            {hasDanger ? "⚠ Customer Warning" : "Customer Notice"}
            {" "}— {cautions.length} caution{cautions.length > 1 ? "s" : ""} on record
          </span>
        </div>
        <div className="space-y-2">
          {visible.map((c) => {
            const isDanger = c.severity === "danger";
            const isAcked  = acknowledged.has(c.id);
            return (
              <div
                key={c.id}
                className={`rounded border px-3 py-2 text-xs ${LEAD_CAUTION_SEVERITY_COLORS[c.severity]}${isDanger && !isAcked ? " ring-1 ring-red-400" : ""}`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <span className="text-[10px] uppercase font-bold mr-1.5 tracking-wide">
                      {LEAD_CAUTION_SEVERITY_LABELS[c.severity]}
                    </span>
                    {c.note}
                  </div>
                  {isDanger && !isAcked && (
                    <button
                      type="button"
                      onClick={() => ack(c.id)}
                      className="shrink-0 text-[10px] font-bold uppercase rounded border border-current px-2.5 py-1 hover:bg-white/60 whitespace-nowrap"
                    >
                      I&apos;ve seen this ✓
                    </button>
                  )}
                  {isDanger && isAcked && (
                    <span className="shrink-0 text-[10px] uppercase font-semibold flex items-center gap-0.5 opacity-70">
                      <Check className="h-3 w-3" /> Acknowledged
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
        {cautions.length > 3 && (
          <p className={`text-[11px] ${moreColor}`}>
            + {cautions.length - 3} more — see lead profile for the full history.
          </p>
        )}
        {hasUnackedDanger && (
          <p className="text-xs font-semibold text-red-700 bg-red-100 rounded px-3 py-2">
            You must acknowledge all danger warnings before this booking can be submitted.
          </p>
        )}
      </div>
    );
  }

  // ── Profile mode (full list, dismissable) ────────────────────────
  return (
    <div className="rounded-md border bg-card p-4 space-y-2">
      <div className="flex items-center gap-1.5 text-sm font-semibold">
        <ShieldAlert className="h-4 w-4 text-amber-700" />
        Active cautions ({cautions.length})
      </div>
      <div className="space-y-1.5">
        {cautions.map((c) => (
          <div
            key={c.id}
            className={`rounded border px-3 py-2 text-sm ${LEAD_CAUTION_SEVERITY_COLORS[c.severity]}`}
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5 mb-0.5">
                  <span className="text-[10px] uppercase font-semibold opacity-70">
                    {LEAD_CAUTION_SEVERITY_LABELS[c.severity]}
                  </span>
                  <span className="text-[10px] opacity-60">
                    {formatRelativeDate(c.created_at)}
                    {c.creator?.full_name && ` · by ${c.creator.full_name}`}
                  </span>
                </div>
                <div>{c.note}</div>
                {c.booking?.booking_number && (
                  <div className="text-[10px] mt-1 opacity-70 font-mono">
                    From {c.booking.booking_number}
                  </div>
                )}
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 w-7 p-0 shrink-0"
                onClick={() => dismiss(c.id)}
                title="Dismiss caution"
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
