"use client";

import { cn } from "@/lib/utils";

// Fixed pipeline order — mirrors nextStatusOptions()'s forward path. Resolved
// is the terminal stage (closed is retired, no longer reachable going
// forward — see facility.ts's ALLOWED_TRANSITIONS). "reopened" has no slot of
// its own (it loops back into acknowledged per canTransition), so it's
// rendered as a color override on the acknowledged dot rather than an extra
// stage. Pre-existing legacy "closed" tickets simply won't match any stage
// here and the stepper renders nothing — acceptable since closed is a dead
// end now, not something new tickets reach.
export const LIFECYCLE_STAGES: { key: string; label: string; dot: string }[] = [
  { key: "new", label: "New", dot: "bg-blue-500" },
  { key: "acknowledged", label: "Acknowledged", dot: "bg-indigo-500" },
  { key: "in_progress", label: "In progress", dot: "bg-purple-500" },
  { key: "resolved", label: "Resolved", dot: "bg-emerald-500" },
];

// `inline` renders a compact dots-only track (no text label, tighter
// connectors) meant to sit in the same line as other row content instead of
// on its own row — used in the activity feed and on ticket cards to save
// vertical space. The label is still available via the non-inline mode
// (used on the ticket detail page, where there's no row to save space on).
export function LifecycleStepper({ status, className, inline }: { status: string; className?: string; inline?: boolean }) {
  const isReopened = status === "reopened";
  const currentIndex = LIFECYCLE_STAGES.findIndex((s) => s.key === (isReopened ? "acknowledged" : status));
  if (currentIndex === -1) return null;

  return (
    <div className={cn("flex items-center shrink-0", !inline && "gap-2 mt-1.5", className)}>
      <div className="flex items-center">
        {LIFECYCLE_STAGES.map((stage, i) => (
          <div key={stage.key} className="flex items-center">
            {i > 0 && <div className={cn(inline ? "w-2.5" : "w-4", "h-[1.5px]", i <= currentIndex ? LIFECYCLE_STAGES[currentIndex].dot : "bg-border")} />}
            <div className={cn(
              "h-1.5 w-1.5 rounded-full",
              i > currentIndex ? "bg-border" : i === currentIndex && isReopened ? "bg-rose-500" : stage.dot,
            )} />
          </div>
        ))}
      </div>
      {!inline && (
        <span className="text-[9px] text-muted-foreground">
          {isReopened ? "Reopened" : LIFECYCLE_STAGES[currentIndex].label}
        </span>
      )}
    </div>
  );
}
