// Helps stop the same physical unit being added to the asset register twice.
// A serial number is the strongest evidence; a shared model alone is only a prompt to ask.

const PLACEHOLDER_SERIALS = new Set(["na", "n/a", "none", "null", "nil", "unknown", "tbd", "-", "--"]);

/** A serial worth comparing, lower-cased with spaces removed; null for blanks and placeholders like "N/A". */
export function normaliseSerial(s: string | null | undefined): string | null {
  const v = (s ?? "").toLowerCase().replace(/\s+/g, "");
  if (v.length < 4 || PLACEHOLDER_SERIALS.has(v)) return null;
  return v;
}

const normaliseModel = (s: string | null | undefined) => (s ?? "").toLowerCase().replace(/[\s-]+/g, "");

export interface DuplicateCandidate {
  id: string;
  name: string;
  asset_code?: string | null;
  serial_number?: string | null;
  model?: string | null;
}

export interface DuplicateCheck {
  /** Already registered with this exact serial: the same unit. */
  sameSerial: DuplicateCandidate[];
  /** Same model, and no serial that proves it is a different unit: worth asking about. */
  sameModel: DuplicateCandidate[];
}

/**
 * Looks for assets a new unit may already be. `taken` holds assets already matched to another
 * unit in the same proposal, which cannot be this one.
 */
export function findPossibleDuplicates(
  unit: { serial: string | null; model: string | null },
  assets: DuplicateCandidate[],
  taken: ReadonlySet<string> = new Set(),
): DuplicateCheck {
  const serial = normaliseSerial(unit.serial);
  const model = normaliseModel(unit.model);
  const sameSerial = serial ? assets.filter((a) => normaliseSerial(a.serial_number) === serial) : [];
  const sameModel = model
    ? assets.filter((a) => {
        if (taken.has(a.id) || sameSerial.some((s) => s.id === a.id)) return false;
        if (normaliseModel(a.model) !== model) return false;
        // A different, real serial on the asset means it is another physical unit.
        const theirs = normaliseSerial(a.serial_number);
        return !(serial && theirs && theirs !== serial);
      })
    : [];
  return { sameSerial, sameModel };
}

/** The first cooling capacity written as "3 TR", "3.0 tons" or similar across the given texts, in tons. */
export function parseTonnage(...texts: Array<string | null | undefined>): number | null {
  for (const t of texts) {
    const m = (t ?? "").match(/(\d+(?:\.\d+)?)\s*(?:TR|tons?|tonnes?)\b/i);
    if (m) return Number(m[1]);
  }
  return null;
}

const contains = (a: string, b: string) => a.includes(b) || b.includes(a);

/**
 * Reasons a chosen asset may not be the unit the proposal lists. Only differences that can be
 * seen are reported: a missing serial, model or capacity on either side says nothing.
 */
export function describeUnitMismatch(
  unit: { serial: string | null; model: string | null; capacity: string | null },
  asset: { name: string; model?: string | null; serial_number?: string | null; notes?: string | null },
): string[] {
  const out: string[] = [];
  const us = normaliseSerial(unit.serial);
  const as = normaliseSerial(asset.serial_number);
  // A proposal often prints the model glued to the serial, so containment counts as the same.
  if (us && as && !contains(us, as)) out.push(`its serial number is ${asset.serial_number?.trim()}, the proposal says ${unit.serial?.trim()}`);
  const um = normaliseModel(unit.model);
  const am = normaliseModel(asset.model);
  if (um && am && !contains(um, am)) out.push(`its model is ${asset.model?.trim()}, the proposal says ${unit.model?.trim()}`);
  const uc = parseTonnage(unit.capacity);
  const ac = parseTonnage(asset.name, asset.model, asset.notes);
  if (uc !== null && ac !== null && Math.abs(uc - ac) > 0.05) out.push(`it looks like a ${ac} TR unit, but the proposal unit is ${uc} TR`);
  return out;
}
