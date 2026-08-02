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

  if (range === "day") {
    const currentStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const currentEnd = new Date(currentStart.getTime() + 24 * 60 * 60 * 1000);
    return {
      currentStart,
      currentEnd,
      previousStart: new Date(currentStart.getTime() - 24 * 60 * 60 * 1000),
      previousEnd: currentStart,
    };
  }

  if (range === "week") {
    // ISO week: Monday start.
    const dayOfWeek = (now.getDay() + 6) % 7; // 0 = Monday
    const currentStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - dayOfWeek);
    const currentEnd = new Date(currentStart.getTime() + 7 * 24 * 60 * 60 * 1000);
    return {
      currentStart,
      currentEnd,
      previousStart: new Date(currentStart.getTime() - 7 * 24 * 60 * 60 * 1000),
      previousEnd: currentStart,
    };
  }

  if (range === "month") {
    const currentStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const currentEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    return {
      currentStart,
      currentEnd,
      previousStart: new Date(now.getFullYear(), now.getMonth() - 1, 1),
      previousEnd: currentStart,
    };
  }

  if (range === "quarter") {
    const q = Math.floor(now.getMonth() / 3);
    const currentStart = new Date(now.getFullYear(), q * 3, 1);
    const currentEnd = new Date(now.getFullYear(), q * 3 + 3, 1);
    return {
      currentStart,
      currentEnd,
      previousStart: new Date(now.getFullYear(), q * 3 - 3, 1),
      previousEnd: currentStart,
    };
  }

  // year
  const currentStart = new Date(now.getFullYear(), 0, 1);
  const currentEnd = new Date(now.getFullYear() + 1, 0, 1);
  return {
    currentStart,
    currentEnd,
    previousStart: new Date(now.getFullYear() - 1, 0, 1),
    previousEnd: currentStart,
  };
}
