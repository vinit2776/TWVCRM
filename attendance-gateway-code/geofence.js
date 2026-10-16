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

// The branch a punch at `point` was made at. If it's inside the radius of the
// employee's own branch (`ownBranch`, a name), that's the one: branches can sit a few
// metres apart in the same building, closer than indoor GPS can tell apart, and the
// nearest one would otherwise be a coin toss. Otherwise it's the nearest branch whose
// radius it's inside, so two overlapping branches can't both claim it. Branches without
// a location are skipped. null means it wasn't at any branch.
function branchAt(point, branches, radiusMeters, ownBranch = null) {
  const own = ownBranch && branches.find(b => b.name === ownBranch);
  if (own && own.location && isWithinOffice(point, own.location, radiusMeters)) return own;
  let best = null, bestDistance = Infinity;
  for (const b of branches) {
    if (!b.location || !isWithinOffice(point, b.location, radiusMeters)) continue;
    const d = distanceMeters(point, b.location);
    if (d < bestDistance) { best = b; bestDistance = d; }
  }
  return best;
}

// Stored in employees.branch for someone who floats between branches.
const MULTI_BRANCH = '__multi__';

// Whether a punch at `branchName` is at a branch that isn't the employee's own. Anyone
// multi-branch, or with no branch set yet, belongs at every branch.
function isBranchDeviation(employeeBranch, branchName) {
  if (!branchName || !employeeBranch || employeeBranch === MULTI_BRANCH) return false;
  return employeeBranch !== branchName;
}

module.exports = { DEFAULT_OFFICE_RADIUS_METERS, MULTI_BRANCH, parseLatLng, distanceMeters, isWithinOffice, branchAt, isBranchDeviation };
