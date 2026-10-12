// Pure rules for tying an electricity vendor bill to a location and connection when
// it is recorded. No I/O — the API route loads the facts and this decides, so the
// form and the server cannot disagree and every branch is unit-testable.
//
// Principle: the LOCATION is always chosen by the person recording the bill, from
// our own list. How the utility or landlord words the site is outside our control and
// is never the deciding factor. What the bill prints (a consumer number, a remembered
// name) is only used to (a) fill in the connection and (b) warn when it points
// somewhere other than what was chosen. A near match is never applied.

import { consumerKey, nameKey, type ConnectionLike } from "@/lib/electricity-connections";

/** Comparison key for a vendor's bill number: case, spacing and punctuation ignored. */
export function invoiceKey(value: string | null | undefined): string | null {
  const key = (value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  return key === "" ? null : key;
}

export interface VendorConnection extends ConnectionLike {
  location_name: string;
  /** For display only (e.g. "Main HT meter"); never used to match. */
  meter_label?: string | null;
}

export type MatchVia = "consumer_number" | "name";

export type ConnectionMatch =
  | { status: "none" }
  | { status: "match"; connection: VendorConnection; via: MatchVia[] }
  // The consumer number points at one connection and the printed name at another.
  | { status: "conflict"; byNumber: VendorConnection; byName: VendorConnection };

/**
 * Which active connection of this vendor the bill's own identifiers point to.
 * Uniqueness of numbers and names per vendor (enforced when connections are saved)
 * means each identifier names at most one connection, so the only ambiguity is the
 * number and the name disagreeing — reported as a conflict, never resolved silently.
 */
export function matchConnection(
  connections: readonly VendorConnection[],
  bill: { consumer_number: string | null | undefined; printed_name: string | null | undefined }
): ConnectionMatch {
  const nk = consumerKey(bill.consumer_number);
  const wk = nameKey(bill.printed_name);
  const active = connections.filter((c) => c.is_active);

  const byNumber = nk ? active.find((c) => consumerKey(c.consumer_number) === nk) : undefined;
  const byName = wk ? active.find((c) => c.bill_aliases.some((a) => nameKey(a) === wk)) : undefined;

  if (!byNumber && !byName) return { status: "none" };
  if (byNumber && byName && byNumber.id !== byName.id) return { status: "conflict", byNumber, byName };
  const connection = (byNumber ?? byName)!;
  const via: MatchVia[] = [];
  if (byNumber) via.push("consumer_number");
  if (byName) via.push("name");
  return { status: "match", connection, via };
}

export interface ElectricityBillInput {
  location_id: string | null;
  connection_id: string | null;
  consumer_number: string | null;
  printed_name: string | null;
  /** The person confirmed the bill is for the chosen location despite what it prints. */
  acknowledge_mismatch: boolean;
  /** Teach the connection this wording so the next bill carrying it matches by itself. */
  remember_name: boolean;
}

export interface ElectricityContextFacts {
  vendorIsElectricityProvider: boolean;
  /** A PO-linked bill takes its location from the PO, so none is asked for. */
  hasPo: boolean;
  billCompanyId: string | null;
  location: { id: string; name: string; company_id: string | null; is_active: boolean } | null;
  /** The vendor's active connections, at every location. */
  connections: readonly VendorConnection[];
}

export interface ElectricityBillExtra {
  location_id: string;
  connection_id: string | null;
  electricity_consumer_number: string | null;
  electricity_printed_name: string | null;
}

/** A wording to add to a connection's remembered names after the bill is saved. */
export type RememberName = { connection_id: string; name: string } | null;

export type ElectricityDecision =
  | { ok: false; status: number; code: string; error: string }
  | {
      ok: true;
      /** null = not an electricity bill; nothing extra is stored. */
      extra: ElectricityBillExtra | null;
      rememberName: RememberName;
    };

const blank = (v: string | null | undefined) => {
  const t = (v ?? "").trim();
  return t === "" ? null : t;
};

const fail = (status: number, code: string, error: string): ElectricityDecision => ({ ok: false, status, code, error });

export function decideElectricityContext(input: ElectricityBillInput, facts: ElectricityContextFacts): ElectricityDecision {
  // Ordinary bills, and PO-linked bills, are none of this feature's business.
  if (!facts.vendorIsElectricityProvider || facts.hasPo) return { ok: true, extra: null, rememberName: null };

  if (!input.location_id) {
    return fail(422, "location_required", "Choose the location this electricity bill is for.");
  }
  const location = facts.location;
  if (!location || location.id !== input.location_id) return fail(422, "location_not_found", "That location was not found.");
  if (!location.is_active) return fail(422, "location_inactive", `${location.name} is not an active location.`);
  if (facts.billCompanyId && location.company_id && location.company_id !== facts.billCompanyId) {
    return fail(422, "company_mismatch", `${location.name} belongs to a different company from this bill. Pick the right company or location.`);
  }

  const consumer_number = blank(input.consumer_number);
  const printed_name = blank(input.printed_name);
  const here = facts.connections.filter((c) => c.is_active && c.location_id === location.id);

  let connectionId: string | null = null;
  if (input.connection_id) {
    const chosen = facts.connections.find((c) => c.id === input.connection_id && c.is_active);
    if (!chosen) return fail(422, "connection_not_found", "That connection was not found for this vendor.");
    if (chosen.location_id !== location.id) {
      return fail(422, "connection_location_mismatch", `That connection belongs to ${chosen.location_name}, not ${location.name}.`);
    }
    connectionId = chosen.id;
  }

  const match = matchConnection(facts.connections, { consumer_number, printed_name });

  if (match.status === "conflict") {
    if (!input.acknowledge_mismatch) {
      return fail(
        409,
        "identifier_conflict",
        `The consumer number on this bill belongs to ${match.byNumber.location_name}, but the name belongs to ${match.byName.location_name}. ` +
          `Confirm that this bill is for ${location.name} to continue.`
      );
    }
  } else if (match.status === "match") {
    const matchedHere = match.connection.location_id === location.id;
    if (!matchedHere && !input.acknowledge_mismatch) {
      const what = match.via.includes("consumer_number") ? "consumer number" : "name";
      return fail(
        409,
        "location_mismatch",
        `The ${what} on this bill belongs to ${match.connection.location_name}, but you chose ${location.name}. ` +
          `Confirm that this bill is for ${location.name} to continue.`
      );
    }
    if (matchedHere) {
      if (connectionId && connectionId !== match.connection.id && !input.acknowledge_mismatch) {
        return fail(
          409,
          "connection_mismatch",
          `The bill's ${match.via.includes("consumer_number") ? "consumer number" : "name"} identifies a different connection at ${location.name} ` +
            `than the one you picked. Confirm to continue.`
        );
      }
      connectionId = connectionId ?? match.connection.id;
    }
  }

  // Exactly one connection at the chosen location is unambiguous even with nothing printed to match.
  if (!connectionId && here.length === 1 && match.status === "none") connectionId = here[0].id;

  // Only teach a wording that is genuinely new for the connection it will be added to, and never one
  // that contradicted the consumer number (a conflict is a mistake to note, not a name to learn).
  let rememberName: RememberName = null;
  if (input.remember_name && printed_name && connectionId && match.status !== "conflict") {
    const connection = here.find((c) => c.id === connectionId);
    const alreadyKnown = connection?.bill_aliases.some((a) => nameKey(a) === nameKey(printed_name));
    if (connection && !alreadyKnown) rememberName = { connection_id: connectionId, name: printed_name };
  }

  return {
    ok: true,
    extra: {
      location_id: location.id,
      connection_id: connectionId,
      electricity_consumer_number: consumer_number,
      electricity_printed_name: printed_name,
    },
    rememberName,
  };
}
