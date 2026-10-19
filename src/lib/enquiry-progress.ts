// How far an enquiry has got, read off the proposals and contracts of its lead instead of
// being typed in. Pure functions only (unit-tested); the DB gatherer is enquiry-progress-load.ts.
//
// Attachment: a lead can have several enquiries, and every proposal / contract belongs to
// exactly one of them: the newest enquiry received before the proposal was sent (a contract
// follows the proposal it came from). So a returning customer's new proposal lands on the new
// enquiry, never on the old one, and nothing is counted twice. Events more than
// MAX_ATTACH_DAYS after an enquiry don't attach to it (a new deal months later is not that
// enquiry's progress).

export const MAX_ATTACH_DAYS = 180;
/** Days of silence after which an open enquiry resolves itself as "no response". */
export const QUIET_DAYS_BEFORE_NO_RESPONSE = 21;
const DAY_MS = 86_400_000;

export const STAGES = [
  { key: "new", label: "New" },
  { key: "contacted", label: "Contacted" },
  { key: "booked", label: "Booked" },
  { key: "proposal_sent", label: "Proposal sent" },
  { key: "deposit_paid", label: "Deposit paid" },
  { key: "contract_sent", label: "Contract sent" },
  { key: "contract_signed", label: "Contract signed" },
  { key: "active", label: "Active customer" },
] as const;
export type StageKey = (typeof STAGES)[number]["key"];
export type EnquiryStage = { key: StageKey; label: string };

export type ProgressEnquiry = {
  id: string;
  received_at: string;
  claimed_at: string | null;
  resolved_at: string | null;
  /** Last time the customer messaged, or a person logged an update (whichever is later). */
  last_touch_at?: string | null;
};

export type ProgressProposal = {
  id: string;
  sent_at: string | null;
  viewed_at: string | null;
  /** When the deposit (or, failing that, the first payment) was received. */
  paid_at: string | null;
  proposal_number?: string | null;
};

export type ProgressContract = {
  id: string;
  proposal_id: string | null;
  is_renewal: boolean;
  sent_at: string | null;
  signed_at: string | null;
  activated_at: string | null;
  contract_number?: string | null;
};

/** A room or day-pass booking. Only ones that stand (not cancelled or a no-show) count. */
export type ProgressBooking = {
  id: string;
  booking_number?: string | null;
  status: string;
  created_at: string;
};

/** Booking statuses that mean the customer really booked. */
export const COUNTED_BOOKING_STATUSES = ["confirmed", "checked_in", "checked_out"];

export type Milestone = { key: StageKey; label: string; at: string; ref?: string | null };

export type EnquiryProgress = { stage: EnquiryStage; milestones: Milestone[] };

/** The newest enquiry received at or before `at` (and within MAX_ATTACH_DAYS), or null. */
export function attachTo(enquiries: ProgressEnquiry[], at: string): string | null {
  const t = Date.parse(at);
  let best: ProgressEnquiry | null = null;
  for (const e of enquiries) {
    const r = Date.parse(e.received_at);
    if (r <= t && t - r <= MAX_ATTACH_DAYS * DAY_MS && (!best || r > Date.parse(best.received_at))) best = e;
  }
  return best?.id ?? null;
}

const stageOf = (key: StageKey): EnquiryStage => ({ key, label: STAGES.find((s) => s.key === key)!.label });
const rank = (key: StageKey) => STAGES.findIndex((s) => s.key === key);

