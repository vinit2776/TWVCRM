import { google } from "googleapis";
import { ACTIVITY_TYPE_LABELS } from "@/lib/constants";
import type { ActivityType } from "@/types";

// Follow-up reminders don't have an inherent duration — block out 30 minutes
// so the calendar event renders as a normal timed entry rather than a
// zero-length one (matches the old .ics reminder-email convention).
const REMINDER_DURATION_MS = 30 * 60 * 1000;
const CALENDAR_SCOPES = ["https://www.googleapis.com/auth/calendar.events"];
// All three domains share the one Google Workspace org the service account
// is delegated into — anyone outside these is skipped and just relies on
// the daily digest email instead.
const WORKSPACE_DOMAINS = ["theworkvilla.com", "chordia.co", "chordia.asia"];

export function isWorkspaceEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const lower = email.toLowerCase();
  return WORKSPACE_DOMAINS.some((domain) => lower.endsWith(`@${domain}`));
}

function getCalendarClient(subjectEmail: string) {
  const clientEmail = process.env.GOOGLE_CALENDAR_SA_EMAIL;
  const privateKey = process.env.GOOGLE_CALENDAR_SA_PRIVATE_KEY?.replace(/\\n/g, "\n");

  if (!clientEmail || !privateKey) {
    throw new Error("GOOGLE_CALENDAR_SA_EMAIL or GOOGLE_CALENDAR_SA_PRIVATE_KEY not configured");
  }

  const auth = new google.auth.JWT({
    email: clientEmail,
    key: privateKey,
    scopes: CALENDAR_SCOPES,
    subject: subjectEmail,
  });

  return google.calendar({ version: "v3", auth });
}

interface ReminderEventParams {
  activityId: string;
  leadId: string;
  leadName: string;
  activityType: ActivityType;
  subject?: string | null;
  followUpDate: string;
  followUpNotes?: string | null;
  ownerEmail: string;
}

function buildEventBody(params: ReminderEventParams) {
  const { leadId, leadName, activityType, subject, followUpDate, followUpNotes, activityId } = params;

  const startDate = new Date(followUpDate);
  const endDate = new Date(startDate.getTime() + REMINDER_DURATION_MS);

  const appUrl = (
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.APP_URL ||
    "https://twv-crm.vercel.app"
  ).trim();
  const leadUrl = `${appUrl}/leads/${leadId}?tab=activities&highlight=${activityId}`;

  const description = [
    `${ACTIVITY_TYPE_LABELS[activityType] ?? activityType} follow-up for ${leadName}.`,
    subject ? `Subject: ${subject}` : null,
    followUpNotes ? `Notes: ${followUpNotes}` : null,
    `View in CRM: ${leadUrl}`,
  ]
    .filter(Boolean)
    .join("\n");

  return {
    summary: `Follow-up: ${leadName}`,
    description,
    start: { dateTime: startDate.toISOString() },
    end: { dateTime: endDate.toISOString() },
    reminders: {
      useDefault: false,
      overrides: [
        { method: "popup", minutes: 30 },
        { method: "email", minutes: 60 },
      ],
    },
  };
}

/**
 * Creates a calendar event on the activity owner's own theworkvilla.com
 * Google Calendar for a new follow-up reminder. Returns the created
 * event's ID (to store on the activity row for later reschedule), or
 * null if sync was skipped or failed. Never throws.
 */
export async function createReminderEvent(params: ReminderEventParams): Promise<string | null> {
  if (!isWorkspaceEmail(params.ownerEmail)) return null;

  try {
    const calendar = getCalendarClient(params.ownerEmail);
    const { data } = await calendar.events.insert({
      calendarId: "primary",
      requestBody: buildEventBody(params),
    });
    return data.id ?? null;
  } catch (err) {
    console.error("[google-calendar] createReminderEvent failed:", err instanceof Error ? err.message : err);
    return null;
  }
}

interface RescheduleReminderEventParams extends ReminderEventParams {
  calendarEventId: string | null;
}

/**
 * Updates the existing calendar event's time for a rescheduled
 * follow-up. If there's no existing event (e.g. it was never synced,
 * or was since deleted on the calendar side), creates a new one
 * instead. Returns the event ID to persist, or null if unsynced.
 * Never throws.
 */
export async function rescheduleReminderEvent(params: RescheduleReminderEventParams): Promise<string | null> {
  if (!isWorkspaceEmail(params.ownerEmail)) return null;

  if (!params.calendarEventId) {
    return createReminderEvent(params);
  }

  try {
    const calendar = getCalendarClient(params.ownerEmail);
    const { data } = await calendar.events.patch({
      calendarId: "primary",
      eventId: params.calendarEventId,
      requestBody: buildEventBody(params),
    });
    return data.id ?? null;
  } catch (err) {
    console.error("[google-calendar] rescheduleReminderEvent patch failed, creating new event:", err instanceof Error ? err.message : err);
    return createReminderEvent(params);
  }
}
