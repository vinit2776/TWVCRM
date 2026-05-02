"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Lightbulb, X } from "lucide-react";
import { useIdleGuide } from "@/hooks/use-idle-guide";

/**
 * FlowGuideHint — contextual idle-triggered hint card.
 *
 * Appears in the bottom-right corner when the user stalls on a page.
 * Shows which step they're on in the current flow and what to do next.
 * Persists until explicitly dismissed or the route changes.
 * Uses sessionStorage so each hint shows at most once per session.
 */
export function FlowGuideHint() {
  const { guide, dismiss } = useIdleGuide();

  // Drive the CSS enter/exit transition via a separate mounted state
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (guide) {
      // Tiny delay so the DOM node exists before we flip the class
      const raf = requestAnimationFrame(() => setVisible(true));
      return () => cancelAnimationFrame(raf);
    } else {
      setVisible(false);
    }
  }, [guide]);

  if (!guide) return null;

  const progressFraction = guide.step / guide.totalSteps;
  const stepsRemaining = guide.totalSteps - guide.step;

  return (
    <div
      role="status"
      aria-live="polite"
      className={[
        // Position — above mobile nav on small screens, bottom-right on desktop
        "fixed bottom-20 right-4 lg:bottom-6 lg:right-6 z-40",
        // Size
        "w-72",
        // Appearance
        "rounded-xl border border-amber-200 bg-amber-50 shadow-lg",
        // Transition
        "transition-all duration-300 ease-out",
        visible ? "translate-y-0 opacity-100" : "translate-y-4 opacity-0",
      ].join(" ")}
    >
      {/* ── Header row ──────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between px-3 pt-3 pb-1.5">
        <div className="flex items-center gap-1.5 min-w-0">
          <Lightbulb className="h-3.5 w-3.5 shrink-0 text-amber-500" />
          <span className="text-[11px] font-semibold uppercase tracking-wide text-amber-700 truncate">
            {guide.flowName}
          </span>
        </div>

        <div className="flex items-center gap-2 shrink-0 ml-2">
          {/* Step counter */}
          <span className="text-[10px] text-amber-600 tabular-nums">
            {guide.step}/{guide.totalSteps}
          </span>
          {/* Dismiss */}
          <button
            onClick={dismiss}
            aria-label="Dismiss hint"
            className="text-amber-400 hover:text-amber-600 transition-colors"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* ── Progress bar ────────────────────────────────────────────────── */}
      <div className="mx-3 mb-2 h-1 rounded-full bg-amber-200 overflow-hidden">
        <div
          className="h-full rounded-full bg-amber-500 transition-all duration-500"
          style={{ width: `${progressFraction * 100}%` }}
        />
      </div>

      {/* ── Hint text ───────────────────────────────────────────────────── */}
      <p className="px-3 pb-1 text-xs text-amber-800 leading-relaxed">
        {guide.hint}
      </p>

      {/* ── Distance to completion ──────────────────────────────────────── */}
      {stepsRemaining > 0 && (
        <p className="px-3 pb-2 text-[10px] text-amber-500">
          {stepsRemaining === 1
            ? "1 step to complete this flow"
            : `${stepsRemaining} steps to complete this flow`}
        </p>
      )}

      {/* ── CTA ─────────────────────────────────────────────────────────── */}
      {guide.ctaLabel && (
        <div className="px-3 pb-3">
          {guide.ctaHref ? (
            <Link
              href={guide.ctaHref}
              onClick={dismiss}
              className="inline-flex items-center gap-1 rounded-md bg-amber-500 px-2.5 py-1 text-xs font-medium text-white hover:bg-amber-600 transition-colors"
            >
              {guide.ctaLabel}
              <span aria-hidden>→</span>
            </Link>
          ) : (
            <span className="inline-flex items-center rounded-md bg-amber-100 px-2.5 py-1 text-xs font-medium text-amber-700">
              {guide.ctaLabel}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
