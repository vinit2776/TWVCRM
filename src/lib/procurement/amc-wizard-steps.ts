import { cyclesBetween } from "@/lib/procurement/amc-billing";

/**
 * The new-AMC request is asked one question at a time. These are the steps, in order,
 * with the plain-language reason for each (shown under the heading so a new user knows
 * why they are being asked).
 */
export const AMC_STEPS = [
  { key: "who", title: "Who is this for?", why: "The company decides which budget the contract counts against." },
  { key: "contract", title: "What is the contract?", why: "The name, dates and visits are what the vendor has promised. Check them against the vendor's proposal." },
  { key: "billing", title: "What is covered, and how is it paid?", why: "Each asset is paid on its own schedule. This decides how many invoices the vendor will send and for how much." },
  { key: "running", title: "Is the contract already running?", why: "Tick the cycles the vendor has already invoiced and you have already paid, so nobody is asked to approve or pay them again. Nothing is created for them." },
  { key: "contacts", title: "Who do you call?", why: "When something breaks, the team needs the vendor's number and who to escalate to." },
  { key: "proposal", title: "Attach the proposal", why: "Approvers decide faster with the vendor's proposal in front of them. You can skip this and add it later." },
  { key: "review", title: "Check and send", why: "Look over everything once. Nothing is sent until you press the button." },
] as const;

export type AmcStepKey = (typeof AMC_STEPS)[number]["key"];
export type AmcStep = (typeof AMC_STEPS)[number];

/** The steps this request needs: the "already running" step only appears for a contract that has begun. */
export function amcStepsFor(running: boolean): readonly AmcStep[] {
  return running ? AMC_STEPS : AMC_STEPS.filter((s) => s.key !== "running");
}

export interface AmcStepInput {
  companyId: string;
  serviceName: string;
  startDate: string;
  endDate: string;
  unlimitedVisits: boolean;
  visitsCovered: string;
  lines: Array<{ assetId: string; perCycleCost: string; cycleCountOverride: string }>;
  contactName: string;
  helpline: string;
  /** Only for a contract that has already begun. */
  running?: { scheduleProblem: string | null };
}

/** The first problem on a step, in plain words, or null when the step is complete. */
export function validateAmcStep(step: number, d: AmcStepInput, steps: readonly AmcStep[] = AMC_STEPS): string | null {
  switch (steps[step]?.key) {
    case "who":
      return d.companyId ? null : "Choose which company this request is for";
    case "contract": {
      if (!d.serviceName.trim()) return "Give the contract a name, for example \"HVAC AMC, 3rd floor\"";
      if (!d.startDate || !d.endDate) return "Enter when the contract starts and ends";
      if (new Date(d.endDate) <= new Date(d.startDate)) return "The end date must be after the start date";
      if (!d.unlimitedVisits && (!d.visitsCovered || parseInt(d.visitsCovered) <= 0))
        return "Enter how many visits the contract covers, or tick Unlimited visits";
      return null;
    }
    case "billing": {
      const assets = d.lines.map((l) => l.assetId);
      for (let i = 0; i < d.lines.length; i++) {
        const l = d.lines[i];
        const at = d.lines.length > 1 ? ` on line ${i + 1}` : "";
        if (!l.assetId) return `Choose the asset this contract covers${at}`;
        const cost = parseFloat(l.perCycleCost);
        if (!cost || cost <= 0) return `Enter what the vendor charges each time they bill, before GST${at}`;
        if (l.cycleCountOverride.trim() !== "" && parseInt(l.cycleCountOverride) <= 0)
          return `The number of bills must be at least 1${at}`;
      }
      if (new Set(assets).size !== assets.length) return "Each asset can only be on one line";
      return null;
    }
    case "running":
      return d.running?.scheduleProblem ?? null;
    case "contacts":
      return !d.contactName.trim() || !d.helpline.trim() ? "Enter the vendor's main contact name and phone number" : null;
    default:
      return null;
  }
}

/** "12 months" for a contract running start to end (inclusive), or null if it can't be worked out. */
export function contractLengthText(start: string, end: string): string | null {
  const months = cyclesBetween(start, end, "monthly");
  if (!months) return null;
  if (months % 12 === 0) {
    const y = months / 12;
    return y === 1 ? "12 months (1 year)" : `${months} months (${y} years)`;
  }
  return `${months} month${months === 1 ? "" : "s"}`;
}
