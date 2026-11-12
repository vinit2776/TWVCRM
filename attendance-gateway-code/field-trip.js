'use strict';

// Rules for multi-stop field trips: which stops are acceptable, how the road route
// through them is read back from LocationIQ, what a trip pays at the rate per km, and
// which photos may be attached. Kept free of the database and the network so the
// money and validation rules can be tested on their own (test/field-trip.test.js).

const MAX_STOPS_LIMIT = 20;        // LocationIQ routes at most 25 points; a round trip adds one
const DEFAULT_MAX_STOPS = 10;
const MAX_ADDRESS_LENGTH = 300;
const MAX_PHOTOS = 6;
const MAX_PHOTO_BYTES = 500 * 1024; // after the phone shrinks it to 1000px JPEG, ~150-300 KB
const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const BACKDATE_DAYS = 7;            // a trip can be logged up to a week after the day it happened

function isCoord(v, limit) {
  if (v === undefined || v === null || v === '') return false;
  const n = Number(v);
  return Number.isFinite(n) && Math.abs(n) <= limit;
}

// Raw stops from the browser -> { stops: [{ address, lat?, lon? }] } or { error }.
// A stop without a picked suggestion has no coordinates yet; the server geocodes it.
function cleanStops(raw, maxStops = DEFAULT_MAX_STOPS) {
  if (!Array.isArray(raw)) return { error: 'Add at least a starting point and one more stop.' };
  const cap = Math.min(Math.max(2, Number(maxStops) || DEFAULT_MAX_STOPS), MAX_STOPS_LIMIT);
  if (raw.length > cap) return { error: `A trip can have at most ${cap} stops.` };
  const stops = [];
  for (let i = 0; i < raw.length; i++) {
    const s = raw[i] || {};
    const address = String(s.address == null ? '' : s.address).trim();
    if (!address) return { error: `Stop ${i + 1} is empty. Fill it in or remove it.` };
    if (address.length > MAX_ADDRESS_LENGTH) return { error: `Stop ${i + 1} is too long.` };
    const stop = { address };
    if (isCoord(s.lat, 90) && isCoord(s.lon, 180)) { stop.lat = Number(s.lat); stop.lon = Number(s.lon); }
    stops.push(stop);
  }
  if (stops.length < 2) return { error: 'Add at least a starting point and one more stop.' };
  return { stops };
}

// The points actually driven: the stops in order, plus the first stop again for a round trip.
function routePoints(stops, roundTrip) {
  return roundTrip && stops.length >= 2 ? [...stops, stops[0]] : [...stops];
}

// LocationIQ Directions (OSRM) path segment: "lon,lat;lon,lat;..."
function directionsCoords(points) {
  return points.map(p => `${p.lon},${p.lat}`).join(';');
}

// LocationIQ Directions response -> { distanceKm, legsKm: [..], durationSec }.
// legsKm[i] is the road distance from point i to point i+1.
function parseRouteLegs(data, pointCount) {
  if (!data || data.code !== 'Ok' || !Array.isArray(data.routes) || !data.routes.length) {
    throw new Error('No driving route found between those places.');
  }
  const r = data.routes[0];
  const legs = Array.isArray(r.legs) ? r.legs : [];
  if (legs.length !== pointCount - 1) throw new Error('The maps service returned an incomplete route. Try again.');
  const legsKm = legs.map(l => round2((Number(l.distance) || 0) / 1000));
  return { distanceKm: round2((Number(r.distance) || 0) / 1000), legsKm, durationSec: Number(r.duration) || null };
}

function round2(n) { return Math.round(n * 100) / 100; }

// Rate setting -> a number of rupees per km (0 = amounts switched off).
function parseRate(raw) {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? round2(n) : 0;
}
function validateRate(raw) {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? null : 'Rate per km must be a number of rupees between 0 and 100.';
}
function parseMaxStops(raw) {
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) && n >= 2 ? Math.min(n, MAX_STOPS_LIMIT) : DEFAULT_MAX_STOPS;
}
function validateMaxStops(raw) {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 2 && n <= MAX_STOPS_LIMIT ? null : `Maximum stops must be a whole number between 2 and ${MAX_STOPS_LIMIT}.`;
}

