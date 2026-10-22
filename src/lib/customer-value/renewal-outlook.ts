/**
 * Customer Value — the renewal outlook
 * (docs/plans/customer-value-phase6-portfolio.md, section 2.2).
 *
 * What is known, from our own records, about the next renewal: when the live
 * contract ends, how far a renewal has got, what they have done on escalation
 * before, and how their rent compares with what it costs to serve them. Where
 * something is not recorded the outlook says so; it never guesses. Pure.
 */

import { formatCurrency } from "@/lib/utils";
import type { EscalationOutcome } from "@/lib/customer-value/journey";

export type RenewalStage = "no_live_contract" | "not_started" | "draft" | "sent" | "accepted" | "ended";
export type OutlookTone = "good" | "watch" | "risk" | "plain";

export interface OutlookInput {
  /** The live contract (active or renewal in progress), or null. */
  current: { contractNumber: string; endDate: string; daysToEnd: number; renewalDraftStatus: string | null } | null;
  /** The standing escalation clause on the live contract, percent; null when not recorded. */
  standingEscalationPct: number | null;
  renewalCount: number;
  renewalsDeclined: number;
  /** One outcome per past renewal. */
  escalationOutcomes: EscalationOutcome[];
  /** Rent per seat on the live contract; null when not known. */
  rentPerSeat: number | null;
  /** Break-even rent per seat from the Costs tab; null when not worked out. */
  breakEvenRentPerSeat: number | null;
  /** Renewals this soon count as urgent. */
  urgentWithinDays: number;
}

export interface OutlookLine {
  text: string;
  tone: OutlookTone;
}

export interface RenewalOutlook {
  stage: RenewalStage;
  /** Contract ends within `urgentWithinDays` (or has ended) with no renewal signed. */
  urgent: boolean;
  headline: string;
  lines: OutlookLine[];
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function stageOf(input: OutlookInput): RenewalStage {
  const c = input.current;
  if (!c) return "no_live_contract";
  if (c.daysToEnd < 0) return "ended";
  switch (c.renewalDraftStatus) {
    case "draft": return "draft";
    case "sent":
    case "viewed": return "sent";
    case "accepted": return "accepted";
    default: return "not_started";
  }
}

function ymdLabel(ymd: string): string {
  return new Date(`${ymd}T00:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

export function buildRenewalOutlook(input: OutlookInput): RenewalOutlook {
  const stage = stageOf(input);
  const c = input.current;
  const lines: OutlookLine[] = [];

  if (!c) {
    return { stage, urgent: false, headline: "No live contract, so no renewal to plan.", lines };
  }

  const urgent = (stage === "not_started" || stage === "draft" || stage === "ended") && c.daysToEnd <= input.urgentWithinDays;
  const when = c.daysToEnd < 0 ? `ended ${plural(-c.daysToEnd, "day", "days")} ago` : c.daysToEnd === 0 ? "ends today" : `ends in ${plural(c.daysToEnd, "day", "days")}`;
  const headline = `${c.contractNumber} ${when} (${ymdLabel(c.endDate)}).`;

  const stageLine: Record<RenewalStage, OutlookLine | null> = {
    no_live_contract: null,
    not_started: { text: "No renewal has been started.", tone: urgent ? "risk" : "plain" },
    draft: { text: "A renewal draft exists but has not been sent.", tone: urgent ? "watch" : "plain" },
    sent: { text: "A renewal has been sent and is waiting for the customer.", tone: "plain" },
    accepted: { text: "The customer has accepted the renewal; it starts when this contract ends.", tone: "good" },
    ended: { text: "The contract has ended without a renewal being activated.", tone: "risk" },
  };
  if (stageLine[stage]) lines.push(stageLine[stage] as OutlookLine);

  lines.push({
    text: input.standingEscalationPct === null ? "Escalation ask: not recorded on this contract." : `Escalation ask: ${input.standingEscalationPct}% (the standing clause).`,
    tone: "plain",
  });

  const known = input.escalationOutcomes.filter((o) => o !== "unknown");
  if (input.renewalCount === 0 && input.renewalsDeclined === 0) {
    lines.push({ text: "First term: no earlier renewal to learn from.", tone: "plain" });
  } else {
    const count = (o: EscalationOutcome) => known.filter((x) => x === o).length;
    const parts = [
      count("accepted") > 0 ? `accepted ${plural(count("accepted"), "time", "times")}` : null,
      count("reduced") > 0 ? `reduced ${plural(count("reduced"), "time", "times")}` : null,
      count("avoided") > 0 ? `avoided ${plural(count("avoided"), "time", "times")}` : null,
    ].filter(Boolean);
    lines.push({
      text: `Renewed ${plural(input.renewalCount, "time", "times")}${input.renewalsDeclined > 0 ? ` and declined ${plural(input.renewalsDeclined, "renewal", "renewals")}` : ""}. Escalation ${parts.length > 0 ? parts.join(", ") : "outcome not recorded"}.`,
      tone: count("reduced") + count("avoided") > 0 || input.renewalsDeclined > 0 ? "watch" : "plain",
    });
  }

  if (input.rentPerSeat !== null && input.breakEvenRentPerSeat !== null) {
    const headroom = input.rentPerSeat - input.breakEvenRentPerSeat;
    lines.push(
      headroom >= 0
        ? { text: `Pays ${formatCurrency(input.rentPerSeat)} per seat against a break-even of ${formatCurrency(input.breakEvenRentPerSeat)}: ${formatCurrency(headroom)} of headroom (an estimate).`, tone: "good" }
        : { text: `Pays ${formatCurrency(input.rentPerSeat)} per seat, ${formatCurrency(-headroom)} below the break-even of ${formatCurrency(input.breakEvenRentPerSeat)}: renewing at this rent loses money (an estimate).`, tone: "risk" }
    );
  } else if (input.rentPerSeat !== null) {
    lines.push({ text: `Pays ${formatCurrency(input.rentPerSeat)} per seat. Break-even is not worked out yet.`, tone: "plain" });
  }

  return { stage, urgent, headline, lines };
}
