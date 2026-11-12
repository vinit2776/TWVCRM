/**
 * Facility tickets — choosing which customer a ticket is about.
 *
 * Pure helpers behind the "Customer" field on the report wizard and the route
 * that feeds it: how a customer is labelled, how the list is searched, which
 * customer a space unit points to, and whether a chosen contract is acceptable
 * for a ticket. No database, no clock.
 */

/** The contract states a customer can be raising tickets under. */
export const TICKET_CONTRACT_STATUSES = ["active", "renewal_in_progress"] as const;

export interface TicketCustomerOption {
  contractId: string;
  leadId: string;
  contractNumber: string;
  /** Company if there is one, else the person's name. */
  customerName: string;
  /** Names or codes of the space units this contract holds today. */
  units: string[];
  /** Ids of the same units, for matching a chosen unit to a customer. */
  unitIds: string[];
}

export interface RawTicketContract {
  id: string;
  lead_id: string;
  contract_number: string;
  lead: { first_name: string | null; last_name: string | null; company: string | null } | null;
}

export function customerDisplayName(lead: RawTicketContract["lead"]): string {
  const company = lead?.company?.trim();
  if (company) return company;
  const person = [lead?.first_name, lead?.last_name].map((s) => s?.trim()).filter(Boolean).join(" ");
  return person || "Unnamed customer";
}

export interface HeldUnit {
  contract_id: string;
  space_unit_id: string;
  /** Shown name of the unit. */
  label: string;
  start_date: string;
  end_date: string | null;
}

/** Joins contracts with the units they hold on `today`, one option per contract, sorted by customer. */
export function buildCustomerOptions(contracts: RawTicketContract[], units: HeldUnit[], today: string): TicketCustomerOption[] {
  const held = new Map<string, HeldUnit[]>();
  for (const u of units) {
    if (u.start_date > today || (u.end_date !== null && u.end_date < today)) continue;
    const list = held.get(u.contract_id) ?? [];
    list.push(u);
    held.set(u.contract_id, list);
  }
  return contracts
    .map((c) => {
      const mine = held.get(c.id) ?? [];
      return {
        contractId: c.id,
        leadId: c.lead_id,
        contractNumber: c.contract_number,
        customerName: customerDisplayName(c.lead),
        units: [...new Set(mine.map((u) => u.label))],
        unitIds: [...new Set(mine.map((u) => u.space_unit_id))],
      };
    })
    .sort((a, b) => a.customerName.localeCompare(b.customerName) || a.contractNumber.localeCompare(b.contractNumber));
}

/** Case-insensitive search over customer, contract number and unit names. An empty query matches everything. */
export function searchCustomerOptions(options: TicketCustomerOption[], query: string): TicketCustomerOption[] {
  const q = query.trim().toLowerCase();
  if (!q) return options;
  return options.filter((o) =>
    [o.customerName, o.contractNumber, ...o.units].some((s) => s.toLowerCase().includes(q))
  );
}

/**
 * The contract to preselect when a space unit is chosen: the one customer
 * holding it today, or null when no one or several do (never a guess).
 */
export function customerForUnit(options: TicketCustomerOption[], unitId: string | null | undefined): TicketCustomerOption | null {
  if (!unitId) return null;
  const holders = options.filter((o) => o.unitIds.includes(unitId));
  return holders.length === 1 ? holders[0] : null;
}

export type ContractCheck =
  | { ok: true }
  | { ok: false; error: string };

/**
 * Whether `contract` may be attached to a ticket at `locationId`: it must exist,
 * be live, and belong to the ticket's center, so a ticket cannot be pinned on a
 * customer from somewhere else.
 */
export function checkTicketContract(
  contract: { id: string; status: string; location_id: string | null } | null,
  locationId: string
): ContractCheck {
  if (!contract) return { ok: false, error: "That customer's contract was not found" };
  if (!(TICKET_CONTRACT_STATUSES as readonly string[]).includes(contract.status)) {
    return { ok: false, error: "That contract is not active, so a ticket cannot be raised against it" };
  }
  if (contract.location_id !== locationId) {
    return { ok: false, error: "That customer is not at this location" };
  }
  return { ok: true };
}
