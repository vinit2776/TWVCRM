/**
 * Customer Value — assembling each customer's raw data from fetched rows.
 *
 * The loader reads many tables for a batch of customers at once; this module,
 * pure and fully tested, sorts those rows into one `CustomerRaw` per customer
 * and works out what only makes sense across customers: which tickets belong to
 * whom (linking is per center, so it needs everyone at that center), and the
 * concessions that count. See docs/plans/customer-value-phase2.md, sections 2.1
 * and 5.
 *
 * Pure module: no database, no clock.
 */

import {
  contractRan,
  rentStepsForContract,
  type JourneyContractRow,
} from "@/lib/customer-value/journey";
import {
  buildConcessions,
  type MoneyConcessionInput,
  type MoneyPaymentRow,
} from "@/lib/customer-value/money";
import {
  monthStart,
  type CustomerRaw,
  type MonthlyRow,
  type RawBooking,
  type RawConcession,
  type RawReminder,
  type RawStatement,
  type RawTicket,
} from "@/lib/customer-value/monthly-metrics";
import {
  linkTickets,
  type LinkableTicket,
  type TicketDirectory,
} from "@/lib/customer-value/ticket-linking";

// ── What the loader fetches ─────────────────────────────────────────────

export type FetchedContract = JourneyContractRow & { lead_id: string; location_id: string | null };

export interface FetchedTicket extends LinkableTicket {
  location_id: string;
  sla_breached: boolean | null;
  reopen_count: number | null;
  satisfaction_rating: number | null;
}

export interface FetchedSnapshotData {
  contracts: FetchedContract[];
  statements: Array<RawStatement & { lead_id: string }>;
  payments: MoneyPaymentRow[];
  reminders: RawReminder[];
  rentWaivers: MoneyConcessionInput["rentWaivers"];
  moratoriums: MoneyConcessionInput["moratoriums"];
  bookings: Array<RawBooking & { id: string; lead_id: string }>;
  bookingWaivers: Array<MoneyConcessionInput["bookingWaivers"][number] & { booking_id: string }>;
  refunds: Array<MoneyConcessionInput["refunds"][number] & { booking_id: string }>;
  creditNotes: Array<MoneyConcessionInput["creditNotes"][number] & { billing_statement_id: string }>;
  /** Tickets at every location these customers have a contract at. */
  tickets: FetchedTicket[];
  /** Every contract at those locations, whoever the customer: needed so linking sees all of a center's customers. */
  directoryContracts: Array<{ id: string; lead_id: string; location_id: string | null }>;
  allocations: Array<{ contract_id: string; space_unit_id: string; start_date: string; end_date: string | null }>;
  members: Array<{ contract_id: string; email: string | null; phone: string | null }>;
  /** Null when billing queries could not be counted at all (table absent). */
  billingQueries: Array<{ billing_statement_id: string; created_at: string }> | null;
}

export interface AssembledCustomer {
  leadId: string;
  raw: CustomerRaw;
  /** Locations this customer has a contract at. */
  locationIds: string[];
  /** Share of those centers' tickets that could be tied to a customer, 0 to 1; null if they had no tickets. */
  ticketLinkCoverage: number | null;
}

function group<T>(items: T[], key: (item: T) => string | null | undefined): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    if (!k) continue;
    const list = map.get(k) ?? [];
    list.push(item);
    map.set(k, list);
  }
  return map;
}

/** The IST month key (`YYYY-MM-01`) of an ISO timestamp. */
function monthKeyOf(iso: string): string {
  return monthStart(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date(iso)));
}

/**
 * One `CustomerRaw` per requested customer. A customer with no contract and no
 * invoice still gets an entry (the builder will produce no rows for it).
 */