// What a trip pays, to the paisa, or null when no rate is set.
function reimbursement(distanceKm, ratePerKm) {
  const rate = Number(ratePerKm);
  if (!Number.isFinite(rate) || rate <= 0) return null;
  return round2((Number(distanceKm) || 0) * rate);
}

function formatInr(amount) {
  if (amount === null || amount === undefined || !Number.isFinite(Number(amount))) return '';
  const n = Number(amount);
  const whole = Math.round(n * 100) % 100 === 0;
  return '₹' + n.toLocaleString('en-IN', { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 });
}

// The day the trip happened: YYYY-MM-DD, not in the future, at most BACKDATE_DAYS back.
// today is the server's YYYY-MM-DD. Blank means today.
function cleanTripDate(raw, today) {
  const value = String(raw == null ? '' : raw).trim() || today;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(new Date(`${value}T00:00:00Z`).getTime())) {
    return { error: 'Pick the date of the trip.' };
  }
  if (value > today) return { error: "The trip date can't be in the future." };
  const earliest = new Date(`${today}T00:00:00Z`);
  earliest.setUTCDate(earliest.getUTCDate() - BACKDATE_DAYS);
  if (value < earliest.toISOString().slice(0, 10)) return { error: `Trips can be logged up to ${BACKDATE_DAYS} days after the day they happened.` };
  return { value };
}

// Photos from the browser -> { photos: [{ filename, contentType, data: Buffer }] } or { error }.
function cleanPhotos(raw, { required = false } = {}) {
  const list = Array.isArray(raw) ? raw : [];
  if (list.length > MAX_PHOTOS) return { error: `Attach at most ${MAX_PHOTOS} photos.` };
  if (required && !list.length) return { error: 'Attach at least one photo of the trip.' };
  const photos = [];
  for (const p of list) {
    const contentType = String((p && p.content_type) || '').toLowerCase();
    if (!PHOTO_TYPES.includes(contentType)) return { error: 'Photos must be JPEG, PNG or WebP images.' };
    const b64 = String((p && p.data_base64) || '');
    if (!b64 || !/^[A-Za-z0-9+/=\s]+$/.test(b64)) return { error: 'A photo could not be read. Remove it and add it again.' };
    const data = Buffer.from(b64, 'base64');
    if (!data.length) return { error: 'A photo could not be read. Remove it and add it again.' };
    if (data.length > MAX_PHOTO_BYTES) return { error: 'A photo is too large. Remove it and add it again.' };
    const filename = String((p && p.filename) || 'photo.jpg').replace(/[\r\n"\\/]/g, '').slice(0, 120) || 'photo.jpg';
    photos.push({ filename, contentType, data });
  }
  return { photos };
}

// Stops as stored on the trip row (JSON), or a two-stop list built from from/to for
// trips recorded before multi-stop existed.
function tripStops(trip) {
  if (trip && trip.stops) {
    try {
      const parsed = JSON.parse(trip.stops);
      if (Array.isArray(parsed) && parsed.length) return parsed;
    } catch { /* fall through to from/to */ }
  }
  return [{ address: (trip && trip.from_address) || '' }, { address: (trip && trip.to_address) || '' }];
}

// Google Maps directions through the same points, so a manager can compare in one tap.
function googleMapsUrl(stops, roundTrip) {
  const pts = routePoints(stops, roundTrip).map(s =>
    (s.lat !== undefined && s.lon !== undefined) ? `${s.lat},${s.lon}` : encodeURIComponent(s.address || ''));
  return 'https://www.google.com/maps/dir/' + pts.join('/');
}

module.exports = {
  MAX_STOPS_LIMIT, DEFAULT_MAX_STOPS, MAX_PHOTOS, MAX_PHOTO_BYTES, BACKDATE_DAYS,
  cleanStops, routePoints, directionsCoords, parseRouteLegs, parseRate, validateRate,
  parseMaxStops, validateMaxStops, reimbursement, formatInr, cleanTripDate, cleanPhotos,
  tripStops, googleMapsUrl,
};
