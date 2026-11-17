// Turns everything that happened on a lead into one list of events for the activity page. Each
// event says who did it (a team member, the customer, or the system), when, and carries links to
// the real thing: proposal, contract, invoice, receipt. Pure functions: the route fetches rows,
// this shapes them, so the shaping is testable without a database.

export type TimelineGroup = "calls" | "documents" | "money" | "system";
export type ActorKind = "team" | "customer" | "system";

export interface TimelineLink {
  label: string;
  href: string;
}

export interface TimelineEvent {
  id: string;
  at: string;
  group: TimelineGroup;
  /** Short heading: "Spoke", "Proposal sent", "Contract activated". */
  title: string;
  detail?: string | null;
  actor: string | null;
  actorKind: ActorKind;
  links: TimelineLink[];
}

type Person = { full_name?: string | null } | null | undefined;

export interface ActivityRow {
  id: string;
  type: string;
  subject?: string | null;
  description?: string | null;
  call_outcome?: string | null;
  meeting_start_at?: string | null;
  meeting_location?: string | null;
  follow_up_date?: string | null;
  follow_up_notes?: string | null;
  created_at: string;
  creator?: Person;
}

const ACTIVITY_TITLES: Record<string, string> = {
  call: "Call",
  meeting: "Meeting",
  tour: "Tour",
  email: "Email",
  note: "Note",
};

/** Notes the system writes when a lead changes hands. They are history, not something a person said. */
const HANDOVER_SUBJECTS = ["Claimed", "Reassigned"];

export function activityEvent(a: ActivityRow): TimelineEvent {
  const isHandover = a.type === "note" && HANDOVER_SUBJECTS.includes(a.subject ?? "");
  const isQuote = a.type === "email" && a.subject === "Quote sent";
  const group: TimelineGroup = isHandover ? "system" : isQuote ? "documents" : "calls";
  const title = a.subject?.trim() || ACTIVITY_TITLES[a.type] || "Activity";
  const bits: string[] = [];
  if (a.description) bits.push(a.description);
  if (a.type === "tour" && a.meeting_location) bits.push(`at ${a.meeting_location}`);
  return {
    id: `activity-${a.id}`,
    at: a.created_at,
    group,
    title,
    detail: bits.join(" · ") || null,
    actor: a.creator?.full_name ?? null,
    actorKind: "team",
    links: [],
  };
}

export interface EnquiryRow {
  id: string;
  reference: string;
  source: string;
  received_at: string;
  payload?: { name?: string; description?: string; messages?: { text?: string }[] } | null;
}

export function enquiryEvent(e: EnquiryRow, sourceLabel: string): TimelineEvent {
  const thread = (e.payload?.messages ?? []).map((m) => (m.text ?? "").trim()).filter(Boolean);
  const text = (thread[0] ?? e.payload?.description ?? "").trim();
  return {
    id: `enquiry-${e.id}`,
    at: e.received_at,
    group: "calls",
    title: `Enquiry received from ${sourceLabel}`,
    detail: text ? `“${text.length > 200 ? `${text.slice(0, 200)}…` : text}”` : null,
    actor: e.payload?.name?.trim() || null,
    actorKind: "customer",
    links: [{ label: e.reference, href: `/leads/enquiry-log?search=${encodeURIComponent(e.reference)}` }],
  };
}

export interface ProposalRow {
  id: string;
  proposal_number: string;
  total_amount?: number | null;
  created_at: string;
  sent_at?: string | null;
  viewed_at?: string | null;
  accepted_at?: string | null;
}

