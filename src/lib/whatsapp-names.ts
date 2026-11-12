// Naming the person behind a WhatsApp enquiry. Pure functions, unit-tested.

/** The name a lead gets when WhatsApp gave us a number and no name. */
export const PLACEHOLDER_NAME = "WhatsApp contact";

const NAME_INTRO =
  /\b(?:my name is|this is|i am|i'm|im|myself|name\s*(?:is|[:\-]))\s+([a-z][a-z.'\-]*(?:\s+[a-z][a-z.'\-]*){0,3})/i;
// Words that end a name or show the phrase was not a name ("I am looking for", "this is urgent").
const NOT_NAME = new Set([
  "looking", "interested", "a", "an", "the", "here", "from", "in", "at", "for", "to", "with", "not", "just", "also",
  "very", "sorry", "happy", "glad", "writing", "contacting", "enquiring", "inquiring", "calling", "reaching",
  "planning", "starting", "new", "currently", "wanting", "want", "need", "needing", "urgent", "important",
  "regarding", "related", "about", "my", "our", "and", "of", "on", "so", "wondering", "trying", "asking",
  "available", "sure", "ok", "okay", "yes", "no", "please", "pls", "hi", "hello", "hey", "thanks", "thank",
  "it", "that", "what", "which", "how", "when", "where", "who", "owner", "founder", "director", "manager",
  "ceo", "student", "working", "running", "having", "getting", "your", "you", "me", "us", "we", "i", "do",
]);

const titleCase = (w: string) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();

/** A first name (up to three words) the customer gave in their own message, or null. Used only
 *  as a suggestion a person confirms, never applied on its own. */
export function extractNameFromMessage(text: string): string | null {
  const m = text.match(NAME_INTRO);
  if (!m) return null;
  const words: string[] = [];
  for (const raw of m[1].split(/\s+/)) {
    const w = raw.replace(/[.']+$/g, "");
    if (!w || NOT_NAME.has(w.toLowerCase())) break;
    if (w.length < 2 || /\d/.test(w)) break;
    words.push(titleCase(w));
    if (words.length === 3) break;
  }
  return words.length > 0 ? words.join(" ") : null;
}

/** Whether a stored lead name is just our placeholder. */
export const isPlaceholderName = (first: string | null | undefined) => (first ?? "").trim() === PLACEHOLDER_NAME;

/** MSG91 may put the sender's WhatsApp profile name under one of several keys depending on how
 *  the webhook was set up, or inside a Meta-style `contacts` array (an array, or a JSON string
 *  of one, at the top level or inside `content`). Returns null when none is present. */
export function pickProfileName(event: Record<string, unknown>): string | null {
  const clean = (v: unknown) => (typeof v === "string" && v.trim() && v.trim() !== "[object Object]" ? v.trim().slice(0, 80) : null);
  for (const k of ["profileName", "profile_name", "customerName", "contactName", "senderName", "waName"]) {
    const v = clean(event[k]);
    if (v) return v;
  }
  const fromContacts = (c: unknown): string | null => {
    let list: unknown = c;
    if (typeof list === "string") {
      try { list = JSON.parse(list); } catch { return null; }
    }
    const first = Array.isArray(list) ? (list[0] as Record<string, unknown> | undefined) : undefined;
    const profile = first?.profile as Record<string, unknown> | undefined;
    return clean(profile?.name) ?? clean(first?.name);
  };
  const direct = fromContacts(event.contacts);
  if (direct) return direct;
  let content: unknown = event.content;
  if (typeof content === "string") {
    try { content = JSON.parse(content); } catch { return null; }
  }
  return content && typeof content === "object" ? fromContacts((content as Record<string, unknown>).contacts) : null;
}