export function assembleCustomers(data: FetchedSnapshotData, leadIds: string[]): Map<string, AssembledCustomer> {
  const contractsByLead = group(data.contracts, (c) => c.lead_id);
  const statementsByLead = group(data.statements, (s) => s.lead_id);
  const bookingsByLead = group(data.bookings, (b) => b.lead_id);

  const leadOfStatement = new Map(data.statements.map((s) => [s.id, s.lead_id]));
  const leadOfContract = new Map(data.contracts.map((c) => [c.id, c.lead_id]));
  const leadOfBooking = new Map(data.bookings.map((b) => [b.id, b.lead_id]));

  const paymentsByLead = group(data.payments, (p) => leadOfStatement.get(p.billing_statement_id));
  const remindersByLead = group(data.reminders, (r) => leadOfStatement.get(r.billing_statement_id));
  const creditNotesByLead = group(data.creditNotes, (n) => leadOfStatement.get(n.billing_statement_id));
  const waiversByLead = group(data.rentWaivers, (w) => leadOfContract.get(w.contract_id));
  const moratoriumsByLead = group(data.moratoriums, (m) => leadOfContract.get(m.contract_id));
  const bookingWaiversByLead = group(data.bookingWaivers, (w) => leadOfBooking.get(w.booking_id));
  const refundsByLead = group(data.refunds, (r) => leadOfBooking.get(r.booking_id));
  const queriesByLead = data.billingQueries ? group(data.billingQueries, (q) => leadOfStatement.get(q.billing_statement_id)) : null;

  // ── Ticket linking, one center at a time ─────────────────────────────
  const contractLead = new Map(data.directoryContracts.map((c) => [c.id, c.lead_id]));
  const ticketsByLocation = group(data.tickets, (t) => t.location_id);

  const linkedByLead = new Map<string, FetchedTicket[]>();
  const unlinkedByLocationMonth = new Map<string, Record<string, number>>();
  const countsByLocation = new Map<string, { linked: number; total: number }>();

  for (const [locationId, tickets] of ticketsByLocation) {
    const contractIds = new Set(
      data.directoryContracts.filter((c) => c.location_id === locationId).map((c) => c.id)
    );
    const directory: TicketDirectory = {
      contracts: data.directoryContracts
        .filter((c) => contractIds.has(c.id))
        .map((c) => ({ id: c.id, lead_id: c.lead_id })),
      allocations: data.allocations
        .filter((a) => contractIds.has(a.contract_id) && contractLead.has(a.contract_id))
        .map((a) => ({
          lead_id: contractLead.get(a.contract_id) as string,
          space_unit_id: a.space_unit_id,
          start_date: a.start_date,
          end_date: a.end_date,
        })),
      members: data.members
        .filter((m) => contractIds.has(m.contract_id) && contractLead.has(m.contract_id))
        .map((m) => ({ lead_id: contractLead.get(m.contract_id) as string, email: m.email, phone: m.phone })),
    };

    const links = linkTickets(tickets, directory);
    const byMonth: Record<string, number> = {};
    let linked = 0;
    for (const t of tickets) {
      const link = links.get(t.id);
      if (link?.leadId) {
        linked += 1;
        const list = linkedByLead.get(link.leadId) ?? [];
        list.push(t);
        linkedByLead.set(link.leadId, list);
      } else {
        const m = monthKeyOf(t.reported_at);
        byMonth[m] = (byMonth[m] ?? 0) + 1;
      }
    }
    unlinkedByLocationMonth.set(locationId, byMonth);
    countsByLocation.set(locationId, { linked, total: tickets.length });
  }

  // ── One customer at a time ───────────────────────────────────────────
  const result = new Map<string, AssembledCustomer>();
  for (const leadId of leadIds) {
    const contracts = contractsByLead.get(leadId) ?? [];
    const locationIds = [...new Set(contracts.map((c) => c.location_id).filter((l): l is string => Boolean(l)))];

    const rentSteps = contracts.filter(contractRan).flatMap(rentStepsForContract);
    const counted = buildConcessions(
      {
        rentWaivers: waiversByLead.get(leadId) ?? [],
        moratoriums: moratoriumsByLead.get(leadId) ?? [],
        bookingWaivers: bookingWaiversByLead.get(leadId) ?? [],
        refunds: refundsByLead.get(leadId) ?? [],
        creditNotes: creditNotesByLead.get(leadId) ?? [],
        contractNumbers: Object.fromEntries(contracts.map((c) => [c.id, c.contract_number])),
      },
      rentSteps
    ).entries;
    const concessions: RawConcession[] = counted
      .filter((e) => e.counted && e.amount !== null && e.date)
      .map((e) => ({ date: e.date, amount: e.amount as number }));

    const tickets: RawTicket[] = (linkedByLead.get(leadId) ?? []).map((t) => ({
      id: t.id,
      reported_at: t.reported_at,
      sla_breached: t.sla_breached,
      reopen_count: t.reopen_count,
      satisfaction_rating: t.satisfaction_rating,
    }));

    const ticketsUnlinkedByMonth: Record<string, number> = {};
    let linkedTotal = 0;
    let allTotal = 0;
    for (const loc of locationIds) {
      for (const [m, n] of Object.entries(unlinkedByLocationMonth.get(loc) ?? {})) {
        ticketsUnlinkedByMonth[m] = (ticketsUnlinkedByMonth[m] ?? 0) + n;
      }
      const counts = countsByLocation.get(loc);
      if (counts) {
        linkedTotal += counts.linked;
        allTotal += counts.total;
      }
    }

    result.set(leadId, {
      leadId,
      locationIds,
      ticketLinkCoverage: allTotal > 0 ? linkedTotal / allTotal : null,
      raw: {
        contracts,
        statements: statementsByLead.get(leadId) ?? [],
        payments: paymentsByLead.get(leadId) ?? [],
        reminders: remindersByLead.get(leadId) ?? [],
        concessions,
        bookings: bookingsByLead.get(leadId) ?? [],
        tickets,
        ticketsUnlinkedByMonth,
        billingQueries: queriesByLead ? (queriesByLead.get(leadId) ?? []) : null,
        // Door data is not loaded yet; seats used stays unknown until it is.
        door: null,
      },
    });
  }
  return result;
}

