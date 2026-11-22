// What goes on a person's calendar for a tour, and who gets an entry. Pure, so the Google calls stay
// thin and this can be tested. The customer is never added and nobody is emailed an invite: each
// person's entry is written straight into their own calendar.

const HOUR_MS = 60 * 60 * 1000;

export interface TourCalendarPerson {
  userId: string;
  email: string | null;
  role: "host" | "accompanying";
}

/**
 * The people who get an entry: the host and the person accompanying, once each (someone who is both
 * gets one entry, as host), and only those with an address `isWorkspaceEmail` accepts.
 */
export function tourCalendarPeople(
  host: { id: string; email: string | null } | null,
  accompanier: { id: string; email: string | null } | null,
  isWorkspaceEmail: (email: string | null | undefined) => boolean,
): TourCalendarPerson[] {
  const out: TourCalendarPerson[] = [];
  if (host && isWorkspaceEmail(host.email)) out.push({ userId: host.id, email: host.email, role: "host" });
  if (accompanier && accompanier.id !== host?.id && isWorkspaceEmail(accompanier.email)) {
    out.push({ userId: accompanier.id, email: accompanier.email, role: "accompanying" });
  }
  return out;
}

/** Entries made earlier for people who no longer have the tour (a changed host, an untagged accompanier). */
export function staleCalendarUsers(existingUserIds: string[], wanted: TourCalendarPerson[]): string[] {
  const keep = new Set(wanted.map((w) => w.userId));
  return existingUserIds.filter((id) => !keep.has(id));
}

export interface TourEventInput {
  customer: string;
  centre: string | null;
  startIso: string;
  endIso: string | null;
  role: TourCalendarPerson["role"];
  hostName: string | null;
  requirement: string | null;
  leadUrl: string;
}

/** The event body. No attendees: it sits on the person's own calendar and nobody is invited. */
export function buildTourEventBody(t: TourEventInput) {
  const end = t.endIso && Date.parse(t.endIso) > Date.parse(t.startIso) ? t.endIso : new Date(Date.parse(t.startIso) + HOUR_MS).toISOString();
  const description = [
    t.role === "host" ? "You are hosting this tour." : `You are accompanying this tour${t.hostName ? `, hosted by ${t.hostName}` : ""}.`,
    t.requirement ? `They need: ${t.requirement}` : null,
    `View in CRM: ${t.leadUrl}`,
  ]
    .filter(Boolean)
    .join("\n");
  return {
    summary: `Tour: ${t.customer}${t.centre ? ` · ${t.centre}` : ""}`,
    description,
    location: t.centre ?? undefined,
    start: { dateTime: new Date(t.startIso).toISOString() },
    end: { dateTime: new Date(end).toISOString() },
    // Popup only, so Google does not email anyone from the synced event.
    reminders: { useDefault: false, overrides: [{ method: "popup", minutes: 30 }] },
  };
}
