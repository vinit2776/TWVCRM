// Decisions behind the compact Enquiry Log row. Pure, unit-tested.

export type RowPrimary = "review" | "take" | "log" | "open";

/** The one button a row shows: a decision first (Review), then claiming, then logging an
 *  update on one you own. Finished or spam rows just open. */
export function rowPrimaryAction(r: {
  resolvedAt: string | null;
  isSpam: boolean;
  needsReview: boolean;
  claimedAt: string | null;
}): RowPrimary {
  if (r.isSpam || r.resolvedAt) return "open";
  if (r.needsReview) return "review";
  return r.claimedAt ? "log" : "take";
}

/** What to show for a logged message: its text, or the template name for a template send. */
export function conversationText(m: { message_body: string | null; template_name: string | null }): string {
  const body = (m.message_body ?? "").trim();
  if (body) return body;
  return m.template_name ? `[${m.template_name}]` : "[no text]";
}

/** Last 10 digits, the key the WhatsApp log is matched on. */
export function lastTenDigits(raw: string | null | undefined): string | null {
  const d = (raw ?? "").replace(/\D/g, "");
  return d.length >= 10 ? d.slice(-10) : null;
}
