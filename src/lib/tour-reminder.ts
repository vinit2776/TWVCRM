// The "tour in 2 hours" reminder: who gets it and what it says. A tour reminder goes to the
// people running the tour (whoever booked it, whoever hosts it and whoever handles the lead),
// never to the customer.

/** How long before the tour start the reminder goes out. */
export const TOUR_REMINDER_MINUTES = 120;

/** The approved MSG91 WhatsApp template. Body: "Hi {{1}}, reminder: tour with {{2}} at {{3}} ({{4}}). Details: {{5}}" */
export const TOUR_REMINDER_WA_TEMPLATE = "lead_tour_reminder";

export const TOUR_REMINDER_MODE_SETTING = "tour_reminder_mode";

export interface Person {
  id: string;
  full_name?: string | null;
  email?: string | null;
  phone?: string | null;
}

/** Everyone involved in the tour, once each, and only those who can be reached. */
export function tourReminderRecipients(
  booker: Person | null | undefined,
  host: Person | null | undefined,
  handler?: Person | null,
): Person[] {
  const seen = new Set<string>();
  const out: Person[] = [];
  for (const p of [booker, host, handler]) {
    if (!p || seen.has(p.id)) continue;
    seen.add(p.id);
    if (p.email || p.phone) out.push(p);
  }
  return out;
}

/** "Thu 6 Nov, 11:00 am" in IST. */
export function tourTimeText(startIso: string): string {
  return new Date(startIso).toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** Minutes from `now` until the tour starts (can be negative once it has). */
export function minutesUntil(startIso: string, now: Date = new Date()): number {
  return Math.round((Date.parse(startIso) - now.getTime()) / 60000);
}

/** Whether a tour start falls inside the reminder window: in the future, and within 2 hours. */
export function inReminderWindow(startIso: string, now: Date = new Date()): boolean {
  const m = minutesUntil(startIso, now);
  return m > 0 && m <= TOUR_REMINDER_MINUTES;
}
