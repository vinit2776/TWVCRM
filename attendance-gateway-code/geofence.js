'use strict';

// Pure helpers for deciding which branch, if any, a Punch-button punch was made at. A
// web app can't read the WiFi name or BSSID, and the office's public IP isn't static,
// so "at a branch" means the phone's GPS position is within a radius of that branch.
// Kept out of server.js so they can be unit-tested without a database.

// Indoor GPS is often 20-50 m off, so the default leaves room for that.
const DEFAULT_OFFICE_RADIUS_METERS = 150;

// "lat, lng" -> { lat, lng }, or null if it isn't a real coordinate pair.
function parseLatLng(raw) {
  const m = String(raw || '').match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
  if (!m) return null;
  const lat = Number(m[1]), lng = Number(m[2]);
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}

// Great-circle distance in metres (haversine). Accurate to well under a metre at the
// few-hundred-metre scale this is used at.
function distanceMeters(a, b) {
  const R = 6371000;
  const rad = d => d * Math.PI / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Whether a punch at `point` is within `radiusMeters` of `office`. With no office
// location, nothing is.
function isWithinOffice(point, office, radiusMeters) {
  if (!point || !office || !(radiusMeters > 0)) return false;
  return distanceMeters(point, office) <= radiusMeters;
}

// The branch a punch at `point` was made at. If it's inside the radius of one of the
// employee's own branches (`employeeBranch`, as stored in employees.branch), the
// nearest of those is the one: branches can sit a few metres apart in the same
// building, closer than indoor GPS can tell apart, and the nearest branch overall
// would otherwise be a coin toss. Otherwise it's the nearest branch whose radius it's
// inside, so two overlapping branches can't both claim it. Branches without a location
// are skipped. null means it wasn't at any branch.
function branchAt(point, branches, radiusMeters, employeeBranch = null) {
  const own = employeeBranches(employeeBranch);
  const ownNearest = own.all ? null : nearestWithin(point, branches.filter(b => own.names.includes(b.name)), radiusMeters);
  return ownNearest || nearestWithin(point, branches, radiusMeters);
}
function nearestWithin(point, branches, radiusMeters) {
  let best = null, bestDistance = Infinity;
  for (const b of branches) {
    if (!b.location || !isWithinOffice(point, b.location, radiusMeters)) continue;
    const d = distanceMeters(point, b.location);
    if (d < bestDistance) { best = b; bestDistance = d; }
  }
  return best;
}

// Stored in employees.branch for someone at every branch ("All branches").
const MULTI_BRANCH = '__multi__';

// employees.branch holds one branch name, MULTI_BRANCH for all of them, or a JSON
// array of names for a chosen few. This reads any of those as { all, names }; no
// branch set yet is { all: false, names: [] }.
function employeeBranches(raw) {
  if (raw === MULTI_BRANCH) return { all: true, names: [] };
  const value = String(raw || '').trim();
  if (!value) return { all: false, names: [] };
  if (value.startsWith('[')) {
    try {
      const list = JSON.parse(value);
      if (Array.isArray(list)) return { all: false, names: [...new Set(list.map(n => String(n).trim()).filter(Boolean))] };
    } catch { /* not a list after all: treat it as one name */ }
  }
  return { all: false, names: [value] };
}

// The employees.branch value for a list of branch names: the bare name for one, a
// JSON array for several, null for none.
function employeeBranchValue(names) {
  const unique = [...new Set(names.map(n => String(n).trim()).filter(Boolean))];
  if (!unique.length) return null;
  return unique.length === 1 ? unique[0] : JSON.stringify(unique);
}

// employees.branch with branch `from` renamed to `to` (unchanged if it isn't there).
function renameEmployeeBranch(raw, from, to) {
  return renameEmployeeBranches(raw, new Map([[from, to]]));
}

// employees.branch with several branches renamed at once, `renames` being old name ->
// new name. Every name is mapped in a single pass, which is what makes a swap work:
// applying A->B and then B->A one after the other would walk an employee at A to B and
// straight back to A again.
function renameEmployeeBranches(raw, renames) {
  const { all, names } = employeeBranches(raw);
  if (all || !names.some(n => renames.has(n))) return raw;
  return employeeBranchValue(names.map(n => (renames.has(n) ? renames.get(n) : n)));
}

// How an employee's branches read on screen.
function employeeBranchLabel(raw) {
  const { all, names } = employeeBranches(raw);
  return all ? 'All branches' : names.join(', ');
}

// Whether a punch at `branchName` is at a branch that isn't one of the employee's
// own. Anyone at all branches, or with no branch set yet, belongs at every branch.
function isBranchDeviation(employeeBranch, branchName) {
  if (!branchName) return false;
  const { all, names } = employeeBranches(employeeBranch);
  if (all || !names.length) return false;
  return !names.includes(branchName);
}

module.exports = {
  DEFAULT_OFFICE_RADIUS_METERS, MULTI_BRANCH, parseLatLng, distanceMeters, isWithinOffice, branchAt,
  employeeBranches, employeeBranchValue, renameEmployeeBranch, renameEmployeeBranches, employeeBranchLabel, isBranchDeviation,
};
