export type ActivityRange = "hour" | "day" | "week" | "month" | "quarter" | "year" | "custom";

export interface PeriodBounds {
  currentStart: Date;
  currentEnd: Date;
  previousStart: Date;
  previousEnd: Date;
}

/**
 * Calendar-aligned period bounds for the activity storyboard's trend view
 * (this period vs. the immediately-prior equivalent period). Calendar-aligned
 * (e.g. this calendar month vs. last calendar month) rather than a rolling
 * window, since that reads more naturally in an appraisal conversation.
 * "hour" has no calendar-aligned equivalent, so it's a trailing 60-minute
 * window instead.
 *
 * The current period is capped at `now` rather than the nominal period end,
 * and the previous period is matched to that same elapsed duration — e.g. on
 * Aug 2, "this month" compares the first 2 days of August against the first
 * 2 days of July, not the first 2 days of August against the FULL 31 days of
 * July. Without this, every partially-elapsed period reads as a dramatic
 * decline purely because it just started.
 */
export function computePeriodBounds(
  range: ActivityRange,
  now: Date,
  custom?: { start: Date; end: Date }
): PeriodBounds {
  if (range === "custom") {
    if (!custom) throw new Error("custom range requires start and end");
    const spanMs = custom.end.getTime() - custom.start.getTime();
    return {
      currentStart: custom.start,
      currentEnd: custom.end,
      previousStart: new Date(custom.start.getTime() - spanMs),
      previousEnd: custom.start,
    };
  }

  if (range === "hour") {
    const currentStart = new Date(now.getTime() - 60 * 60 * 1000);
    return {
      currentStart,
      currentEnd: now,
      previousStart: new Date(currentStart.getTime() - 60 * 60 * 1000),
      previousEnd: currentStart,
    };
  }

  let currentStart: Date;
  let previousStart: Date;

  if (range === "day") {
    currentStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    previousStart = new Date(currentStart.getTime() - 24 * 60 * 60 * 1000);
  } else if (range === "week") {
    // ISO week: Monday start.
    const dayOfWeek = (now.getDay() + 6) % 7; // 0 = Monday
    currentStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - dayOfWeek);
    previousStart = new Date(currentStart.getTime() - 7 * 24 * 60 * 60 * 1000);
  } else if (range === "month") {
    currentStart = new Date(now.getFullYear(), now.getMonth(), 1);
    previousStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  } else if (range === "quarter") {
    const q = Math.floor(now.getMonth() / 3);
    currentStart = new Date(now.getFullYear(), q * 3, 1);
    previousStart = new Date(now.getFullYear(), q * 3 - 3, 1);
  } else {
    // year
    currentStart = new Date(now.getFullYear(), 0, 1);
    previousStart = new Date(now.getFullYear() - 1, 0, 1);
  }

  // `now` is always within the current period (it just started, at latest),
  // so this is really just `now` — but expressed as a cap in case of clock skew.
  const currentEnd = new Date(Math.min(now.getTime(), currentEndFor(range, currentStart)));
  const elapsedMs = currentEnd.getTime() - currentStart.getTime();

  return {
    currentStart,
    currentEnd,
    previousStart,
    previousEnd: new Date(previousStart.getTime() + elapsedMs),
  };
}

/** Nominal (full) end of the period starting at `start`, before capping at `now`. */
function currentEndFor(range: ActivityRange, start: Date): number {
  if (range === "day") return start.getTime() + 24 * 60 * 60 * 1000;
  if (range === "week") return start.getTime() + 7 * 24 * 60 * 60 * 1000;
  if (range === "month") return new Date(start.getFullYear(), start.getMonth() + 1, 1).getTime();
  if (range === "quarter") return new Date(start.getFullYear(), start.getMonth() + 3, 1).getTime();
  return new Date(start.getFullYear() + 1, 0, 1).getTime(); // year
}
