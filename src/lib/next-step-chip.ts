import { istDayKey } from "@/lib/lead-days";

/** Past this many days the exact date matters more than a count, and it stops looking urgent. */
export const FAR_AFTER_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

export type NextStepState = "overdue" | "today" | "soon" | "far";

export interface NextStepChip {
  state: NextStepState;
  /** The loud part: "20 days overdue", "Today", "in 3 days", or the date once it is far off. */
  big: string;
  /** The exact date or time beside it: "was Fri 16 Oct", "4:00 pm", "Fri 6 Nov, 4:00 pm". */
  when: string;
}

function datePart(iso: string): string {
  const parts = new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    weekday: "short",
    day: "numeric",
    month: "short",
  }).formatToParts(new Date(iso));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("weekday")} ${get("day")} ${get("month")}`;
}

function timePart(iso: string): string {
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  })
    .format(new Date(iso))
    .toLowerCase();
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** How a lead's next step reads on the row, counted in IST days (the team's day, not the server's). */
export function nextStepChip(dueAt: string, now: Date = new Date()): NextStepChip {
  const days = Math.round((Date.parse(istDayKey(dueAt)) - Date.parse(istDayKey(now))) / DAY_MS);

  if (days < 0) return { state: "overdue", big: `${plural(-days, "day")} overdue`, when: `was ${datePart(dueAt)}` };
  if (days === 0) return { state: "today", big: "Today", when: timePart(dueAt) };
  if (days <= FAR_AFTER_DAYS) {
    return { state: "soon", big: `in ${plural(days, "day")}`, when: `${datePart(dueAt)}, ${timePart(dueAt)}` };
  }
  return { state: "far", big: datePart(dueAt), when: `in about ${plural(Math.round(days / 7), "week")}` };
}
