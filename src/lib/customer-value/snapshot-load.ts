/**
 * Customer Value — reading a batch of customers' records for the snapshot job.
 *
 * Set-based, in three parallel rounds, instead of a loop of queries per
 * customer: contracts, invoices and bookings by customer; then everything keyed
 * by those ids; then the allocations and members of every contract at the
 * centers involved (ticket linking needs the whole center, not just this
 * batch). Every list is paged past PostgREST's 1,000-row cap and chunked for
 * `in (...)` filters. Read-only. The sorting-out of rows into customers happens
 * in `snapshot-assemble.ts`, which is pure and tested.
 *
 * Door-access data is not loaded yet, so seats used stays unknown.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { JourneyContractRow } from "@/lib/customer-value/journey";
import type { MoneyPaymentRow } from "@/lib/customer-value/money";
import type { RatePhaseInput } from "@/lib/rate-phase-dates";
import {
  fetchInChunks,
  isMissingColumnError,
  isMissingTableError,
  type PageResult,
} from "@/lib/customer-value/query-helpers";
import {
  assembleCustomers,
  type AssembledCustomer,
  type FetchedContract,
  type FetchedSnapshotData,
  type FetchedTicket,
} from "@/lib/customer-value/snapshot-assemble";

const CONTRACT_COLUMNS =
  "id, lead_id, location_id, contract_number, status, start_date, end_date, activated_at, terminated_at, seats, subtotal, " +
  "escalation_percentage, escalation_waived, escalation_approval_status, parent_contract_id, " +
  "renewal_sequence, days_extended, phase_start_date, renewal_declined, renewal_agreed_note";

type ContractRecord = Omit<JourneyContractRow, "rate_phases"> & { lead_id: string; location_id: string | null };
type PhaseRecord = RatePhaseInput & { contract_id: string };

/** Pages one `in (...)` lookup, ordered by id so pages never overlap or skip. */
function inQuery<T>(
  supabase: SupabaseClient,
  table: string,
  columns: string,
  column: string
) {
  return (batch: string[], from: number, to: number): PromiseLike<PageResult<T>> =>
    supabase
      .from(table)
      .select(columns)
      .in(column, batch)
      .order("id")
      .range(from, to)
      .returns<T[]>() as unknown as PromiseLike<PageResult<T>>;
}

/** Contracts for a set of customers, with their rate phases attached. */
async function loadContractsForLeads(supabase: SupabaseClient, leadIds: string[]): Promise<FetchedContract[]> {
  const records = await fetchInChunks<ContractRecord>("contracts", leadIds, inQuery(supabase, "contracts", CONTRACT_COLUMNS, "lead_id"));
  const phases = await fetchInChunks<PhaseRecord>(
    "contract rate phases",
    records.map((c) => c.id),
    inQuery(supabase, "contract_rate_phases", "id, contract_id, phase_order, duration_months, monthly_rate, end_date", "contract_id")
  );
  const byContract = new Map<string, RatePhaseInput[]>();
  for (const p of phases) {
    const list = byContract.get(p.contract_id) ?? [];
    list.push({
      phase_order: p.phase_order,
      duration_months: p.duration_months,
      monthly_rate: Number(p.monthly_rate),
      end_date: p.end_date ?? null,
    });
    byContract.set(p.contract_id, list);
  }
  return records.map((c) => ({ ...c, rate_phases: byContract.get(c.id) ?? [] }));
}

const TICKET_COLUMNS =
  "id, location_id, reported_at, space_unit_id, reporter_email, reporter_phone, sla_breached, reopen_count, satisfaction_rating";

/**
 * Tickets at these centers. Reads the explicit customer (`contract_id`, migration
 * 00621) when the column exists; in a database without it, falls back to the
 * older columns so the nightly run never fails over a missing migration.
 */
async function loadTickets(supabase: SupabaseClient, locationIds: string[]): Promise<FetchedTicket[]> {
  try {
    return await fetchInChunks<FetchedTicket>("tickets", locationIds, inQuery(supabase, "facility_issues", `${TICKET_COLUMNS}, contract_id`, "location_id"));
  } catch (err) {
    if (!isMissingColumnError(err)) throw err;
    return fetchInChunks<FetchedTicket>("tickets", locationIds, inQuery(supabase, "facility_issues", TICKET_COLUMNS, "location_id"));
  }
}

