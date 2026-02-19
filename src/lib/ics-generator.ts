/**
 * Generates an RFC 5545 compliant ICS calendar invite string.
 */

interface ICSParams {
  summary: string;
  description: string;
  location: string;
  startDate: Date;
  endDate: Date;
  organizerEmail: string;
  attendeeEmail?: string;
}

function formatICSDate(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
}

function escapeICS(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\n/g, "\\n");
}

function generateUID(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}@twv-crm`;
}

export function generateICS(params: ICSParams): string {
  const { summary, description, location, startDate, endDate, organizerEmail, attendeeEmail } = params;

  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//TWV CRM//Booking//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:REQUEST",
    "BEGIN:VEVENT",
    `UID:${generateUID()}`,
    `DTSTAMP:${formatICSDate(new Date())}`,
    `DTSTART:${formatICSDate(startDate)}`,
    `DTEND:${formatICSDate(endDate)}`,
    `SUMMARY:${escapeICS(summary)}`,
    `DESCRIPTION:${escapeICS(description)}`,
    `LOCATION:${escapeICS(location)}`,
    `ORGANIZER;CN=The WorkVilla:mailto:${organizerEmail}`,
  ];

  if (attendeeEmail) {
    lines.push(`ATTENDEE;RSVP=TRUE;CN=${attendeeEmail}:mailto:${attendeeEmail}`);
  }

  lines.push(
    "STATUS:CONFIRMED",
    "BEGIN:VALARM",
    "TRIGGER:-PT15M",
    "ACTION:DISPLAY",
    "DESCRIPTION:Reminder",
    "END:VALARM",
    "END:VEVENT",
    "END:VCALENDAR"
  );

  return lines.join("\r\n");
}
