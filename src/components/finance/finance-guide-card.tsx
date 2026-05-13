"use client";

import { useState, useEffect } from "react";
import { X, HelpCircle, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";

export type GuideStep = {
  number: number;
  title: string;
  description: string;
};

type Props = {
  guideKey: string;          // unique key stored in localStorage
  title: string;
  subtitle: string;
  steps: GuideStep[];
  tip?: string;              // optional "Pro tip" shown at the bottom
  accentColor?: "blue" | "purple" | "green" | "orange";
};

const ACCENT: Record<string, { bg: string; border: string; badge: string; dot: string; tip: string }> = {
  blue:   { bg: "bg-blue-50",   border: "border-blue-200",  badge: "bg-blue-100 text-blue-800",   dot: "bg-blue-500",   tip: "bg-blue-100 text-blue-800" },
  purple: { bg: "bg-purple-50", border: "border-purple-200",badge: "bg-purple-100 text-purple-800",dot: "bg-purple-500", tip: "bg-purple-100 text-purple-800" },
  green:  { bg: "bg-green-50",  border: "border-green-200", badge: "bg-green-100 text-green-800",  dot: "bg-green-500",  tip: "bg-green-100 text-green-800" },
  orange: { bg: "bg-orange-50", border: "border-orange-200",badge: "bg-orange-100 text-orange-800",dot: "bg-orange-500", tip: "bg-orange-100 text-orange-800" },
};

const STORAGE_KEY_PREFIX = "twv_guide_dismissed_";

export function FinanceGuideCard({
  guideKey, title, subtitle, steps, tip, accentColor = "blue",
}: Props) {
  const storageKey = STORAGE_KEY_PREFIX + guideKey;
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const dismissed = localStorage.getItem(storageKey);
    setVisible(dismissed !== "1");
  }, [storageKey]);

  function dismiss() {
    localStorage.setItem(storageKey, "1");
    setVisible(false);
  }

  const colors = ACCENT[accentColor];

  if (!visible) return null;

  return (
    <div className={`rounded-xl border ${colors.bg} ${colors.border} p-4 relative`}>
      {/* Close */}
      <button
        onClick={dismiss}
        className="absolute top-3 right-3 p-1 rounded hover:bg-black/5 text-muted-foreground hover:text-foreground transition-colors"
        aria-label="Dismiss guide"
      >
        <X className="h-4 w-4" />
      </button>

      {/* Header */}
      <div className="flex items-start gap-3 pr-8">
        <div className={`p-2 rounded-lg ${colors.badge} shrink-0`}>
          <HelpCircle className="h-4 w-4" />
        </div>
        <div>
          <p className="font-semibold text-sm">{title}</p>
          <p className="text-xs text-muted-foreground mt-0.5">{subtitle}</p>
        </div>
      </div>

      {/* Steps */}
      <div className="mt-4 grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {steps.map((step) => (
          <div key={step.number} className="flex gap-2.5 items-start">
            <div className={`w-5 h-5 rounded-full ${colors.badge} text-[10px] font-bold flex items-center justify-center shrink-0 mt-0.5`}>
              {step.number}
            </div>
            <div>
              <p className="text-xs font-semibold">{step.title}</p>
              <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">{step.description}</p>
            </div>
          </div>
        ))}
      </div>

      {/* Pro tip */}
      {tip && (
        <div className={`mt-4 rounded-lg ${colors.tip} px-3 py-2 text-xs flex items-start gap-2`}>
          <ChevronRight className="h-3.5 w-3.5 shrink-0 mt-0.5" />
          <span><strong>Pro tip:</strong> {tip}</span>
        </div>
      )}

      {/* Footer */}
      <div className="mt-3 flex items-center justify-end">
        <button
          onClick={dismiss}
          className="text-xs text-muted-foreground hover:text-foreground transition-colors hover:underline"
        >
          Got it, hide this guide
        </button>
      </div>
    </div>
  );
}

/**
 * Small "?" chip for page headers — re-opens the guide after it's dismissed.
 */
export function GuideReopenButton({ guideKey, label = "Guide" }: { guideKey: string; label?: string }) {
  const storageKey = STORAGE_KEY_PREFIX + guideKey;
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    setDismissed(localStorage.getItem(storageKey) === "1");
  }, [storageKey]);

  function reopen() {
    localStorage.removeItem(storageKey);
    setDismissed(false);
    // Scroll to top so the guide is visible
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  if (!dismissed) return null;

  return (
    <Button
      variant="outline"
      size="sm"
      onClick={reopen}
      className="h-7 gap-1.5 text-xs text-muted-foreground"
    >
      <HelpCircle className="h-3.5 w-3.5" />
      {label}
    </Button>
  );
}