export function proposalEvents(p: ProposalRow, creator?: string | null): TimelineEvent[] {
  const link = { label: p.proposal_number, href: `/proposals/${p.id}` };
  const events: TimelineEvent[] = [
    { id: `proposal-${p.id}-created`, at: p.created_at, group: "documents", title: "Proposal drafted", detail: null, actor: creator ?? null, actorKind: "team", links: [link] },
  ];
  if (p.sent_at) {
    events.push({ id: `proposal-${p.id}-sent`, at: p.sent_at, group: "documents", title: "Proposal sent", detail: null, actor: creator ?? null, actorKind: "team", links: [link] });
  }
  if (p.viewed_at) {
    events.push({ id: `proposal-${p.id}-viewed`, at: p.viewed_at, group: "documents", title: "Customer opened the proposal", detail: null, actor: null, actorKind: "customer", links: [link] });
  }
  if (p.accepted_at) {
    events.push({ id: `proposal-${p.id}-accepted`, at: p.accepted_at, group: "documents", title: "Proposal accepted", detail: null, actor: null, actorKind: "customer", links: [link] });
  }
  return events;
}

export interface ContractRow {
  id: string;
  contract_number: string;
  created_at: string;
  activated_at?: string | null;
}

export function contractEvents(c: ContractRow): TimelineEvent[] {
  const link = { label: c.contract_number, href: `/contracts/${c.id}` };
  const events: TimelineEvent[] = [
    { id: `contract-${c.id}-created`, at: c.created_at, group: "money", title: "Contract drafted", detail: null, actor: null, actorKind: "system", links: [link] },
  ];
  if (c.activated_at) {
    events.push({ id: `contract-${c.id}-active`, at: c.activated_at, group: "money", title: "Contract activated", detail: null, actor: null, actorKind: "system", links: [link] });
  }
  return events;
}

export interface StatementRow {
  id: string;
  statement_number: string;
  total_amount?: number | null;
  created_at: string;
}

export function statementEvent(s: StatementRow, formatMoney: (n: number) => string): TimelineEvent {
  return {
    id: `statement-${s.id}`,
    at: s.created_at,
    group: "money",
    title: `Invoice ${s.statement_number} generated`,
    detail: s.total_amount != null ? formatMoney(s.total_amount) : null,
    actor: null,
    actorKind: "system",
    links: [{ label: s.statement_number, href: `/billing?statement=${s.id}` }],
  };
}

export interface PaymentRow {
  id: string;
  billing_statement_id: string;
  amount: number;
  payment_mode: string;
  created_at: string;
  razorpay_payment_id?: string | null;
  recorder?: Person;
}

export function paymentEvent(p: PaymentRow, statementNumber: string, formatMoney: (n: number) => string): TimelineEvent {
  const online = !!p.razorpay_payment_id || p.payment_mode === "razorpay";
  return {
    id: `payment-${p.id}`,
    at: p.created_at,
    group: "money",
    title: `Payment ${formatMoney(p.amount)} received`,
    detail: `${p.payment_mode.toUpperCase()}${online ? " (paid online)" : ""}`,
    actor: online ? null : (p.recorder?.full_name ?? null),
    actorKind: online ? "customer" : "team",
    links: [{ label: statementNumber, href: `/billing?statement=${p.billing_statement_id}` }],
  };
}

/** Newest first; events with the same instant keep a stable order. */
export function sortTimeline(events: TimelineEvent[]): TimelineEvent[] {
  return [...events].sort((a, b) => {
    const d = Date.parse(b.at) - Date.parse(a.at);
    return d !== 0 ? d : a.id.localeCompare(b.id);
  });
}

/** The earliest follow-up still to do: what the page pins as the lead's next step. */
export function nextStep(activities: (ActivityRow & { is_follow_up_done?: boolean })[]) {
  const pending = activities
    .filter((a) => !a.is_follow_up_done && a.follow_up_date)
    .sort((a, b) => Date.parse(a.follow_up_date as string) - Date.parse(b.follow_up_date as string));
  const first = pending[0];
  return first
    ? { activity_id: first.id, due_at: first.follow_up_date as string, notes: first.follow_up_notes ?? null, subject: first.subject ?? null }
    : null;
}
