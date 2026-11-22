export type TimelinePreset = "this_week" | "this_month" | "last_month" | "this_year";

// Local calendar date. toISOString() converts to UTC first, which in IST turns local
// midnight into the previous day and made "This Month" start on the 31st of last month.
function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function getDateRange(preset: TimelinePreset): { dateFrom: string; dateTo: string } {
  const now = new Date();
  const today = ymd(now);

  switch (preset) {
    case "this_week": {
      const day = now.getDay(); // 0=Sun, 1=Mon, ...
      const diff = day === 0 ? 6 : day - 1; // Monday = start of week
      const monday = new Date(now);
      monday.setDate(now.getDate() - diff);
      return { dateFrom: ymd(monday), dateTo: today };
    }
    case "this_month": {
      return { dateFrom: ymd(new Date(now.getFullYear(), now.getMonth(), 1)), dateTo: today };
    }
    case "last_month": {
      return {
        dateFrom: ymd(new Date(now.getFullYear(), now.getMonth() - 1, 1)),
        dateTo: ymd(new Date(now.getFullYear(), now.getMonth(), 0)), // day 0 = last day of previous month
      };
    }
    case "this_year": {
      return { dateFrom: ymd(new Date(now.getFullYear(), 0, 1)), dateTo: today };
    }
  }
}
