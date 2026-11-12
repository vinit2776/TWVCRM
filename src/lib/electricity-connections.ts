// Pure rules for electricity connections: how identifiers are compared and what
// makes a connection valid. No I/O — the API routes feed it rows, so the rules are
// unit-testable and the UI and server cannot disagree.
//
// A connection is identified by whatever the vendor prints on its bills: a consumer
// number and/or "remembered names" (the wording used for the site). How a bill words
// the site is outside our control, so both are optional and only exact matches
// (after normalising) ever count.

export const MAX_ALIASES = 10;
export const MAX_ALIAS_LENGTH = 120;
export const MAX_CONSUMER_NUMBER_LENGTH = 60;

/**
 * Comparison key for a consumer number: lower-case letters and digits only. Must
 * stay identical to the generated `consumer_number_key` column (migration 00586) so
 * the unique index and this check always agree.
 */
export function consumerKey(value: string | null | undefined): string | null {
  const key = (value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  return key === "" ? null : key;
}

/**
 * Comparison key for a remembered name: case, spacing and punctuation ignored, but
 * letters of any script kept, so a name in Tamil or Hindi is not collapsed to nothing.
 */
export function nameKey(value: string | null | undefined): string | null {
  const key = (value ?? "").normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  return key === "" ? null : key;
}

/** Trim, drop blanks, and drop repeats (by comparison key) while keeping the first wording. */
export function cleanAliases(aliases: readonly string[] | null | undefined): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of aliases ?? []) {
    const trimmed = raw.trim().replace(/\s+/g, " ");
    const key = nameKey(trimmed);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

export interface ConnectionLike {
  id: string;
  location_id: string;
  vendor_id: string;
  consumer_number: string | null;
  bill_aliases: string[];
  is_active: boolean;
}

export interface CandidateConnection {
  vendor_id: string;
  consumer_number: string | null;
  bill_aliases: string[];
}

export type Conflict =
  | { kind: "consumer_number"; with: ConnectionLike }
  | { kind: "alias"; alias: string; with: ConnectionLike };

/**
 * Identifiers the candidate would share with another active connection of the same
 * vendor, anywhere. A consumer number or a remembered name must point at exactly one
 * connection, or a bill carrying it could not be told which location it belongs to.
 * `selfId` is excluded so a connection can be edited without conflicting with itself.
 */
export function findConflicts(existing: readonly ConnectionLike[], candidate: CandidateConnection, selfId?: string): Conflict[] {
  const conflicts: Conflict[] = [];
  const myNumber = consumerKey(candidate.consumer_number);
  const myNames = new Map<string, string>();
  for (const a of cleanAliases(candidate.bill_aliases)) myNames.set(nameKey(a)!, a);

  for (const other of existing) {
    if (!other.is_active || other.vendor_id !== candidate.vendor_id || other.id === selfId) continue;
    if (myNumber && consumerKey(other.consumer_number) === myNumber) {
      conflicts.push({ kind: "consumer_number", with: other });
    }
    for (const a of other.bill_aliases) {
      const k = nameKey(a);
      if (k && myNames.has(k)) conflicts.push({ kind: "alias", alias: myNames.get(k)!, with: other });
    }
  }
  return conflicts;
}

export interface ConnectionCheck {
  errors: string[];
  warnings: string[];
}

/** Rules that need no database: shape limits, and the identifier warning. */
export function checkConnectionInput(input: {
  consumer_number: string | null;
  bill_aliases: readonly string[];
  sanctioned_kva: number | null;
}): ConnectionCheck {
  const errors: string[] = [];
  const warnings: string[] = [];
  const number = (input.consumer_number ?? "").trim();
  if (number.length > MAX_CONSUMER_NUMBER_LENGTH) errors.push(`Consumer number is too long (max ${MAX_CONSUMER_NUMBER_LENGTH} characters).`);
  const aliases = cleanAliases(input.bill_aliases);
  if (aliases.length > MAX_ALIASES) errors.push(`At most ${MAX_ALIASES} remembered names.`);
  if (aliases.some((a) => a.length > MAX_ALIAS_LENGTH)) errors.push(`A remembered name is too long (max ${MAX_ALIAS_LENGTH} characters).`);
  if (input.sanctioned_kva != null && !(input.sanctioned_kva > 0)) errors.push("Sanctioned demand must be greater than zero.");
  if (!consumerKey(number) && aliases.length === 0) {
    warnings.push("No consumer number or remembered name: bills for this connection will never be recognised automatically — you will choose the location each time.");
  }
  return { errors, warnings };
}

/** Human sentence for a conflict, naming where the identifier is already used. */
export function describeConflict(c: Conflict, locationName: (id: string) => string): string {
  const where = locationName(c.with.location_id);
  return c.kind === "consumer_number"
    ? `Consumer number ${c.with.consumer_number} already belongs to a connection at ${where}. A number can belong to only one connection per vendor.`
    : `The name “${c.alias}” is already remembered for a connection at ${where}. A name can point to only one connection per vendor.`;
}
