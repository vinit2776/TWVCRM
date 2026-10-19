// Decides what an inbound WhatsApp message IS before it can become an enquiry: a genuine
// enquiry, a message from an existing customer, a complaint, spam, a bare acknowledgement,
// or unclear. Rules run first (instant, free, explainable); only an "unclear" message may be
// passed to the optional AI check in whatsapp-triage-ai.ts. Pure functions, unit-tested.

export type TriageKind = "enquiry" | "customer" | "complaint" | "spam" | "low_signal" | "unsure";

export type TriageContext = {
  /** The sender is a lead with an active contract: a customer, not a prospect. */
  hasActiveContract: boolean;
  /** Status of the lead this number belongs to, or null for an unknown number. */
  leadStatus: string | null;
  /** The message is a reply to an ad (Click-to-WhatsApp). */
  hasReferral: boolean;
  /** This number already belongs to a lead. */
  knownSender: boolean;
  /** The lead has a WhatsApp enquiry that is still open. */
  hasOpenEnquiry: boolean;
};

export type TriageResult = { kind: TriageKind; reason: string; source: "rules" | "ai" };

const URL_RE = /(https?:\/\/|www\.|bit\.ly|tinyurl|t\.me\/|wa\.me\/)/gi;
const SPAM_RE =
  /\b(lottery|lucky draw|you(?:'ve| have)? won|prize|winner|crypto|bitcoin|forex|trading signals?|investment (?:plan|offer)|earn (?:rs|₹|\$|money)|work from home|loan (?:offer|approved)|casino|betting|click (?:the )?link|join (?:our )?(?:telegram|whatsapp) group|guaranteed returns?|18\+|adult)\b/gi;
const COMPLAINT_RE =
  /\b(not working|isn'?t working|stopped working|broken|complain\w*|leak\w*|a\/?c\b|aircon|wi-?fi|internet|network down|dirty|noise|noisy|refund|overcharg\w*|wrong (?:bill|invoice|amount)|power cut|lift|elevator|parking|pest|cockroach|toilet|washroom|water supply|invoice|payment (?:not|failed)|not received|issue|problem)\b/i;
const ENQUIRY_RE =
  /\b(seats?|desks?|cabins?|private office|office space|meeting rooms?|conference|co-?working|work ?space|virtual office|day pass|hot desk|dedicated|pric\w*|rates?|rent|cost|budget|per month|monthly|availab\w*|visit|tour|brochure|gst|registration|business address|looking for|interested|enquir\w*|inquir\w*|quot\w*)\b/i;
const STRONG_ENQUIRY_RE = /\b(seats?|cabins?|private office|meeting rooms?|conference|availab\w*|quot\w*|pric\w*)\b/i;
const ACK_WORD = "(?:ok|okay|k|kk|thanks?|thank you|thankyou|thx|ty|yes|no|hi+|hello|hey|good (?:morning|evening|afternoon)|noted|sure|fine|done|please|👍|🙏|🙂|\\.+)";
// One or more acknowledgement words only ("ok thanks", "okay, noted"): no request in it.
const ACK_RE = new RegExp(`^(?:${ACK_WORD}[\\s,!.]*)+$`, "i");
const NON_TEXT_TYPES = new Set(["sticker", "reaction"]);

const count = (re: RegExp, s: string) => (s.match(re) ?? []).length;

export function classifyByRules(text: string, messageType: string, ctx: TriageContext): TriageResult {
  const t = text.trim();
  const urls = count(URL_RE, t);
  const spamHits = count(SPAM_RE, t);
  const looksSpam = (urls >= 1 && spamHits >= 1) || spamHits >= 2 || urls >= 3;
  const complaint = COMPLAINT_RE.test(t);
  const enquiry = ENQUIRY_RE.test(t);
  const result = (kind: TriageKind, reason: string): TriageResult => ({ kind, reason, source: "rules" });

  if (ctx.hasActiveContract) {
    if (complaint) return result("complaint", "customer with an active contract describing a problem");
    if (STRONG_ENQUIRY_RE.test(t)) return result("unsure", "customer asking about space or price: expansion or a question?");
    return result("customer", "message from a customer with an active contract");
  }
  if (looksSpam && !ctx.hasReferral) return result("spam", "promotional or scam wording");
  if (ctx.leadStatus === "junk" && !ctx.hasReferral) {
    return enquiry ? result("unsure", "number was marked spam before, but this reads like an enquiry") : result("spam", "number was marked spam before");
  }
  if (ctx.hasReferral) return result("enquiry", "reply to an ad");
  if (enquiry) return result("enquiry", "asks about space, price or a visit");
  if (NON_TEXT_TYPES.has(messageType) || ACK_RE.test(t)) {
    return ctx.hasOpenEnquiry || ctx.knownSender
      ? result("low_signal", "acknowledgement with no new request")
      : result("unsure", "greeting or sticker from a new number");
  }
  return result("unsure", "could not tell from the wording");
}

// ─── Same conversation or a new enquiry? ─────────────────────────────────────

/** An open enquiry stays the live conversation until this long after its last message. */
export const OPEN_SILENCE_DAYS = 3;
/** ...or this long if someone has claimed it or planned a next step (they are working it). */
export const OWNED_SILENCE_DAYS = 7;
/** After a "not interested" / "no response" outcome, a message within this window is a re-enquiry. */
export const REENQUIRY_WINDOW_DAYS = 30;
const DAY_MS = 86_400_000;

export type LatestEnquiry = {
  resolved_at: string | null;
  resolution_outcome: string | null;
  claimed: boolean;
  hasNextStep: boolean;
  /** When the customer last wrote or a person last logged an update (falls back to received). */
  last_touch_at: string;
};

export type GroupingDecision = "join" | "new" | "customer_message";

/** Where a message that IS an enquiry goes, given the newest WhatsApp enquiry for the lead. */
export function decideGrouping(latest: LatestEnquiry | null, now: Date): GroupingDecision {
  if (!latest) return "new";
  const idleDays = (now.getTime() - Date.parse(latest.last_touch_at)) / DAY_MS;
  if (!latest.resolved_at) {
    const limit = latest.claimed || latest.hasNextStep ? OWNED_SILENCE_DAYS : OPEN_SILENCE_DAYS;
    return idleDays <= limit ? "join" : "new";
  }
  // Resolved: a converted customer writing again is a customer, not a new enquiry. Anything
  // else that was closed recently is treated as the customer coming back (a re-enquiry);
  // older than the window it is simply a fresh enquiry. Both create a new enquiry row.
  if (latest.resolution_outcome === "converted") return "customer_message";
  return "new";
}
