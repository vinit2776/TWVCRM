export type TimelinePreset = "this_week" | "this_month" | "this_year";

export function getDateRange(preset: TimelinePreset): { dateFrom: string; dateTo: string } {
  const now = new Date();
  const today = now.toISOString().slice(0, 10);

  switch (preset) {
    case "this_week": {
      const day = now.getDay(); // 0=Sun, 1=Mon, ...
      const diff = day === 0 ? 6 : day - 1; // Monday = start of week
      const monday = new Date(now);
      monday.setDate(now.getDate() - diff);
      return { dateFrom: monday.toISOString().slice(0, 10), dateTo: today };
    }
    case "this_month": {
      const first = new Date(now.getFullYear(), now.getMonth(), 1);
      return { dateFrom: first.toISOString().slice(0, 10), dateTo: today };
    }
    case "this_year": {
      const jan1 = new Date(now.getFullYear(), 0, 1);
      return { dateFrom: jan1.toISOString().slice(0, 10), dateTo: today };
    }
  }
}
