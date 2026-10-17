/**
 * Customer Value — linking facility tickets to a customer.
 *
 * `facility_issues` has no customer column, so a ticket is tied to a customer
 * indirectly (docs/plans/customer-value-phase2.md, section 2.1). The rules are
 * deliberately conservative: a ticket that cannot be tied to exactly one
 * customer is left unlinked and shows up in the coverage figure, instead of
 * being guessed onto someone and counted against them.
 *
 *   1. By space: the ticket names a space unit that exactly one customer held
 *      on the day it was reported.
 *   2. By reporter: the reporter's email or phone belongs to a member of exactly
 *      one customer (or, if several customers held the unit, of exactly one of
 *      those).
 *   3. Otherwise: unlinked.
 *
 * Pure module: no database, no clock.
 */

export interface LinkableTicket {
  id: string;
  /** ISO timestamp. */
  reported_at: string;
  space_unit_id: string | null;
  reporter_email: string | null;
  reporter_phone: string | null;
}

export interface TicketDirectory {
  /** Customers' dated claims on space units. `end_date` null means still held. */
  allocations: Array<{ lead_id: string; space_unit_id: string; start_date: string; end_date: string | null }>;
  /** People enrolled under each customer's contracts. */
  members: Array<{ lead_id: string; email: string | null; phone: string | null }>;
}

export type TicketLinkVia = "allocation" | "reporter";

export interface TicketLink {
  leadId: string | null;
  via: TicketLinkVia | null;
}

export function normalizeEmail(email: string | null | undefined): string | null {
  const e = (email ?? "").trim().toLowerCase();
  return e.includes("@") ? e : null;
}

/** The last ten digits of a phone number, or null if there are fewer than ten. */
export function normalizePhone(phone: string | null | undefined): string | null {
  const digits = (phone ?? "").replace(/\D/g, "");
  return digits.length >= 10 ? digits.slice(-10) : null;
}

/** The IST date of an ISO timestamp. */
function istDate(iso: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date(iso));
}

/** The one customer a reporter belongs to among `allowed` (or anyone if `allowed` is null); null if none or several. */
function customerByReporter(
  ticket: LinkableTicket,
  members: TicketDirectory["members"],
  allowed: Set<string> | null
): string | null {
  const email = normalizeEmail(ticket.reporter_email);
  const phone = normalizePhone(ticket.reporter_phone);
  if (!email && !phone) return null;

  const matches = new Set<string>();
  for (const m of members) {
    if (allowed && !allowed.has(m.lead_id)) continue;
    if ((email && normalizeEmail(m.email) === email) || (phone && normalizePhone(m.phone) === phone)) {
      matches.add(m.lead_id);
    }
  }
  return matches.size === 1 ? [...matches][0] : null;
}

/** Ties each ticket to a customer where that can be done without guessing. */
export function linkTickets(tickets: LinkableTicket[], dir: TicketDirectory): Map<string, TicketLink> {
  const allocationsByUnit = new Map<string, TicketDirectory["allocations"]>();
  for (const a of dir.allocations) {
    const list = allocationsByUnit.get(a.space_unit_id) ?? [];
    list.push(a);
    allocationsByUnit.set(a.space_unit_id, list);
  }

  const result = new Map<string, TicketLink>();
  for (const t of tickets) {
    const reportedOn = istDate(t.reported_at);

    let holders: Set<string> | null = null;
    if (t.space_unit_id) {
      const covering = (allocationsByUnit.get(t.space_unit_id) ?? []).filter(
        (a) => a.start_date <= reportedOn && (a.end_date === null || reportedOn <= a.end_date)
      );
      holders = new Set(covering.map((a) => a.lead_id));
    }

    if (holders && holders.size === 1) {
      result.set(t.id, { leadId: [...holders][0], via: "allocation" });
      continue;
    }

    // Several customers held the unit, or none did: the reporter decides, but
    // only among the holders when there are any.
    const byReporter = customerByReporter(t, dir.members, holders && holders.size > 1 ? holders : null);
    result.set(t.id, byReporter ? { leadId: byReporter, via: "reporter" } : { leadId: null, via: null });
  }
  return result;
}

/** Share of tickets that were tied to a customer, 0 to 1; null when there were no tickets. */
export function ticketLinkCoverage(links: Map<string, TicketLink>): number | null {
  if (links.size === 0) return null;
  let linked = 0;
  for (const l of links.values()) if (l.leadId) linked += 1;
  return linked / links.size;
}