/** Reads everything the snapshot builder needs for these customers. */
export async function fetchSnapshotData(supabase: SupabaseClient, leadIds: string[]): Promise<FetchedSnapshotData> {
  // Round 1: keyed by customer.
  const [contracts, statements, bookings] = await Promise.all([
    loadContractsForLeads(supabase, leadIds),
    fetchInChunks<FetchedSnapshotData["statements"][number]>(
      "invoices",
      leadIds,
      inQuery(supabase, "billing_statements", "id, lead_id, period_start, subtotal, total_amount, status, due_date, finalized_at", "lead_id")
    ),
    fetchInChunks<FetchedSnapshotData["bookings"][number]>(
      "bookings",
      leadIds,
      inQuery(supabase, "bookings", "id, lead_id, booking_date, status", "lead_id")
    ),
  ]);

  const statementIds = statements.map((s) => s.id);
  const contractIds = contracts.map((c) => c.id);
  const bookingIds = bookings.map((b) => b.id);
  const locationIds = [...new Set(contracts.map((c) => c.location_id).filter((l): l is string => Boolean(l)))];

  // Round 2: keyed by round 1's ids.
  const [
    payments,
    reminders,
    creditNotes,
    billingQueries,
    rentWaivers,
    moratoriums,
    bookingWaivers,
    refunds,
    directoryContracts,
    tickets,
  ] = await Promise.all([
    fetchInChunks<MoneyPaymentRow>(
      "payments",
      statementIds,
      inQuery(supabase, "billing_payments", "id, billing_statement_id, amount, tds_amount, payment_date, created_at", "billing_statement_id")
    ),
    fetchInChunks<FetchedSnapshotData["reminders"][number]>(
      "reminders",
      statementIds,
      inQuery(supabase, "billing_reminder_sends", "id, billing_statement_id, sent_at, status", "billing_statement_id")
    ),
    fetchInChunks<FetchedSnapshotData["creditNotes"][number]>(
      "credit notes",
      statementIds,
      inQuery(
        supabase,
        "credit_note_uploads",
        "id, billing_statement_id, credit_note_amount, credit_note_date, credit_note_number, reason, superseded_by",
        "billing_statement_id"
      )
    ),
    // Billing queries are optional: if the table does not exist here, they are unknown, not zero.
    fetchInChunks<NonNullable<FetchedSnapshotData["billingQueries"]>[number]>(
      "billing queries",
      statementIds,
      inQuery(supabase, "billing_queries", "id, billing_statement_id, created_at", "billing_statement_id")
    ).catch((err: unknown) => {
      if (isMissingTableError(err)) return null;
      throw err;
    }),
    fetchInChunks<FetchedSnapshotData["rentWaivers"][number]>(
      "rent waivers",
      contractIds,
      inQuery(supabase, "contract_rent_waivers", "id, contract_id, waived_month, reason, revoked_at, waiver_kind", "contract_id")
    ),
    fetchInChunks<FetchedSnapshotData["moratoriums"][number]>(
      "moratoriums",
      contractIds,
      inQuery(supabase, "contract_billing_moratoriums", "id, contract_id, moratorium_month, reason, status, overridden_at", "contract_id")
    ),
    fetchInChunks<FetchedSnapshotData["bookingWaivers"][number]>(
      "booking waivers",
      bookingIds,
      inQuery(supabase, "waiver_requests", "id, booking_id, waiver_type, waiver_amount, status, approved_at, created_at, note", "booking_id")
    ),
    fetchInChunks<FetchedSnapshotData["refunds"][number]>(
      "refunds",
      bookingIds,
      inQuery(supabase, "refund_requests", "id, booking_id, amount_requested, status, processed_at, requested_at, reason", "booking_id")
    ),
    fetchInChunks<FetchedSnapshotData["directoryContracts"][number]>(
      "center contracts",
      locationIds,
      inQuery(supabase, "contracts", "id, lead_id, location_id", "location_id")
    ),
    loadTickets(supabase, locationIds),
  ]);

  // Round 3: the center's allocations and members, for ticket linking.
  const directoryIds = directoryContracts.map((c) => c.id);
  const [allocations, members] = await Promise.all([
    fetchInChunks<FetchedSnapshotData["allocations"][number]>(
      "allocations",
      directoryIds,
      inQuery(supabase, "contract_space_allocations", "id, contract_id, space_unit_id, start_date, end_date", "contract_id")
    ),
    fetchInChunks<FetchedSnapshotData["members"][number]>(
      "members",
      directoryIds,
      inQuery(supabase, "contract_members", "id, contract_id, email, phone", "contract_id")
    ),
  ]);

  return {
    contracts,
    statements,
    payments,
    reminders,
    rentWaivers,
    moratoriums,
    bookings,
    bookingWaivers,
    refunds,
    creditNotes,
    tickets,
    directoryContracts,
    allocations,
    members,
    billingQueries,
  };
}

/** Reads and assembles a batch of customers, ready for `buildMonthlyRows`. */
export async function loadCustomers(
  supabase: SupabaseClient,
  leadIds: string[]
): Promise<Map<string, AssembledCustomer>> {
  return assembleCustomers(await fetchSnapshotData(supabase, leadIds), leadIds);
}
