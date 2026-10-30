import { dueInfo } from "./due";
import type { OpenJourney } from "./open-journeys";
import type { JourneyOwner } from "./types";

/** Only chase contracts activated recently; older ones are history, not onboarding. */
export const LATE_ALERT_WINDOW_DAYS = 14;

export interface LateAlert {
  owner: JourneyOwner;
  contractId: string;
  stepKey: string;
  title: string;
  body: string;
  url: string;
  /** The lead's assigned rep, used for sales-owned steps. */
  assignedTo: string | null;
}

/**
 * Open onboarding steps that are past their due date, on contracts activated
 * within the window. Pure so the rules can be unit-tested.
 */
export function selectLateAlerts(open: OpenJourney[], now: Date): LateAlert[] {
  const cutoff = now.getTime() - LATE_ALERT_WINDOW_DAYS * 86_400_000;
  const out: LateAlert[] = [];
  for (const o of open) {
    if (!o.contractId || !o.activatedAt || new Date(o.activatedAt).getTime() < cutoff) continue;
    for (const phase of o.journey.phases) {
      for (const s of phase.steps) {
        if (!s.due || s.state === "done" || s.state === "optional") continue;
        // A step still blocked on something else is not its owner's fault yet.
        if (s.state === "blocked") continue;
        const info = dueInfo(s.due, now);
        if (info.state !== "late") continue;
        out.push({
          owner: s.owner,
          contractId: o.contractId,
          stepKey: s.key,
          title: `Late: ${s.label} — ${o.ref}`,
          body: `${o.customer} · ${info.daysLate} day${info.daysLate === 1 ? "" : "s"} past due. Open the contract to do it.`,
          url: s.href ?? `/contracts/${o.contractId}`,
          assignedTo: o.assignedTo,
        });
      }
    }
  }
  return out;
}
