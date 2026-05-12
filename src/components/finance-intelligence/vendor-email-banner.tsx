"use client";

import { useState, useEffect, useCallback } from "react";
import { Loader2, Mail, AlertCircle, AlertTriangle } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

interface VendorEmailBannerProps {
  vendorId: string;
  vendorName?: string;
  /** When true, the banner mounts immediately without checking nag status (used when caller already knows the vendor has no email). */
  forceShow?: boolean;
  /** Called after the email is successfully saved — caller can refresh data. */
  onEmailSaved?: (newEmail: string) => void;
  /** Optional className for outer wrapper. */
  className?: string;
}

interface NagStatus {
  should_show: boolean;
  level: "normal" | "escalated";
  dismissals_in_window: number;
  snoozed_until: string | null;
  escalate_after: number;
  escalate_window_days: number;
  has_email: boolean;
}

/**
 * The persistent "this vendor has no email" reminder.
 *
 * Behaviour:
 *   - On mount, calls /api/finance-intelligence/vendor-email-nag/status to
 *     decide whether to render. Hidden if the vendor has an email, the
 *     feature is disabled, or the user has snoozed within the window.
 *   - "Skip this time" calls the dismiss endpoint (4-hour snooze).
 *   - Inline input + "Save" calls PATCH /procurement/vendors/[id]/email.
 *   - When dismissals in last 7 days >= 3, banner escalates to red with
 *     stronger copy.
 *   - When email is saved, banner hides itself and fires onEmailSaved.
 */
export function VendorEmailBanner({
  vendorId,
  vendorName,
  forceShow,
  onEmailSaved,
  className,
}: VendorEmailBannerProps) {
  const [status, setStatus] = useState<NagStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [email, setEmail] = useState("");
  const [saving, setSaving] = useState(false);
  const [dismissing, setDismissing] = useState(false);
  const [hidden, setHidden] = useState(false);

  // Don't fetch status if forceShow is on (caller already knows there's no email)
  useEffect(() => {
    if (forceShow) {
      setStatus({
        should_show: true,
        level: "normal",
        dismissals_in_window: 0,
        snoozed_until: null,
        escalate_after: 3,
        escalate_window_days: 7,
        has_email: false,
      });
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    fetch(`/api/finance-intelligence/vendor-email-nag/status?vendor_id=${vendorId}`)
      .then((r) => r.json())
      .then((j) => { if (!cancelled) setStatus(j); })
      .catch(() => { if (!cancelled) setStatus(null); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [vendorId, forceShow]);

  const handleSave = useCallback(async () => {
    const trimmed = email.trim();
    if (!trimmed || !trimmed.includes("@")) {
      toast.error("Enter a valid email address");
      return;
    }
    if (!vendorId) {
      toast.error("Vendor ID is missing — cannot save email");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(`/api/procurement/vendors/${vendorId}/email`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contact_email: trimmed }),
      });
      const json = await res.json();
      if (!res.ok) {
        const msg = typeof json?.error === "string" ? json.error : "Failed to save email";
        toast.error(msg);
        return;
      }
      toast.success("Vendor email saved");
      setHidden(true);
      onEmailSaved?.(trimmed);
    } finally {
      setSaving(false);
    }
  }, [email, vendorId, onEmailSaved]);

  const handleDismiss = useCallback(async () => {
    setDismissing(true);
    try {
      await fetch("/api/finance-intelligence/vendor-email-nag/dismiss", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ vendor_id: vendorId }),
      });
      setHidden(true);
    } finally {
      setDismissing(false);
    }
  }, [vendorId]);

  if (loading) return null;
  if (hidden) return null;
  if (!status || status.has_email) return null;
  if (!status.should_show) return null;

  const escalated = status.level === "escalated";
  const cls = escalated
    ? "border-red-300 bg-red-50"
    : "border-amber-300 bg-amber-50";
  const headerCls = escalated ? "text-red-900" : "text-amber-900";
  const Icon = escalated ? AlertCircle : AlertTriangle;
  const iconCls = escalated ? "text-red-600" : "text-amber-600";

  return (
    <div className={`rounded-lg border p-3 space-y-2 ${cls} ${className ?? ""}`}>
      <div className="flex items-start gap-2">
        <Icon className={`h-4 w-4 ${iconCls} shrink-0 mt-0.5`} />
        <div className="min-w-0 flex-1">
          <p className={`text-sm font-semibold ${headerCls}`}>
            {escalated ? "Vendor email is still missing" : "Vendor has no email address"}
          </p>
          <p className={`text-xs mt-0.5 ${escalated ? "text-red-800" : "text-amber-800"}`}>
            Payment confirmation cannot be sent to {vendorName ?? "this vendor"} until an email is added.
            {escalated && (
              <>
                {" "}
                <strong>
                  This reminder has been dismissed {status.dismissals_in_window} time
                  {status.dismissals_in_window === 1 ? "" : "s"} in the last {status.escalate_window_days} days.
                </strong>
              </>
            )}
          </p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[200px]">
          <Mail className={`absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 ${iconCls}`} />
          <Input
            type="email"
            placeholder="vendor@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="pl-8 h-8 text-sm"
            disabled={saving}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !saving) handleSave();
            }}
          />
        </div>
        <Button
          size="sm"
          onClick={handleSave}
          disabled={saving || dismissing || !email.trim()}
          className={escalated ? "bg-red-600 hover:bg-red-700 text-white" : ""}
        >
          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : null}
          Save email
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={handleDismiss}
          disabled={saving || dismissing}
          className="text-xs"
        >
          Skip this time
        </Button>
      </div>
    </div>
  );
}
