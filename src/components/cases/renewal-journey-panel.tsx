"use client";

import { useEffect, useState } from "react";
import { useGuidanceProgress } from "@/lib/guidance-progress-client";
import {
  FADE_AFTER_COMPLETIONS,
  guidanceDetail,
  progressKeyFor,
  shortHintFor,
  type GuidanceProgress,
} from "@/lib/vo-renewal-learning";
import Link from "next/link";
import { ArrowRight, Check, Clock, Lock, PartyPopper } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import {
  RENEWAL_OWNER_LABELS,
  nextStepFor,
  type RenewalAction,
  type RenewalJourney,
  type RenewalStep,
} from "@/lib/vo-renewal-journey";

function StepDot({ state }: { state: RenewalStep["state"] }) {
  const base = "flex h-5 w-5 shrink-0 items-center justify-center rounded-full";
  if (state === "done") {
    return (
      <span className={cn(base, "bg-green-100 text-green-700")}>
        <Check className="h-3 w-3" />
      </span>
    );
  }
  if (state === "current") {
    return (
      <span className={cn(base, "border-2 border-blue-600 bg-blue-50 text-blue-700")}>
        <ArrowRight className="h-3 w-3" />
      </span>
    );
  }
  if (state === "blocked") {
    return (
      <span className={cn(base, "bg-amber-100 text-amber-700")}>
        <Lock className="h-3 w-3" />
      </span>
    );
  }
  return <span className={cn(base, "border border-dashed border-muted-foreground/40")} />;
}

/** Where a step's button goes when it is a link rather than a click on this page. */
function actionHref(action: RenewalAction, step: RenewalStep): string | null {
  switch (action) {
    case "report_paid":
    case "verify_payment":
      return "/accounting/receivables";
    case "open_successor":
      return step.targetCaseId ? `/cases/${step.targetCaseId}` : null;
    default:
      return null;
  }
}

export interface RenewalJourneyHandlers {
  onStartRenewal?: () => void;
  onConfirmPartner?: () => void;
}

/**
 * The goal line, every step with its state and owner, and "Your next step".
 * The same journey the Renewals desk reads, so the two always agree. It points
 * at buttons that already exist; it never does anything on its own.
 */