// ── Storing ─────────────────────────────────────────────────────────────

/** The `customer_value_monthly` row for one month of one customer. */
export interface MonthlyRecord {
  lead_id: string;
  month: string;
  revenue_ex_gst: number;
  invoiced_count: number;
  avg_days_late: number | null;
  measured_count: number;
  on_time_count: number;
  overdue_amount: number;
  max_days_overdue: number;
  reminders: number;
  concessions_counted: number;
  seats_paid: number | null;
  seats_used_avg: number | null;
  rent_per_seat: number | null;
  tickets_linked: number;
  tickets_unlinked: number;
  tickets_sla_breached: number;
  tickets_reopened: number;
  satisfaction_avg: number | null;
  satisfaction_count: number;
  bookings: number;
  billing_queries: number | null;
  data_flags: Record<string, unknown>;
  computed_at: string;
}

/** Round to the precision the table needs, so identical inputs always store identically. */
function round(n: number | null, places: number): number | null {
  if (n === null) return null;
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

export function toMonthlyRecord(
  leadId: string,
  row: MonthlyRow,
  ticketCoverage: number | null,
  computedAt: string
): MonthlyRecord {
  return {
    lead_id: leadId,
    month: row.month,
    revenue_ex_gst: round(row.revenue_ex_gst, 2) as number,
    invoiced_count: row.invoiced_count,
    avg_days_late: round(row.avg_days_late, 2),
    measured_count: row.measured_count,
    on_time_count: row.on_time_count,
    overdue_amount: round(row.overdue_amount, 2) as number,
    max_days_overdue: row.max_days_overdue,
    reminders: row.reminders,
    concessions_counted: round(row.concessions_counted, 2) as number,
    seats_paid: round(row.seats_paid, 3),
    seats_used_avg: round(row.seats_used_avg, 3),
    rent_per_seat: round(row.rent_per_seat, 2),
    tickets_linked: row.tickets_linked,
    tickets_unlinked: row.tickets_unlinked,
    tickets_sla_breached: row.tickets_sla_breached,
    tickets_reopened: row.tickets_reopened,
    satisfaction_avg: round(row.satisfaction_avg, 2),
    satisfaction_count: row.satisfaction_count,
    bookings: row.bookings,
    billing_queries: row.billing_queries,
    data_flags: { ...row.data_flags, ticket_link_coverage: round(ticketCoverage, 3) },
    computed_at: computedAt,
  };
}
