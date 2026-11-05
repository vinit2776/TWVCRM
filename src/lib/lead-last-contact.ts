/**
 * Whether an activity is a person actually speaking to, meeting or quoting the lead, for the
 * "Last:" line on the Leads list. Emails are logged for every automatic send too (booking
 * confirmations, invoices), so only a logged quote counts; the rest are bookkeeping.
 */
export function isLastContactActivity(a: { type: string; subject: string | null }): boolean {
  if (a.type === "call" || a.type === "tour" || a.type === "meeting") return true;
  return a.type === "email" && a.subject === "Quote sent";
}