export function RenewalJourneyView({
  journey,
  role,
  handlers,
  progress = {},
}: {
  journey: RenewalJourney;
  role: string | null;
  handlers: RenewalJourneyHandlers;
  /** This person's progress by step; with none, every explanation is the long one. */
  progress?: Record<string, GuidanceProgress>;
}) {
  const view = nextStepFor(journey, role);
  const step = view?.step;
  const [expanded, setExpanded] = useState(false);

  // The explanation fades with practice: one line once the person has done this
  // step a few times, the full text again if they have been blocked on it.
  const shortHint = step ? shortHintFor(step.key) : undefined;
  const stepProgress = step ? progress[progressKeyFor(step.key)] : undefined;
  const practised = !!shortHint && guidanceDetail(stepProgress) === "short";
  const showShort = practised && !expanded;
  const canCollapse = !!shortHint && (stepProgress?.times_completed ?? 0) >= FADE_AFTER_COMPLETIONS && expanded;

  const run = (action: RenewalAction) => {
    if (action === "start_renewal") handlers.onStartRenewal?.();
    else if (action === "confirm_partner") handlers.onConfirmPartner?.();
    else if (action === "decide_lapse" || action === "review_discontinuation") {
      document.getElementById("renewal-lapse-panel")?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  };

  const canClick = (a: RenewalAction) =>
    (a === "start_renewal" && !!handlers.onStartRenewal) ||
    (a === "confirm_partner" && !!handlers.onConfirmPartner) ||
    a === "decide_lapse" ||
    a === "review_discontinuation";

  return (
    <Card className="p-4 space-y-3" data-testid="renewal-journey">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm font-medium">{journey.goal}</p>
        {journey.daysLeft !== null && journey.stage !== "renewed" && (
          <span className="text-xs text-muted-foreground tabular-nums">
            {journey.daysLeft >= 0
              ? `${journey.daysLeft} day${journey.daysLeft === 1 ? "" : "s"} left`
              : `ended ${-journey.daysLeft} day${journey.daysLeft === -1 ? "" : "s"} ago`}
          </span>
        )}
      </div>

      <ol className="flex flex-wrap gap-x-4 gap-y-2" aria-label="Renewal steps">
        {journey.steps.map((s) => (
          <li
            key={s.key}
            className={cn(
              "flex items-center gap-2 text-sm",
              s.state === "done" || s.state === "current" ? "" : "text-muted-foreground",
            )}
          >
            <StepDot state={s.state} />
            <span className={s.state === "current" ? "font-medium" : ""}>{s.label}</span>
            <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
              {RENEWAL_OWNER_LABELS[s.owner]}
            </span>
            {s.detail && <span className="text-xs text-muted-foreground">{s.detail}</span>}
          </li>
        ))}
      </ol>

      {journey.complete ? (
        <div className="flex items-center gap-2 rounded-md bg-green-50 px-3 py-2 text-sm text-green-800 dark:bg-green-950/30 dark:text-green-200">
          <PartyPopper className="h-4 w-4" />
          Renewed. Nothing more to do on this term.
        </div>
      ) : (
        step &&
        view && (
          <div
            className={cn(
              "rounded-md border px-3 py-2",
              step.state === "blocked"
                ? "border-amber-300 bg-amber-50 dark:bg-amber-950/30"
                : view.mine
                  ? "border-blue-200 bg-blue-50/50 dark:bg-blue-950/20"
                  : "border-border bg-muted/40",
            )}
            data-testid="renewal-next-step"
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-xs text-muted-foreground flex items-center gap-1">
                  {view.mine ? (
                    "Your next step"
                  ) : (
                    <>
                      <Clock className="h-3 w-3" />
                      Waiting on {view.waitingOn?.toLowerCase()}
                    </>
                  )}
                </div>
                <div className="text-sm font-medium">
                  {step.label}
                  {step.detail && <span className="ml-2 text-xs font-normal text-muted-foreground">{step.detail}</span>}
                </div>
                {(showShort ? shortHint : step.hint) && (
                  <div className="text-xs text-muted-foreground">
                    {showShort ? shortHint : step.hint}
                    {showShort && (
                      <button type="button" onClick={() => setExpanded(true)} className="ml-2 text-blue-700 hover:underline">
                        Show more
                      </button>
                    )}
                    {canCollapse && (
                      <button type="button" onClick={() => setExpanded(false)} className="ml-2 text-blue-700 hover:underline">
                        Show less
                      </button>
                    )}
                  </div>
                )}
              </div>
              {step.action && view.mine && canClick(step.action) && (
                <Button size="sm" onClick={() => run(step.action!)}>
                  {step.actionLabel}
                </Button>
              )}
              {step.action && !canClick(step.action) && actionHref(step.action, step) && (
                <Button size="sm" variant="outline" asChild>
                  <Link href={actionHref(step.action, step)!}>{step.actionLabel}</Link>
                </Button>
              )}
            </div>
          </div>
        )
      )}
    </Card>
  );
}

/** Loads the case's journey and the viewer's role, then renders them. Renders nothing before the renewal window. */
export function RenewalJourneyPanel({ caseId, ...handlers }: { caseId: string } & RenewalJourneyHandlers) {
  const [journey, setJourney] = useState<RenewalJourney | null>(null);
  const [role, setRole] = useState<string | null>(null);
  const { progress } = useGuidanceProgress();

  useEffect(() => {
    let live = true;
    Promise.all([
      fetch(`/api/cases/${caseId}/renewal-journey`).then((r) => r.json()),
      fetch("/api/me").then((r) => r.json()),
    ])
      .then(([j, me]) => {
        if (!live) return;
        setJourney(j?.data?.journey ?? null);
        setRole(me?.role ?? null);
      })
      .catch(() => {
        // Guidance is an aid; if it can't load the rest of the tab still works.
      });
    return () => {
      live = false;
    };
  }, [caseId]);

  if (!journey) return null;
  return <RenewalJourneyView journey={journey} role={role} handlers={handlers} progress={progress} />;
}
