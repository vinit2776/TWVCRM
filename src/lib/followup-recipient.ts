// A follow-up reminder belongs to whoever is handling the lead now, not to whoever happened to log
// the activity. Reassigning a lead therefore moves every pending reminder with it. A lead nobody
// handles keeps going to the person who set the follow-up, so nothing goes silent.

export interface Person {
  id?: string | null;
  email?: string | null;
  phone?: string | null;
  full_name?: string | null;
}

export function followUpRecipient(row: {
  creator?: Person | null;
  lead?: { assigned_user?: Person | null } | null;
}): Person | null {
  const handler = row.lead?.assigned_user;
  if (handler && (handler.email || handler.phone)) return handler;
  return row.creator ?? null;
}