export function deriveProgress(
  enquiries: ProgressEnquiry[],
  proposals: ProgressProposal[],
  contracts: ProgressContract[],
  bookings: ProgressBooking[] = []
): Map<string, EnquiryProgress> {
  const out = new Map<string, Milestone[]>(enquiries.map((e) => [e.id, []]));
  const proposalOwner = new Map<string, string>();

  for (const p of proposals) {
    if (!p.sent_at) continue; // a draft is not progress
    const owner = attachTo(enquiries, p.sent_at);
    if (!owner) continue;
    proposalOwner.set(p.id, owner);
    const ref = p.proposal_number ?? null;
    const m = out.get(owner)!;
    m.push({ key: "proposal_sent", label: "Proposal sent", at: p.sent_at, ref });
    if (p.paid_at) m.push({ key: "deposit_paid", label: "Deposit paid", at: p.paid_at, ref });
  }

  for (const c of contracts) {
    if (c.is_renewal) continue; // a renewal is the existing customer, not this enquiry
    const anchor = c.sent_at ?? c.signed_at ?? c.activated_at;
    const owner = (c.proposal_id && proposalOwner.get(c.proposal_id)) || (anchor ? attachTo(enquiries, anchor) : null);
    if (!owner) continue;
    const m = out.get(owner)!;
    const ref = c.contract_number ?? null;
    if (c.sent_at) m.push({ key: "contract_sent", label: "Contract sent", at: c.sent_at, ref });
    if (c.signed_at) m.push({ key: "contract_signed", label: "Contract signed", at: c.signed_at, ref });
    if (c.activated_at) m.push({ key: "active", label: "Contract activated", at: c.activated_at, ref });
  }

  // Meeting rooms and day passes convert through a booking, not a contract. Each booking belongs
  // to the newest enquiry received before it was made; one milestone per enquiry (the first).
  const bookedOn = new Set<string>();
  for (const b of [...bookings].sort((x, y) => x.created_at.localeCompare(y.created_at))) {
    if (!COUNTED_BOOKING_STATUSES.includes(b.status)) continue;
    const owner = attachTo(enquiries, b.created_at);
    if (!owner || bookedOn.has(owner)) continue;
    bookedOn.add(owner);
    out.get(owner)!.push({ key: "booked", label: "Booking made", at: b.created_at, ref: b.booking_number ?? null });
  }

  const result = new Map<string, EnquiryProgress>();
  for (const e of enquiries) {
    const milestones = (out.get(e.id) ?? []).sort((a, b) => a.at.localeCompare(b.at));
    let key: StageKey = e.claimed_at ? "contacted" : "new";
    for (const m of milestones) if (rank(m.key) > rank(key)) key = m.key;
    result.set(e.id, { stage: stageOf(key), milestones });
  }
  return result;
}

export type AutoResolution = { enquiryId: string; outcome: "converted" | "not_interested" | "no_response"; reason: string };

/** Which open enquiries should resolve themselves right now. Only enquiries received on or
 *  after `cutoffIso` are ever touched; with no cut-off, nothing is. */
export function autoResolutions(
  enquiries: ProgressEnquiry[],
  progress: Map<string, EnquiryProgress>,
  leadStatus: string | null,
  now: Date,
  cutoffIso: string | null
): AutoResolution[] {
  if (!cutoffIso || Number.isNaN(Date.parse(cutoffIso))) return [];
  const cutoff = Date.parse(cutoffIso);
  const res: AutoResolution[] = [];
  for (const e of enquiries) {
    if (e.resolved_at || Date.parse(e.received_at) < cutoff) continue;
    const p = progress.get(e.id);
    if (p?.milestones.some((m) => m.key === "active" || m.key === "booked")) {
      res.push({
        enquiryId: e.id,
        outcome: "converted",
        reason: p.milestones.some((m) => m.key === "active") ? "contract activated" : "booking made",
      });
      continue;
    }
    if (leadStatus === "lost") {
      res.push({ enquiryId: e.id, outcome: "not_interested", reason: "lead marked lost" });
      continue;
    }
    const touches = [e.received_at, e.claimed_at, e.last_touch_at, ...(p?.milestones.map((m) => m.at) ?? [])]
      .filter((x): x is string => !!x)
      .map((x) => Date.parse(x));
    const quietDays = (now.getTime() - Math.max(...touches)) / DAY_MS;
    if (quietDays >= QUIET_DAYS_BEFORE_NO_RESPONSE) {
      res.push({ enquiryId: e.id, outcome: "no_response", reason: `no activity for ${QUIET_DAYS_BEFORE_NO_RESPONSE} days` });
    }
  }
  return res;
}
