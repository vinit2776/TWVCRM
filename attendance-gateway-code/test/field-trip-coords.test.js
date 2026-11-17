'use strict';

// A trip's amount is distance x rate and the distance comes from its stops' coordinates,
// so which coordinates the server is willing to take from the browser is a money rule.

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseViewbox, isInsideViewbox, stopNeedsGeocode } = require('../field-trip');

const CHENNAI = '79.95,12.75,80.35,13.35'; // the PLACES_VIEWBOX default
const box = parseViewbox(CHENNAI);

test('parseViewbox reads the setting in either corner order, and rejects junk', () => {
  assert.deepEqual(box, { minLon: 79.95, maxLon: 80.35, minLat: 12.75, maxLat: 13.35 });
  // the same box described from the opposite corner
  assert.deepEqual(parseViewbox('80.35,13.35,79.95,12.75'), box);
  for (const bad of ['', null, undefined, '79.95,12.75,80.35', 'a,b,c,d', '79.95 12.75 80.35 13.35']) {
    assert.equal(parseViewbox(bad), null, `expected null for ${JSON.stringify(bad)}`);
  }
});

test('isInsideViewbox includes the edges and excludes everything outside', () => {
  assert.ok(isInsideViewbox(13.0418, 80.2341, box));        // LGF
  assert.ok(isInsideViewbox(12.75, 79.95, box));            // exactly the corner
  assert.ok(!isInsideViewbox(28.6139, 77.209, box));        // Delhi
  assert.ok(!isInsideViewbox(13.0418, 77.5946, box));       // Bengaluru: same latitude band, wrong longitude
  assert.ok(!isInsideViewbox(13.0418, 80.2341, null));      // no box configured trusts nothing
});

test('a stop with no coordinates is always geocoded', () => {
  assert.ok(stopNeedsGeocode({ address: 'Sharma Traders' }, box));
  assert.ok(stopNeedsGeocode({ address: 'Sharma Traders', lat: 13.04 }, box)); // half a pair is no pair
  assert.ok(stopNeedsGeocode({ address: 'Sharma Traders', lon: 80.23 }, box));
  assert.ok(stopNeedsGeocode(null, box));
});

test('a picked suggestion inside the box is used as sent — no extra geocode call', () => {
  assert.ok(!stopNeedsGeocode({ address: 'The Work Villa — LGF', lat: 13.0418, lon: 80.2341 }, box));
});

test('coordinates outside the box are discarded, however local the address reads', () => {
  // The inflation this closes: a Chennai address carrying Delhi coordinates measured a
  // ~2,200 km leg and paid for it. The address is geocoded instead, and forwardGeocode
  // is bounded to the same box, so an out-of-area trip cannot be routed at all.
  assert.ok(stopNeedsGeocode({ address: 'Client site, Adyar', lat: 28.6139, lon: 77.209 }, box));
});

test('with no viewbox configured nothing is taken on trust', () => {
  assert.ok(stopNeedsGeocode({ address: 'The Work Villa — LGF', lat: 13.0418, lon: 80.2341 }, null));
});

// --- The whole path, with a stand-in for LocationIQ ---------------------------------
// Proves the rule where it actually matters: what resolveTripRoute measures, and so what
// the trip pays. fetch is replaced, so no request leaves the machine and no key is used.

// server.js builds its database client at import time, so give it a throwaway URL.
// Requiring it starts no listener — that's behind `require.main === module`.
process.env.TURSO_DATABASE_URL = process.env.TURSO_DATABASE_URL || 'file::memory:';
const { resolveTripRoute, CONFIG } = require('../server');

const PLACES = {
  'Client site, Adyar': { lat: 13.0012, lon: 80.2565, display_name: 'Client site, Adyar, Chennai' },
  'Office, Guindy': { lat: 13.0067, lon: 80.2206, display_name: 'Office, Guindy, Chennai' },
};

// Distances are made up but deterministic: 10 km per degree of separation, which is
// enough to tell a Chennai-sized leg from a Chennai-to-Delhi one.
function stubLocationIq() {
  const calls = { search: [], directions: [] };
  global.fetch = async (url) => {
    const u = new URL(url);
    if (u.pathname.endsWith('/search')) {
      const q = u.searchParams.get('q');
      calls.search.push(q);
      const hit = PLACES[q];
      return { json: async () => (hit ? [hit] : []) };
    }
    const coords = u.pathname.split('/').pop().split(';').map(s => s.split(',').map(Number));
    calls.directions.push(coords);
    const legs = coords.slice(1).map(([lon, lat], i) => {
      const [plon, plat] = coords[i];
      return { distance: (Math.abs(lat - plat) + Math.abs(lon - plon)) * 10 * 1000 };
    });
    return { json: async () => ({ code: 'Ok', routes: [{ distance: legs.reduce((s, l) => s + l.distance, 0), duration: 600, legs }] }) };
  };
  return calls;
}

test('a fabricated coordinate does not become a longer trip or a bigger amount', async () => {
  const realFetch = global.fetch;
  const calls = stubLocationIq();
  Object.assign(CONFIG, {
    LOCATIONIQ_API_KEY: 'test-key',
    LOCATIONIQ_BASE_URL: 'https://locationiq.test/v1',
    PLACES_VIEWBOX: CHENNAI,
    PLACES_COUNTRY: '',
    FIELD_TRIP_MAX_STOPS: 10,
    FIELD_TRIP_RATE_PER_KM: 8,
  });
  try {
    const route = await resolveTripRoute({
      round_trip: true,
      stops: [
        { address: 'Office, Guindy', lat: 13.0067, lon: 80.2206 },   // honest, inside the box
        { address: 'Client site, Adyar', lat: 28.6139, lon: 77.209 }, // Chennai address, Delhi coordinates
      ],
    });

    // The Delhi point is gone: the stop was re-read from its address.
    assert.deepEqual(route.stops.map(s => [s.lat, s.lon]), [
      [13.0067, 80.2206],
      [13.0012, 80.2565],
    ]);
    assert.ok(route.stops[1].geocoded, 'the fabricated stop should be marked as geocoded');
    assert.deepEqual(calls.search, ['Client site, Adyar'], 'only the untrusted stop costs a lookup');

    // Both legs stay Chennai-sized, and so does the money.
    assert.ok(route.distanceKm < 10, `expected a local distance, got ${route.distanceKm} km`);
    assert.equal(route.amount, Math.round(route.distanceKm * 8 * 100) / 100);

    // Before the fix this same payload measured the real road route to Delhi and back.
    const everyPoint = calls.directions[0];
    assert.ok(!everyPoint.some(([lon, lat]) => lat > 13.35 || lon < 79.95),
      'no point outside the configured area should ever reach the directions call');
  } finally {
    global.fetch = realFetch;
  }
});

test('an address that cannot be found inside the area is refused, not guessed', async () => {
  const realFetch = global.fetch;
  stubLocationIq();
  Object.assign(CONFIG, { PLACES_VIEWBOX: CHENNAI, FIELD_TRIP_MAX_STOPS: 10 });
  try {
    await assert.rejects(
      () => resolveTripRoute({ stops: [{ address: 'Office, Guindy' }, { address: 'Connaught Place, Delhi', lat: 28.6139, lon: 77.209 }] }),
      err => err.status === 422 && /Could not find/.test(err.message),
    );
  } finally {
    global.fetch = realFetch;
  }
});
