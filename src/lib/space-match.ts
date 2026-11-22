// Does free space now fit an enquiry waiting for it? Same centre, a type that fits, and enough seats
// free from the date they want to start, for at least a month (so a cabin about to be taken again
// next week does not count). Pure: the cron loads the units and allocations and calls this.

export type SpaceUnitType = "hot_desk" | "dedicated_desk" | "private_cabin" | "managed_office" | "business_centre";

export interface SpaceUnit {
  id: string;
  locationId: string;
  type: SpaceUnitType;
  /** Seats the unit holds. */
  capacity: number;
  isActive: boolean;
}

export interface SpaceAllocation {
  unitId: string;
  /** yyyy-MM-dd */
  startDate: string;
  /** yyyy-MM-dd, or null for open-ended. */
  endDate: string | null;
  status: "active" | "ended";
}

/** How long a unit must stay free from the start date to count. */
export const MIN_FREE_DAYS = 30;

/** Mode: `off` does nothing, `dry_run` only reports matches, `live` flags them and tells people. Unknown reads as dry_run. */
export const MATCH_MODES = ["off", "dry_run", "live"] as const;
export type MatchMode = (typeof MATCH_MODES)[number];
export function parseMatchMode(value: string | null | undefined): MatchMode {
  return (MATCH_MODES as readonly string[]).includes(value ?? "") ? (value as MatchMode) : "dry_run";
}

/** The lead's workspace type as the kind of unit that would hold it; `any` when they did not say, `none` when no unit fits (a virtual office, a meeting room). */
export function unitTypesFor(workspaceType: string | null | undefined): SpaceUnitType[] | "any" | "none" {
  if (!workspaceType) return "any";
  switch (workspaceType) {
    case "hot_desk":
      return ["hot_desk"];
    case "dedicated_desk":
      return ["dedicated_desk"];
    case "private_office":
      return ["private_cabin"];
    case "managed":
      return ["managed_office"];
    default:
      return "none";
  }
}

/** Types where the whole group has to sit in one unit (a cabin), not be spread over several (desks). */
const ONE_UNIT_TYPES: SpaceUnitType[] = ["private_cabin", "managed_office"];

function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
}

/** Units that are free from `from` for MIN_FREE_DAYS: no active allocation overlaps that window. */
export function freeUnits(units: SpaceUnit[], allocations: SpaceAllocation[], from: string): SpaceUnit[] {
  const windowEnd = addDays(from, MIN_FREE_DAYS);
  return units.filter((u) => {
    if (!u.isActive) return false;
    return !allocations.some(
      (a) => a.unitId === u.id && a.status === "active" && a.startDate <= windowEnd && (a.endDate === null || a.endDate >= from),
    );
  });
}

export interface ParkedWant {
  locationId: string | null;
  workspaceType: string | null;
  seatsNeeded: number | null;
}

export interface MatchResult {
  matched: boolean;
  /** Seats free that fit, for the note. */
  freeSeats: number;
  note: string;
}

/**
 * Whether the waiting enquiry now has space. An area with no centre (`locationId` null) never
 * matches; a business centre unit is hourly and never counts. `from` is the day they want to start
 * (today when it has passed or is not known).
 */
export function matchParked(want: ParkedWant, units: SpaceUnit[], allocations: SpaceAllocation[], from: string, centreName?: string | null): MatchResult {
  const none: MatchResult = { matched: false, freeSeats: 0, note: "" };
  if (!want.locationId) return none;
  const types = unitTypesFor(want.workspaceType);
  if (types === "none") return none;
  const seats = Math.max(1, want.seatsNeeded ?? 1);

  const candidates = units.filter(
    (u) => u.locationId === want.locationId && u.type !== "business_centre" && (types === "any" || types.includes(u.type)),
  );
  const free = freeUnits(candidates, allocations, from);
  const freeSeats = free.reduce((sum, u) => sum + u.capacity, 0);

  const needsOneUnit = types === "any" ? false : types.every((t) => ONE_UNIT_TYPES.includes(t));
  const fits = needsOneUnit ? free.some((u) => u.capacity >= seats) : freeSeats >= seats;
  if (!fits) return { matched: false, freeSeats, note: "" };

  const kind = types === "any" ? "space" : types.map((t) => t.replace(/_/g, " ")).join("/");
  return {
    matched: true,
    freeSeats,
    note: `${freeSeats} seat${freeSeats === 1 ? "" : "s"} of ${kind} free${centreName ? ` at ${centreName}` : ""} from ${from} for at least ${MIN_FREE_DAYS} days`,
  };
}
