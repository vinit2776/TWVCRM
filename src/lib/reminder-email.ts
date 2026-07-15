import { resend, EMAIL_FROM, EMAIL_REPLY_TO } from "@/lib/mailer";
import { generateICS } from "@/lib/ics-generator";
import { ACTIVITY_TYPE_LABELS } from "@/lib/constants";
import type { ActivityType } from "@/types";

// Follow-up reminders don't have an inherent duration — block out 30 minutes
// so the calendar event renders as a normal timed entry rather than a
// zero-length one (some calendar clients collapse zero-length events).
const REMINDER_DURATION_MS = 30 * 60 * 1000;
const ORGANIZER_EMAIL = "noreply@theworkvilla.com";

interface FollowUpReminderParams {
  activityId: string;
  leadId: string;
  leadName: string;
  activityType: ActivityType;
  subject?: string | null;
  followUpDate: string;
  followUpNotes?: string | null;
  recipientEmail: string;
  recipientName: string;
}

/**
 * Emails the CRM user who owns a follow-up an .ics calendar invite for it.
 * Fire-and-forget — never throws, never blocks the caller's response.
 */
export function sendFollowUpReminderEmail(params: FollowUpReminderParams): void {
  const {
    activityId,
    leadId,
    leadName,
    activityType,
    subject,
    followUpDate,
    followUpNotes,
    recipientEmail,
    recipientName,
  } = params;

  const startDate = new Date(followUpDate);
  if (Number.isNaN(startDate.getTime())) return;
  const endDate = new Date(startDate.getTime() + REMINDER_DURATION_MS);

  const appUrl = (
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.APP_URL ||
    "https://twv-crm.vercel.app"
  ).trim();
  const leadUrl = `${appUrl}/leads/${leadId}?tab=activities&highlight=${activityId}`;

  const summary = `Follow-up: ${leadName}`;
  const description = [
    `${ACTIVITY_TYPE_LABELS[activityType] ?? activityType} follow-up for ${leadName}.`,
    subject ? `Subject: ${subject}` : null,
    followUpNotes ? `Notes: ${followUpNotes}` : null,
    `View in CRM: ${leadUrl}`,
  ]
    .filter(Boolean)
    .join("\n");

  const icsContent = generateICS({
    summary,
    description,
    location: "",
    startDate,
    endDate,
    organizerEmail: ORGANIZER_EMAIL,
    attendeeEmail: recipientEmail,
  });

  resend.emails
    .send({
      from: EMAIL_FROM,
      to: recipientEmail,
      replyTo: EMAIL_REPLY_TO,
      subject: `Reminder: Follow up with ${leadName}`,
      html: `
        <p>Hi ${recipientName},</p>
        <p>You have a follow-up reminder for <strong>${leadName}</strong>.</p>
        ${followUpNotes ? `<p>${followUpNotes}</p>` : ""}
        <p>Open the attached invite to add it to your calendar — your calendar app's own reminders will handle the alert on your phone and desktop.</p>
        <p><a href="${leadUrl}">View in TWV CRM</a></p>
      `,
      attachments: [
        {
          filename: `followup-${activityId}.ics`,
          content: Buffer.from(icsContent).toString("base64"),
          contentType: "text/calendar",
        },
      ],
    })
    .then(({ error }) => {
      if (error) console.error("[reminder-email] send failed:", error.name, error.message);
    })
    .catch((err) => {
      console.error("[reminder-email] send threw:", err instanceof Error ? err.message : err);
    });
}
