/**
 * Session-scoped navigation trail used to power breadcrumbs that reflect the
 * path a user actually drilled through (e.g. Leads > Rohan Mehta > TWV-P-0045 > TWV-C-0112),
 * not just the URL's position in the route tree.
 *
 * Source pages push the destination's entry onto the trail right before navigating
 * to it (see usages in leads/proposals/contracts/billing pages). Destination pages
 * read the trail via PageBreadcrumb, which falls back to a fixed two-level crumb
 * (module > current page) when the stored trail doesn't end at the current path —
 * e.g. a pasted link, bookmark, or a fresh tab with no history.
 */

export type TrailEntry = {
  href: string;
  label: string;
};

const STORAGE_KEY = "twv_nav_trail";
const MAX_ENTRIES = 8;

function readTrail(): TrailEntry[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeTrail(trail: TrailEntry[]) {
  if (typeof window === "undefined") return;
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(trail.slice(-MAX_ENTRIES)));
  } catch {
    // sessionStorage unavailable (private mode, etc.) — breadcrumb falls back silently
  }
}

export function getTrail(): TrailEntry[] {
  return readTrail();
}

/** Call from a source page right before navigating to `entry.href`. */
export function pushTrailEntry(entry: TrailEntry) {
  const trail = readTrail();
  const existingIdx = trail.findIndex((e) => e.href === entry.href);
  const base = existingIdx >= 0 ? trail.slice(0, existingIdx) : trail;
  writeTrail([...base, entry]);
}

/** Call from a list/root page on mount to start a fresh trail. */
export function resetTrail(entry: TrailEntry) {
  writeTrail([entry]);
}

/** Overwrite the trail wholesale — used by PageBreadcrumb to self-heal a stale/fallback trail. */
export function seedTrail(entries: TrailEntry[]) {
  writeTrail(entries);
}
